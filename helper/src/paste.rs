//! The session's pictures (protocol section 15, capability `paste`, from
//! 2.1.3-beta.21; ADR-032): `file.put` brings one picture from the app's
//! computer into a remote session's own folder, `sessions/<sid>/paste/`
//! beside the store, for the CLI's own clipboard paste there (the clipboard
//! stand-in serves it). The holder decides nothing about the picture and
//! never reads it (ADR-030 row 4): it checks the request's name, size and
//! hash, writes the bytes to a new partial file, checks the hash after the
//! last byte and renames the file into place. Nothing here opens a
//! connection or starts a process; `serve.rs` reads the frames and answers.
//!
//! The rules: a name `paste-<n>.png` or `paste-<n>.jpg` (`<n>` 1 to 9 digits
//! with no leading zero), never one already in the folder; 1 byte to 20 MiB,
//! and the folder within 100 MiB with it; the bytes in order on the paste
//! channel, each frame at most 64 KiB, none past `size`; at most
//! `CHUNK_WAIT` between two chunks. Every refusal of a `file.put` comes
//! before a byte is taken. A stored picture replaces the one before it, so
//! the folder holds the newest only. A partial file goes whenever its upload
//! ends any other way than stored (`Upload`'s drop: a closed connection, a
//! detach, a replacement, a timeout, a byte past `size`, a bad hash), and the
//! folder goes at the session's end (`remove_folder`). One upload at a time
//! per session (`Slot`).
//!
//! The folder is made when it is missing, with the session folder and
//! `sessions/` above it, each then a real folder (not a link) of this user's
//! own, open to nobody else on macOS and Linux, and 0700 when made here; the
//! partial file is made new (never through a link, never over a file) and is
//! 0600. On Windows a folder must not be a link or any other reparse point,
//! and its owner is not read: no Windows host takes a picture before
//! 2.1.3-beta.27 (ADR-032).
//!
//! SHA-256 is here (`Sha256`, FIPS 180-4) rather than in a crate: the helper
//! keeps under 25 crates (Cargo.toml).

use crate::frame::CODE_IO;
use crate::hello::valid_sha256;
use crate::json::Value;
use crate::request::{Refusal, CODE_BAD_FIELD, CODE_TOO_LARGE};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The capability that allows the session's pictures.
pub const CAP: &str = "paste";
/// A picture's bytes travel on this channel, while its `file.put` is open.
pub const CHANNEL: u32 = 2;
/// The most one picture may be: 20 MiB.
pub const MAX_PICTURE: u64 = 20 * 1024 * 1024;
/// The most the session's picture folder may hold with a new picture: 100 MiB.
pub const MAX_HELD: u64 = 100 * 1024 * 1024;
/// The most digits of the number in a picture's name.
pub const MAX_NUMBER_DIGITS: usize = 9;
/// The most time between two chunks of a picture in the build the installers
/// carry: then the upload ends with `timeout` and nothing is kept.
pub const CHUNK_WAIT_RELEASE: Duration = Duration::from_secs(30);
/// The same in a build with debug assertions, the one `cargo test` runs, so
/// a test can wait one out.
pub const CHUNK_WAIT_TEST: Duration = Duration::from_secs(3);
/// The most time between two chunks of a picture in this build.
pub const CHUNK_WAIT: Duration = if cfg!(debug_assertions) { CHUNK_WAIT_TEST } else { CHUNK_WAIT_RELEASE };
/// The holder answers `file.stored` within this time of the last chunk: the
/// hash is read as the bytes come, so only the rename is left.
pub const REPLY_WITHIN: Duration = Duration::from_secs(10);
/// The session folder's picture folder.
pub const FOLDER: &str = "paste";
/// A partial file's name, before the number of the picture it carries.
const PART_PREFIX: &str = ".part-";
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

fn refuse<T>(code: &'static str, re: Option<u64>, text: &str) -> Result<T, Refusal> {
    Err(Refusal { code, re, text: text.to_string() })
}

/// The number in a picture's name and its type, for `paste-<n>.png`
/// (`image/png`) or `paste-<n>.jpg` (`image/jpeg`), `<n>` 1 to 9 decimal
/// digits with no leading zero. None for any other name.
pub fn picture_name(name: &str) -> Option<(u32, &'static str)> {
    let rest = name.strip_prefix("paste-")?;
    let (digits, kind) = if let Some(d) = rest.strip_suffix(".png") {
        (d, "image/png")
    } else if let Some(d) = rest.strip_suffix(".jpg") {
        (d, "image/jpeg")
    } else {
        return None;
    };
    if digits.is_empty() || digits.len() > MAX_NUMBER_DIGITS || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u32>().ok().map(|n| (n, kind))
}

/// True for a partial file's name, `.part-<digits>`.
fn is_part_name(name: &str) -> bool {
    name.strip_prefix(PART_PREFIX).map_or(false, |d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

/// A `file.put`, checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Put {
    pub id: u64,
    pub name: String,
    /// The number in its name.
    pub number: u32,
    pub size: u64,
    pub sha256: String,
}

/// Check a `file.put` `{t, id, name, size, sha256}`: exactly those fields,
/// each once; `id` even, up to 2^53 - 1; `name` a picture's (`picture_name`);
/// `size` 1 to `MAX_PICTURE` (over it, `too-large`); `sha256` 64 lower-case
/// hex. Every other break is `bad-field`.
pub fn parse_put(v: &Value) -> Result<Put, Refusal> {
    let id = match crate::request::request_id(v) {
        Some(id) => id,
        None => return refuse(CODE_BAD_FIELD, None, "id must be an even whole number up to 2^53 - 1"),
    };
    let re = Some(id);
    if !crate::request::keys_fit(v, &["t", "id", "name", "size", "sha256"], &[]) {
        return refuse(CODE_BAD_FIELD, re, "a field is unknown, missing or given twice");
    }
    let name = match v.get("name").and_then(Value::as_str) {
        Some(n) => n,
        None => return refuse(CODE_BAD_FIELD, re, "name must be a string"),
    };
    let number = match picture_name(name) {
        Some((n, _)) => n,
        None => return refuse(CODE_BAD_FIELD, re, "name must be paste-<n>.png or paste-<n>.jpg, <n> 1 to 9 digits with no leading zero"),
    };
    let size = match v.get("size").and_then(Value::as_u64) {
        Some(0) | None => return refuse(CODE_BAD_FIELD, re, "size must be a whole number of bytes from 1"),
        Some(s) => s,
    };
    if size > MAX_PICTURE {
        return refuse(CODE_TOO_LARGE, re, "size is over 20 MiB (20971520 bytes), the most a picture may be");
    }
    let sha256 = match v.get("sha256").and_then(Value::as_str) {
        Some(h) if valid_sha256(h) => h.to_string(),
        _ => return refuse(CODE_BAD_FIELD, re, "sha256 must be 64 lower-case hex characters"),
    };
    Ok(Put { id, name: name.to_string(), number, size, sha256 })
}

/// `file.stored`: the reply to `file.put` `re`, the hash of what was stored.
/// It carries no path.
pub fn stored_message(re: u64, sha256: &str) -> Value {
    Value::obj(vec![("t", Value::str("file.stored")), ("re", Value::uint(re)), ("sha256", Value::str(sha256))])
}

/// The session's picture folder: `sessions/<sid>/paste/` beside the store
/// (`<store>/../sessions/<sid>`, protocol section 1). None for a store with
/// no folder above it.
pub fn folder_of(store: &Path, sid: &str) -> Option<PathBuf> {
    Some(store.parent()?.join("sessions").join(sid).join(FOLDER))
}

fn not_usable(what: &str, why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, format!("{what} {why}"))
}

/// True for a real folder: not a link, and on Windows no other reparse point
/// either (a junction).
fn is_real_folder(md: &fs::Metadata) -> bool {
    if md.file_type().is_symlink() || !md.is_dir() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

/// `folder` is a real folder of this user's own, open to nobody else (on
/// macOS and Linux; on Windows, not a reparse point).
fn check_private(folder: &Path, what: &str) -> io::Result<()> {
    let md = fs::symlink_metadata(folder)?;
    if !is_real_folder(&md) {
        return Err(not_usable(what, "is not a real folder"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if md.uid() != crate::store::euid() {
            return Err(not_usable(what, "belongs to another user"));
        }
        if md.mode() & 0o077 != 0 {
            return Err(not_usable(what, "is open to other users"));
        }
    }
    Ok(())
}

/// Make `folder` when it is missing (0700 on macOS and Linux, whatever the
/// umask), then check it as any other.
fn make_private(folder: &Path, what: &str) -> io::Result<()> {
    match fs::symlink_metadata(folder) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            #[cfg(unix)]
            let made = {
                use std::os::unix::fs::DirBuilderExt;
                fs::DirBuilder::new().mode(0o700).create(folder)
            };
            #[cfg(not(unix))]
            let made = fs::DirBuilder::new().create(folder);
            match made {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(folder, fs::Permissions::from_mode(0o700))?;
                    }
                }
                // Made meanwhile: checked below, as any other.
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
        Err(e) => return Err(e),
    }
    check_private(folder, what)
}

/// Make `dir`, the session's picture folder, and the session folder and
/// `sessions/` above it, each when it is missing; each must then be a real
/// folder of this user's own, open to nobody else.
pub fn prepare(dir: &Path) -> io::Result<()> {
    let session = dir.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the picture folder has no session folder above it"))?;
    let sessions = session.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the session folder has no sessions folder above it"))?;
    make_private(sessions, "the sessions folder")?;
    make_private(session, "the session's folder")?;
    make_private(dir, "the session's picture folder")
}

/// Every partial file an earlier upload left in `dir` goes (one upload at a
/// time per session, so none is in use); then what `dir` holds, in bytes,
/// each entry as it is (a link counts as itself, never what it names).
fn clear_parts_and_measure(dir: &Path) -> io::Result<u64> {
    let mut held: u64 = 0;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_str().map_or(false, is_part_name) {
            fs::remove_file(entry.path())?;
            continue;
        }
        held = held.saturating_add(entry.metadata()?.len());
    }
    Ok(held)
}

/// A new file at `path`, made here (never one there already, never through a
/// link), for this user alone (0600 on macOS and Linux, whatever the umask).
fn new_private_file(path: &Path) -> io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// Every picture in `dir` but `keep` goes: the session holds the newest only.
fn remove_pictures_but(dir: &Path, keep: &str) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_str().map_or(false, |n| n != keep && picture_name(n).is_some()) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// The session's picture folder goes at its end: each picture and partial
/// file in it (a link as itself, never what it names), then the folder, when
/// nothing else is left in it. One that is not a real folder is left alone.
pub fn remove_folder(dir: &Path) {
    match fs::symlink_metadata(dir) {
        Ok(md) if is_real_folder(&md) => {}
        _ => return,
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_str().map_or(false, |n| picture_name(n).is_some() || is_part_name(n)) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

/// The session's one upload at a time.
pub struct Slot(Arc<AtomicBool>);

impl Slot {
    pub fn new() -> Slot {
        Slot(Arc::new(AtomicBool::new(false)))
    }

    /// The slot, when no upload holds it; None while one does (`busy`).
    pub fn take(&self) -> Option<SlotGuard> {
        self.0.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| SlotGuard(Arc::clone(&self.0)))
    }
}

impl Default for Slot {
    fn default() -> Slot {
        Slot::new()
    }
}

/// An upload's hold on the session's slot, given back when it is dropped.
pub struct SlotGuard(Arc<AtomicBool>);

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// One picture on its way into the session's picture folder.
pub struct Upload {
    /// The `file.put`'s id: every answer to it carries it as `re`.
    pub id: u64,
    name: String,
    size: u64,
    want: String,
    got: u64,
    hash: Sha256,
    /// The partial file, until the last byte (closed before the rename).
    file: Option<fs::File>,
    dir: PathBuf,
    part: PathBuf,
    /// When the last chunk came (the `file.put`, before the first).
    last: Instant,
    /// Set once the picture is in place: its partial file is gone by then.
    stored: bool,
    _slot: SlotGuard,
}

impl Upload {
    /// Begin `put` into `dir`, holding the session's slot: the folder made
    /// and checked (`io`), a name already there refused (`bad-field`), every
    /// partial file an earlier upload left removed, the folder's 100 MiB
    /// with this picture kept (`too-large`), then a new partial file. Every
    /// refusal comes before a byte is taken.
    pub fn begin(put: Put, dir: &Path, slot: SlotGuard) -> Result<Upload, Refusal> {
        let re = Some(put.id);
        let io_refusal = |e: io::Error| Refusal { code: CODE_IO, re, text: format!("the session's picture folder is not usable: {e}") };
        prepare(dir).map_err(io_refusal)?;
        match fs::symlink_metadata(dir.join(&put.name)) {
            Ok(_) => return refuse(CODE_BAD_FIELD, re, "a picture of that name is in the session's folder already"),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_refusal(e)),
        }
        let held = clear_parts_and_measure(dir).map_err(io_refusal)?;
        if held.saturating_add(put.size) > MAX_HELD {
            return refuse(CODE_TOO_LARGE, re, "with what the session's picture folder holds, this picture is over 100 MiB (104857600 bytes)");
        }
        let part = dir.join(format!("{PART_PREFIX}{}", put.number));
        let file = new_private_file(&part).map_err(io_refusal)?;
        Ok(Upload {
            id: put.id,
            name: put.name,
            size: put.size,
            want: put.sha256,
            got: 0,
            hash: Sha256::new(),
            file: Some(file),
            dir: dir.to_path_buf(),
            part,
            last: Instant::now(),
            stored: false,
            _slot: slot,
        })
    }

    /// When the next chunk is due: after that the upload ends with `timeout`.
    pub fn due(&self) -> Instant {
        self.last + CHUNK_WAIT
    }

    /// One chunk of the picture, in order. True once all of its `size` bytes
    /// are in. A byte past `size` is `too-large`, and a chunk that cannot be
    /// written `io`: either way the upload is over, and its partial file goes
    /// with it when it is dropped.
    pub fn take(&mut self, bytes: &[u8]) -> Result<bool, Refusal> {
        let re = Some(self.id);
        if bytes.len() as u64 > self.size - self.got {
            return refuse(CODE_TOO_LARGE, re, "a byte past size: the picture was not kept");
        }
        self.last = Instant::now();
        if let Some(file) = self.file.as_mut() {
            if let Err(e) = file.write_all(bytes) {
                return Err(Refusal { code: CODE_IO, re, text: format!("the picture could not be written: {e}") });
            }
        }
        self.hash.update(bytes);
        self.got += bytes.len() as u64;
        Ok(self.got == self.size)
    }

    /// After the last byte: the SHA-256 checked. Equal, the partial file is
    /// renamed to the picture's name, every other picture in the folder goes,
    /// and the hash is the answer. Not equal, `bad-field`, and the partial
    /// file goes (the drop).
    pub fn finish(mut self) -> Result<String, Refusal> {
        let re = Some(self.id);
        // Closed before the rename: Windows renames no file held open.
        drop(self.file.take());
        let got = hex(&std::mem::take(&mut self.hash).finish());
        if got != self.want {
            return refuse(CODE_BAD_FIELD, re, "the SHA-256 of the bytes is not the one file.put named: the picture was not kept");
        }
        let at = self.dir.join(&self.name);
        if let Err(e) = fs::rename(&self.part, &at) {
            return Err(Refusal { code: CODE_IO, re, text: format!("the picture could not be put in place: {e}") });
        }
        self.stored = true;
        remove_pictures_but(&self.dir, &self.name);
        Ok(got)
    }
}

impl Drop for Upload {
    /// An upload that ends any other way than stored leaves nothing behind:
    /// its partial file goes.
    fn drop(&mut self) {
        drop(self.file.take());
        if !self.stored {
            let _ = fs::remove_file(&self.part);
        }
    }
}

/// Lower-case hex of `bytes`.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(char::from(DIGITS[usize::from(b >> 4)]));
        out.push(char::from(DIGITS[usize::from(b & 0x0f)]));
    }
    out
}

// ── SHA-256 (FIPS 180-4) ──────────────────────────────────────────────────

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H0: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/// One SHA-256, fed in pieces of any size.
pub struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    /// Bytes fed so far.
    len: u64,
}

impl Default for Sha256 {
    fn default() -> Sha256 {
        Sha256::new()
    }
}

impl Sha256 {
    pub fn new() -> Sha256 {
        Sha256 { state: H0, buf: [0; 64], buf_len: 0, len: 0 }
    }

    pub fn update(&mut self, data: &[u8]) {
        self.len = self.len.wrapping_add(data.len() as u64);
        let mut data = data;
        if self.buf_len > 0 {
            let take = (64 - self.buf_len).min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len < 64 {
                return;
            }
            let block = self.buf;
            compress(&mut self.state, &block);
            self.buf_len = 0;
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            compress(&mut self.state, &block);
            data = &data[64..];
        }
        self.buf[..data.len()].copy_from_slice(data);
        self.buf_len = data.len();
    }

    /// The 32 bytes of the digest.
    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.len.wrapping_mul(8);
        self.update(&[0x80]);
        while self.buf_len != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        let mut out = [0u8; 32];
        for (i, word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }
}

fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
    let mut w = [0u32; 64];
    for (i, word) in block.chunks_exact(4).enumerate() {
        w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
    }
    for i in 16..64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for i in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ (!e & g);
        let t1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let t2 = s0.wrapping_add(maj);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
        *s = s.wrapping_add(v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn digest(data: &[u8]) -> String {
        let mut s = Sha256::new();
        s.update(data);
        hex(&s.finish())
    }

    #[test]
    fn sha256_gives_the_standard_vectors_in_one_piece_and_in_many() {
        // FIPS 180-4's examples, the empty message, and a million a's.
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(digest(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(digest(b"abc"), abc);
        let two_blocks = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
        assert_eq!(digest(two_blocks), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
        let million = vec![b'a'; 1_000_000];
        assert_eq!(digest(&million), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
        // Fed in pieces that cut the 64-byte blocks anywhere, the same.
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 31 + 7) as u8).collect();
        let whole = digest(&data);
        for cut in [1usize, 55, 56, 63, 64, 65, 127, 999] {
            let mut s = Sha256::new();
            for piece in data.chunks(cut) {
                s.update(piece);
            }
            assert_eq!(hex(&s.finish()), whole, "pieces of {cut}");
        }
        assert_eq!(hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
    }

    #[test]
    fn a_picture_name_is_paste_a_number_and_png_or_jpg() {
        assert_eq!(picture_name("paste-1.png"), Some((1, "image/png")));
        assert_eq!(picture_name("paste-999999999.jpg"), Some((999_999_999, "image/jpeg")));
        assert_eq!(picture_name("paste-42.png"), Some((42, "image/png")));
        for bad in ["paste-0.png", "paste-01.png", "paste-1234567890.png", "paste-1.gif", "paste-1.PNG", "paste-.png", "../paste-1.png", "paste-1.png/", "x/paste-1.png", ".part-1", "paste-1.jpeg", "paste-1", "paste-1.png ", "paste--1.png", "paste-1.png.png", "Paste-1.png", "paste-+1.png", ""] {
            assert_eq!(picture_name(bad), None, "{bad:?}");
        }
        assert!(is_part_name(".part-12") && !is_part_name(".part-") && !is_part_name(".part-1x") && !is_part_name("paste-1.png"));
    }

    fn put_text(name: &str, size: &str, sha: &str) -> String {
        format!("{{\"t\":\"file.put\",\"id\":2,\"name\":\"{name}\",\"size\":{size},\"sha256\":\"{sha}\"}}")
    }

    const SHA: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

    fn parsed(text: &str) -> Result<Put, Refusal> {
        parse_put(&json::parse(text.as_bytes()).unwrap())
    }

    #[test]
    fn a_file_put_reads_strictly() {
        let put = parsed(&put_text("paste-3.jpg", "20971520", SHA)).unwrap();
        assert_eq!(put, Put { id: 2, name: "paste-3.jpg".to_string(), number: 3, size: MAX_PICTURE, sha256: SHA.to_string() });
        let code = |text: &str| parsed(text).unwrap_err().code;
        assert_eq!(code(&put_text("paste-3.png", "20971521", SHA)), CODE_TOO_LARGE);
        assert_eq!(code(&put_text("paste-3.png", "0", SHA)), CODE_BAD_FIELD);
        assert_eq!(code(&put_text("paste-3.png", "1.5", SHA)), CODE_BAD_FIELD);
        assert_eq!(code(&put_text("paste-03.png", "10", SHA)), CODE_BAD_FIELD);
        assert_eq!(code(&put_text("paste-3.png", "10", &SHA.to_uppercase())), CODE_BAD_FIELD);
        assert_eq!(code(&put_text("paste-3.png", "10", &SHA[1..])), CODE_BAD_FIELD);
        assert_eq!(code(&put_text("paste-3.png", "10", SHA).replace("\"id\":2", "\"id\":3")), CODE_BAD_FIELD);
        assert_eq!(code(&put_text("paste-3.png", "10", SHA).replace('}', ",\"path\":\"/tmp\"}")), CODE_BAD_FIELD);
        // The refusal of a request with an id names it.
        assert_eq!(parsed(&put_text("x.png", "10", SHA)).unwrap_err().re, Some(2));
        assert_eq!(stored_message(4, SHA).to_json(), format!("{{\"t\":\"file.stored\",\"re\":4,\"sha256\":\"{SHA}\"}}"));
    }

    /// A folder of this test's own, its store's parent: `sessions/<sid>/paste`
    /// lies under it. Removed when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!("aicc-paste-unit-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            }
            Scratch(dir)
        }

        fn paste(&self) -> PathBuf {
            folder_of(&self.0.join("store"), "paste-unit-01").unwrap()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn put_of(name: &str, bytes: &[u8]) -> Put {
        let (number, _) = picture_name(name).unwrap();
        Put { id: 2, name: name.to_string(), number, size: bytes.len() as u64, sha256: digest(bytes) }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(dir).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        out.sort();
        out
    }

    #[test]
    fn a_picture_is_stored_whole_in_its_own_folder_and_replaces_the_one_before() {
        let s = Scratch::new("store");
        let dir = s.paste();
        let slot = Slot::new();
        let bytes: Vec<u8> = (0..150_000u32).map(|i| (i * 13) as u8).collect();
        let mut up = Upload::begin(put_of("paste-1.png", &bytes), &dir, slot.take().unwrap()).unwrap();
        assert_eq!(names(&dir), vec![".part-1"]);
        assert!(slot.take().is_none(), "a second upload while one is open");
        let mut whole = false;
        for chunk in bytes.chunks(65536) {
            whole = up.take(chunk).unwrap();
        }
        assert!(whole);
        assert_eq!(up.finish().unwrap(), digest(&bytes));
        assert_eq!(names(&dir), vec!["paste-1.png"]);
        assert_eq!(fs::read(dir.join("paste-1.png")).unwrap(), bytes);
        assert!(slot.take().is_some(), "the slot is given back");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&dir.join("paste-1.png")), 0o600);
            for folder in [dir.clone(), dir.parent().unwrap().to_path_buf(), dir.parent().unwrap().parent().unwrap().to_path_buf()] {
                assert_eq!(mode(&folder), 0o700, "{}", folder.display());
            }
        }
        // The next picture replaces it: the folder holds the newest only.
        let jpg = b"not really a jpg".to_vec();
        let mut up = Upload::begin(put_of("paste-2.jpg", &jpg), &dir, slot.take().unwrap()).unwrap();
        assert!(up.take(&jpg).unwrap());
        up.finish().unwrap();
        assert_eq!(names(&dir), vec!["paste-2.jpg"]);
        // At the session's end the folder goes.
        remove_folder(&dir);
        assert!(!dir.exists());
    }

    #[test]
    fn a_bad_hash_a_byte_past_size_and_an_upload_dropped_half_way_leave_nothing() {
        let s = Scratch::new("nothing");
        let dir = s.paste();
        let slot = Slot::new();
        let bytes = vec![7u8; 1000];
        // A bad hash: bad-field after the last byte, and no file.
        let mut put = put_of("paste-1.png", &bytes);
        put.sha256 = digest(b"something else");
        let mut up = Upload::begin(put, &dir, slot.take().unwrap()).unwrap();
        assert!(up.take(&bytes).unwrap());
        assert_eq!(up.finish().unwrap_err().code, CODE_BAD_FIELD);
        assert_eq!(names(&dir), Vec::<String>::new());
        // A byte past size: too-large, and the drop removes the partial file.
        let mut up = Upload::begin(put_of("paste-2.png", &bytes), &dir, slot.take().unwrap()).unwrap();
        assert!(!up.take(&bytes[..600]).unwrap());
        assert_eq!(up.take(&bytes[..401]).unwrap_err().code, CODE_TOO_LARGE);
        drop(up);
        assert_eq!(names(&dir), Vec::<String>::new());
        // Half way, then dropped (a closed connection, a detach, a timeout).
        let mut up = Upload::begin(put_of("paste-3.png", &bytes), &dir, slot.take().unwrap()).unwrap();
        assert!(!up.take(&bytes[..10]).unwrap());
        assert_eq!(names(&dir), vec![".part-3"]);
        drop(up);
        assert_eq!(names(&dir), Vec::<String>::new());
        assert!(slot.take().is_some());
    }

    #[test]
    fn a_name_there_already_and_the_folders_100_mib_are_refused_before_a_byte_and_a_left_partial_file_goes() {
        let s = Scratch::new("caps");
        let dir = s.paste();
        let slot = Slot::new();
        prepare(&dir).unwrap();
        fs::write(dir.join("paste-5.png"), b"there").unwrap();
        let refusal = Upload::begin(put_of("paste-5.png", b"x"), &dir, slot.take().unwrap()).err().unwrap();
        assert_eq!((refusal.code, refusal.re), (CODE_BAD_FIELD, Some(2)));
        // 100 MiB with what is there: one byte more is too large. A sparse
        // file stands in for what the folder holds.
        let big = fs::File::create(dir.join("paste-6.png")).unwrap();
        big.set_len(MAX_HELD - 5 - 10).unwrap();
        drop(big);
        // A partial file a stopped holder left is removed first, and not counted.
        fs::write(dir.join(".part-9"), vec![0u8; 4096]).unwrap();
        let over = Put { size: 11, ..put_of("paste-7.png", b"x") };
        assert_eq!(Upload::begin(over, &dir, slot.take().unwrap()).err().unwrap().code, CODE_TOO_LARGE);
        assert!(!dir.join(".part-9").exists());
        let fits = Put { size: 10, ..put_of("paste-7.png", b"x") };
        let up = Upload::begin(fits, &dir, slot.take().unwrap()).unwrap();
        assert!(dir.join(".part-7").exists());
        drop(up);
        // The folder goes at the end with every picture in it, and nothing else.
        remove_folder(&dir);
        assert!(!dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_is_a_link_or_open_to_others_is_refused_io() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("links");
        let dir = s.paste();
        let session = dir.parent().unwrap().to_path_buf();
        fs::create_dir_all(&session).unwrap();
        fs::set_permissions(dir.parent().unwrap().parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&session, fs::Permissions::from_mode(0o700)).unwrap();
        // paste/ a link to another folder: io, and nothing written there.
        let elsewhere = s.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o700)).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &dir).unwrap();
        let slot = Slot::new();
        assert_eq!(Upload::begin(put_of("paste-1.png", b"x"), &dir, slot.take().unwrap()).err().unwrap().code, CODE_IO);
        assert_eq!(names(&elsewhere), Vec::<String>::new());
        // remove_folder leaves a link alone, and what it names.
        fs::write(elsewhere.join("paste-1.png"), b"x").unwrap();
        remove_folder(&dir);
        assert!(elsewhere.join("paste-1.png").exists());
        fs::remove_file(&dir).unwrap();
        // The session folder open to others: io.
        fs::set_permissions(&session, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(Upload::begin(put_of("paste-1.png", b"x"), &dir, slot.take().unwrap()).err().unwrap().code, CODE_IO);
        assert!(!dir.exists());
    }
}
