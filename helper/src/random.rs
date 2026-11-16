//! Random bytes from the operating system, written as lower-case hex: the
//! holder's hello nonce and the random part of its endpoint name (protocol
//! section 15). `/dev/urandom` on Unix, the system RNG on Windows.
#![allow(unsafe_code)]

use std::io;

/// `bytes` random bytes as `2 * bytes` lower-case hex characters.
pub fn hex(bytes: usize) -> io::Result<String> {
    let mut buf = vec![0u8; bytes];
    fill(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(unix)]
fn fill(buf: &mut [u8]) -> io::Result<()> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")?.read_exact(buf)
}

#[cfg(windows)]
fn fill(buf: &mut [u8]) -> io::Result<()> {
    use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    let len = u32::try_from(buf.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "too many random bytes asked for"))?;
    // A null algorithm handle with this flag asks for the system's preferred RNG.
    let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), buf.as_mut_ptr(), len, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status != 0 {
        return Err(io::Error::new(io::ErrorKind::Other, format!("BCryptGenRandom failed: 0x{:08x}", status as u32)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_is_lower_case_of_the_asked_length_and_differs_each_time() {
        let a = hex(16).unwrap();
        let b = hex(16).unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')));
        assert_ne!(a, b, "two draws of 128 bits came out the same");
        assert_eq!(hex(0).unwrap(), "");
    }
}
