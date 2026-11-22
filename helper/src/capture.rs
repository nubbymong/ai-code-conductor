//! `aicc-helper capture --out <folder>`: one picture of each display, for
//! Snap (ADR-030 D3 and D4, protocol change 2; protocol section 15,
//! "Capturing the displays"). Windows only for now: on macOS and Linux the
//! mode exits 4, "not supported". The app does not run it yet; probe P21
//! measures it on Windows before Snap is built on it.
//!
//! ```text
//! aicc-helper capture --out <folder>
//! ```
//!
//! `<folder>` is an absolute path to a folder that is already there. The mode
//! makes itself aware of each display's own scale (per-monitor DPI awareness,
//! version 2), so every size it reads and writes is in physical pixels. It
//! checks first that this process can see the screen: its window station is
//! the one shown on a display (a service or an SSH session has none), and the
//! desktop shown now is this process's own (not the sign-in screen, a locked
//! screen or an elevation prompt). Then it lists the displays (the primary one
//! first, then from the top left), grabs each whole display from the screen
//! and writes it as `display-<n>.bmp` (a 32-bit BMP, rows from the bottom,
//! as Windows hands them over; every fourth byte 255). Whole displays only:
//! no window and no part of one (D4: the rectangle is cut by the overlay).
//! It makes each file new and never writes over one that is there; a run that
//! fails removes every file it wrote, so it leaves nothing or everything.
//! Then it prints one line,
//! `{"displays":[{"file":"display-1.bmp","left":0,"top":0,"width":1920,"height":1080,"dpi":144,"scale":150,"primary":true}]}`,
//! the bounds in physical pixels on the virtual screen, `dpi` the display's
//! effective DPI and `scale` that as a percentage of 96, rounded.
//!
//! Exit status: 0 written; 1 a grab or a write failed, or the folder cannot be
//! used (a message on stderr, nothing left); 2 a command line it does not take;
//! 3 no desktop to capture (this process cannot see the screen, or Windows
//! lists no display); 4 not supported on this system. No PowerShell, no WMI
//! and nothing on the screen: no window is made.
//!
//! The window-manager DLLs this mode calls (user32, gdi32, shcore) are
//! delay-loaded (helper/.cargo/config.toml): they load only when the mode
//! runs, and no other mode loads them. scripts/check-pe-imports.mjs fails a
//! build that imports one at load time.
#![allow(unsafe_code)]

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "usage: aicc-helper capture --out <folder>";

/// A grab or a write failed, or the folder cannot be used.
pub const EXIT_FAILED: u8 = 1;
/// A command line the mode does not take.
pub const EXIT_USAGE: u8 = 2;
/// This process cannot see the screen, or Windows lists no display.
pub const EXIT_NO_DESKTOP: u8 = 3;
/// Not supported on this system.
pub const EXIT_NOT_SUPPORTED: u8 = 4;

/// The most displays one run captures; more is a failed run, not a cut one.
pub const MAX_DISPLAYS: usize = 16;
/// The longest side of a display the mode captures, in pixels.
pub const MAX_SIDE: u32 = 16_384;
/// The bytes of a BMP file before its pixels: the file header and a
/// BITMAPINFOHEADER.
pub const BMP_HEADER_BYTES: usize = 54;

/// What the command line asks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureRequest {
    pub out: PathBuf,
}

/// One display, as captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Display {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub primary: bool,
}

/// Why a run wrote nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// No desktop to capture (exit 3).
    NoDesktop(String),
    /// A grab, a write or the folder failed (exit 1).
    Failed(String),
}

/// Read a `capture` command line (what follows `capture`): `--out` once,
/// with an absolute path, and nothing else.
pub fn parse(args: &[String]) -> Result<CaptureRequest, String> {
    let mut out: Option<PathBuf> = None;
    let mut i = 0;
    while let Some(option) = args.get(i) {
        match option.as_str() {
            "--out" => {
                let value = args.get(i + 1).ok_or_else(|| "--out needs a value".to_string())?;
                if out.is_some() {
                    return Err("--out is given twice".to_string());
                }
                let path = PathBuf::from(value);
                if value.is_empty() || !path.is_absolute() {
                    return Err("--out must be an absolute path to a folder".to_string());
                }
                out = Some(path);
                i += 2;
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    match out {
        Some(out) => Ok(CaptureRequest { out }),
        None => Err("capture needs --out".to_string()),
    }
}

/// The file the `index`th display (from 0) is written to.
pub fn file_name(index: usize) -> String {
    format!("display-{}.bmp", index + 1)
}

/// A display's scale as a percentage of 96 DPI, rounded to the nearest.
pub fn scale_percent(dpi: u32) -> u32 {
    (dpi.saturating_mul(100).saturating_add(48)) / 96
}

/// The one line the mode prints, for the displays in the order written.
pub fn answer_line(displays: &[Display]) -> String {
    let rows: Vec<String> = displays
        .iter()
        .enumerate()
        .map(|(i, d)| {
            format!(
                "{{\"file\":\"{}\",\"left\":{},\"top\":{},\"width\":{},\"height\":{},\"dpi\":{},\"scale\":{},\"primary\":{}}}",
                file_name(i),
                d.left,
                d.top,
                d.width,
                d.height,
                d.dpi,
                scale_percent(d.dpi),
                d.primary
            )
        })
        .collect();
    format!("{{\"displays\":[{}]}}", rows.join(","))
}

/// Whether a display of `width` by `height` pixels is one the mode captures.
pub fn size_ok(width: u32, height: u32) -> bool {
    (1..=MAX_SIDE).contains(&width) && (1..=MAX_SIDE).contains(&height)
}

/// The bytes of a picture's pixels: 4 a pixel.
pub fn pixel_bytes(width: u32, height: u32) -> usize {
    width as usize * height as usize * 4
}

/// The first 54 bytes of a 32-bit BMP of `width` by `height` pixels whose
/// rows run from the bottom (a positive height), with its resolution in
/// pixels per metre from `dpi`.
pub fn bmp_header(width: u32, height: u32, dpi: u32) -> Result<[u8; BMP_HEADER_BYTES], String> {
    if !size_ok(width, height) {
        return Err(format!("a display of {width} by {height} pixels is not one this mode captures (1 to {MAX_SIDE} on each side)"));
    }
    // At most 16384 * 16384 * 4 + 54 bytes, which fits a u32.
    let image = pixel_bytes(width, height) as u32;
    let file = image + BMP_HEADER_BYTES as u32;
    // Pixels per metre: dpi / 0.0254, rounded.
    let ppm = ((u64::from(dpi) * 10_000 + 127) / 254).min(i32::MAX as u64) as i32;
    let mut h = [0u8; BMP_HEADER_BYTES];
    h[0..2].copy_from_slice(b"BM");
    h[2..6].copy_from_slice(&file.to_le_bytes());
    // Bytes 6 to 9 are reserved: 0.
    h[10..14].copy_from_slice(&(BMP_HEADER_BYTES as u32).to_le_bytes());
    h[14..18].copy_from_slice(&40u32.to_le_bytes());
    h[18..22].copy_from_slice(&(width as i32).to_le_bytes());
    h[22..26].copy_from_slice(&(height as i32).to_le_bytes());
    h[26..28].copy_from_slice(&1u16.to_le_bytes());
    h[28..30].copy_from_slice(&32u16.to_le_bytes());
    // Bytes 30 to 33: no compression (BI_RGB, 0).
    h[34..38].copy_from_slice(&image.to_le_bytes());
    h[38..42].copy_from_slice(&ppm.to_le_bytes());
    h[42..46].copy_from_slice(&ppm.to_le_bytes());
    // Bytes 46 to 53: no colour table.
    Ok(h)
}

/// Write one picture to `path` as a new file: its header, then `pixels`
/// (4 bytes a pixel, rows from the bottom). A file already at `path` is left
/// alone and the write fails; a write that fails after the file was made
/// removes it.
pub fn write_bmp(path: &Path, width: u32, height: u32, dpi: u32, pixels: &[u8]) -> io::Result<()> {
    let header = bmp_header(width, height, dpi).map_err(|why| io::Error::new(io::ErrorKind::InvalidInput, why))?;
    if pixels.len() != pixel_bytes(width, height) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} bytes of pixels for a picture of {width} by {height}, which needs {}", pixels.len(), pixel_bytes(width, height)),
        ));
    }
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let written = file.write_all(&header).and_then(|()| file.write_all(pixels)).and_then(|()| file.flush());
    if let Err(e) = written {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(e);
    }
    Ok(())
}

/// Set every fourth byte (the one a 32-bit BMP leaves unused) to 255, so a
/// reader that takes it for opacity still shows the picture.
pub fn make_opaque(pixels: &mut [u8]) {
    for px in pixels.chunks_exact_mut(4) {
        px[3] = 255;
    }
}

/// The displays in the order they are written: the primary one first, then
/// from the top, then from the left.
pub fn in_order(displays: &mut [Display]) {
    displays.sort_by_key(|d| (!d.primary, d.top, d.left));
}

/// Grab each of `displays` with `grab` and write it into `out` as
/// `display-<n>.bmp`, in order. Nothing or everything: when a grab or a write
/// fails, every file this call wrote is removed and the failure answered. A
/// file that was there before is never written over (`write_bmp`), so it is
/// never one this call removes. The Windows run calls it with the screen's
/// grab; the tests call it on every system with their own.
pub fn write_all_or_none(out: &Path, displays: &[Display], mut grab: impl FnMut(&Display) -> Result<Vec<u8>, Failure>) -> Result<(), Failure> {
    let mut written: Vec<PathBuf> = Vec::new();
    let result: Result<(), Failure> = (|| {
        for (i, d) in displays.iter().enumerate() {
            let pixels = grab(d)?;
            let path = out.join(file_name(i));
            write_bmp(&path, d.width, d.height, d.dpi, &pixels).map_err(|e| Failure::Failed(format!("could not write {}: {e}", path.display())))?;
            written.push(path);
        }
        Ok(())
    })();
    if let Err(e) = result {
        // Nothing or everything: remove what this run wrote.
        for path in &written {
            let _ = std::fs::remove_file(path);
        }
        return Err(e);
    }
    Ok(())
}

/// `aicc-helper capture ...`: the command, with its output and exit status.
pub fn command(args: &[String]) -> ExitCode {
    if cfg!(not(windows)) {
        eprintln!("aicc-helper: capture is not supported on this system (Windows only for now)");
        return ExitCode::from(EXIT_NOT_SUPPORTED);
    }
    let req = match parse(args) {
        Ok(r) => r,
        Err(why) => {
            eprintln!("aicc-helper: {why}");
            eprintln!("{USAGE}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    if !req.out.is_dir() {
        eprintln!("aicc-helper: capture: {} is not a folder that is there", req.out.display());
        return ExitCode::from(EXIT_FAILED);
    }
    match run(&req) {
        Ok(displays) => {
            println!("{}", answer_line(&displays));
            ExitCode::SUCCESS
        }
        Err(Failure::NoDesktop(why)) => {
            eprintln!("aicc-helper: capture: no desktop to capture: {why}");
            ExitCode::from(EXIT_NO_DESKTOP)
        }
        Err(Failure::Failed(why)) => {
            eprintln!("aicc-helper: capture failed: {why}");
            ExitCode::from(EXIT_FAILED)
        }
    }
}

/// Capture every display into `req.out` (see the module comment). Windows only.
#[cfg(not(windows))]
pub fn run(_req: &CaptureRequest) -> Result<Vec<Display>, Failure> {
    Err(Failure::Failed("capture is not supported on this system".to_string()))
}

#[cfg(windows)]
pub use self::win::run;

#[cfg(windows)]
mod win {
    use super::{in_order, make_opaque, pixel_bytes, size_ok, write_all_or_none, CaptureRequest, Display, Failure, MAX_DISPLAYS};
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{BOOL, HANDLE, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, HMONITOR, MONITORINFO, SRCCOPY,
    };
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, GetProcessWindowStation, GetThreadDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_FLAGS, UOI_NAME, USEROBJECTFLAGS};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, SetProcessDpiAwarenessContext, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, MDT_EFFECTIVE_DPI};

    /// `WSF_VISIBLE`: the window station is shown on a display.
    const WSF_VISIBLE: u32 = 0x0001;
    /// `MONITORINFOF_PRIMARY`: the primary display.
    const MONITORINFOF_PRIMARY: u32 = 0x0001;

    fn last_error(what: &str) -> String {
        format!("{what}: {}", std::io::Error::last_os_error())
    }

    /// Every size from here on is in physical pixels.
    fn per_display_scale() -> Result<(), Failure> {
        if unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } != 0 {
            return Ok(());
        }
        // The process's awareness was set already (a manifest, or a host
        // that set it): the thread's own is enough, as one thread does all.
        let process_error = last_error("SetProcessDpiAwarenessContext");
        if !unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }.is_null() {
            return Ok(());
        }
        Err(Failure::Failed(format!("cannot read each display at its own scale ({process_error}; {})", last_error("SetThreadDpiAwarenessContext"))))
    }

    /// The name of a window station or desktop.
    fn object_name(object: HANDLE) -> Result<String, Failure> {
        let mut buf = [0u16; 256];
        let mut need: u32 = 0;
        let ok = unsafe { GetUserObjectInformationW(object, UOI_NAME, buf.as_mut_ptr() as *mut c_void, (buf.len() * 2) as u32, &mut need) };
        if ok == 0 {
            return Err(Failure::Failed(last_error("GetUserObjectInformationW (name)")));
        }
        let n = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        Ok(String::from_utf16_lossy(&buf[..n]))
    }

    /// Whether this process can see the screen: its window station is the
    /// one shown on a display, and the desktop shown now is its own.
    fn can_see_the_screen() -> Result<(), Failure> {
        let station = unsafe { GetProcessWindowStation() };
        if station.is_null() {
            return Err(Failure::Failed(last_error("GetProcessWindowStation")));
        }
        let mut flags: USEROBJECTFLAGS = unsafe { std::mem::zeroed() };
        let mut need: u32 = 0;
        let ok = unsafe {
            GetUserObjectInformationW(station as HANDLE, UOI_FLAGS, &mut flags as *mut USEROBJECTFLAGS as *mut c_void, std::mem::size_of::<USEROBJECTFLAGS>() as u32, &mut need)
        };
        if ok == 0 {
            return Err(Failure::Failed(last_error("GetUserObjectInformationW (flags)")));
        }
        if flags.dwFlags & WSF_VISIBLE == 0 {
            let name = object_name(station as HANDLE).unwrap_or_default();
            return Err(Failure::NoDesktop(format!("this process runs on a window station no display shows ({name}): a service or an SSH session")));
        }
        let shown = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
        if shown.is_null() {
            return Err(Failure::NoDesktop(format!(
                "the desktop on the screen is not one this process can read (the sign-in screen, a locked screen or an elevation prompt): {}",
                std::io::Error::last_os_error()
            )));
        }
        let shown_name = object_name(shown as HANDLE);
        unsafe { CloseDesktop(shown) };
        let own = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
        if own.is_null() {
            return Err(Failure::Failed(last_error("GetThreadDesktop")));
        }
        let (shown_name, own_name) = (shown_name?, object_name(own as HANDLE)?);
        if !shown_name.eq_ignore_ascii_case(&own_name) {
            return Err(Failure::NoDesktop(format!("the screen shows the desktop {shown_name}, not this process's ({own_name})")));
        }
        Ok(())
    }

    unsafe extern "system" fn each_monitor(monitor: HMONITOR, _dc: HDC, _rect: *mut RECT, data: LPARAM) -> BOOL {
        let list = &mut *(data as *mut Vec<HMONITOR>);
        list.push(monitor);
        // Stop once past the bound: the caller fails the run.
        BOOL::from(list.len() <= MAX_DISPLAYS)
    }

    /// Every display Windows lists now, in physical pixels.
    fn displays() -> Result<Vec<Display>, Failure> {
        let mut monitors: Vec<HMONITOR> = Vec::new();
        let ok = unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(each_monitor), &mut monitors as *mut Vec<HMONITOR> as LPARAM) };
        if monitors.len() > MAX_DISPLAYS {
            return Err(Failure::Failed(format!("Windows lists more than {MAX_DISPLAYS} displays")));
        }
        if ok == 0 {
            return Err(Failure::Failed(last_error("EnumDisplayMonitors")));
        }
        if monitors.is_empty() {
            return Err(Failure::NoDesktop("Windows lists no display".to_string()));
        }
        let mut out = Vec::with_capacity(monitors.len());
        for monitor in monitors {
            let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
                return Err(Failure::Failed(last_error("GetMonitorInfoW")));
            }
            let (mut dpi_x, mut dpi_y) = (0u32, 0u32);
            let hr = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
            if hr < 0 || dpi_x == 0 {
                return Err(Failure::Failed(format!("GetDpiForMonitor: HRESULT 0x{:08X}", hr as u32)));
            }
            let r = info.rcMonitor;
            let (width, height) = ((r.right as i64 - r.left as i64), (r.bottom as i64 - r.top as i64));
            let (width, height) = (u32::try_from(width).unwrap_or(0), u32::try_from(height).unwrap_or(0));
            if !size_ok(width, height) {
                return Err(Failure::Failed(format!("a display of {width} by {height} pixels is not one this mode captures")));
            }
            out.push(Display { left: r.left, top: r.top, width, height, dpi: dpi_x, primary: info.dwFlags & MONITORINFOF_PRIMARY != 0 });
        }
        in_order(&mut out);
        Ok(out)
    }

    /// A device context of the whole screen, released when dropped.
    struct ScreenDc(HDC);
    impl Drop for ScreenDc {
        fn drop(&mut self) {
            unsafe { ReleaseDC(std::ptr::null_mut(), self.0) };
        }
    }

    /// A memory device context, deleted when dropped.
    struct MemoryDc(HDC);
    impl Drop for MemoryDc {
        fn drop(&mut self) {
            unsafe { DeleteDC(self.0) };
        }
    }

    /// A bitmap, deleted when dropped (never while it is selected).
    struct Bitmap(HBITMAP);
    impl Drop for Bitmap {
        fn drop(&mut self) {
            unsafe { DeleteObject(self.0) };
        }
    }

    /// One display's pixels from the screen: 4 bytes a pixel, rows from the bottom.
    fn grab(screen: &ScreenDc, memory: &MemoryDc, d: &Display) -> Result<Vec<u8>, Failure> {
        let (w, h) = (d.width as i32, d.height as i32);
        let bitmap = unsafe { CreateCompatibleBitmap(screen.0, w, h) };
        if bitmap.is_null() {
            return Err(Failure::Failed(last_error("CreateCompatibleBitmap")));
        }
        let bitmap = Bitmap(bitmap);
        let before = unsafe { SelectObject(memory.0, bitmap.0) };
        if before.is_null() {
            return Err(Failure::Failed(last_error("SelectObject")));
        }
        let copied = unsafe { BitBlt(memory.0, 0, 0, w, h, screen.0, d.left, d.top, SRCCOPY | CAPTUREBLT) };
        let copy_error = if copied == 0 { Some(last_error("BitBlt")) } else { None };
        // GetDIBits needs the bitmap out of every device context.
        unsafe { SelectObject(memory.0, before) };
        if let Some(why) = copy_error {
            return Err(Failure::Failed(why));
        }
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut pixels = vec![0u8; pixel_bytes(d.width, d.height)];
        let rows = unsafe { GetDIBits(memory.0, bitmap.0, 0, d.height, pixels.as_mut_ptr() as *mut c_void, &mut info, DIB_RGB_COLORS) };
        if rows != h {
            return Err(Failure::Failed(format!("GetDIBits gave {rows} of {h} rows: {}", std::io::Error::last_os_error())));
        }
        make_opaque(&mut pixels);
        Ok(pixels)
    }

    /// See the module comment.
    pub fn run(req: &CaptureRequest) -> Result<Vec<Display>, Failure> {
        per_display_scale()?;
        can_see_the_screen()?;
        let list = displays()?;
        let screen = unsafe { GetDC(std::ptr::null_mut()) };
        if screen.is_null() {
            return Err(Failure::Failed(last_error("GetDC")));
        }
        let screen = ScreenDc(screen);
        let memory = unsafe { CreateCompatibleDC(screen.0) };
        if memory.is_null() {
            return Err(Failure::Failed(last_error("CreateCompatibleDC")));
        }
        let memory = MemoryDc(memory);
        write_all_or_none(&req.out, &list, |d| grab(&screen, &memory, d))?;
        Ok(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    /// An absolute folder on this system, for the argument rules.
    fn absolute() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    #[test]
    fn it_takes_out_once_as_an_absolute_path_and_nothing_else() {
        let abs = absolute();
        let a = abs.as_str();
        assert_eq!(parse(&args(&["--out", a])), Ok(CaptureRequest { out: PathBuf::from(a) }));
        let none: Vec<&str> = Vec::new();
        for bad in [
            none,
            vec!["--out"],
            vec!["--out", ""],
            vec!["--out", "relative/folder"],
            vec!["--out", a, "--out", a],
            vec!["--out", a, "--window", "1"],
            vec!["--rect", "0,0,1,1"],
            vec![a],
        ] {
            assert!(parse(&args(&bad)).is_err(), "{bad:?} was taken");
        }
    }

    #[test]
    fn each_display_has_its_own_numbered_file() {
        assert_eq!(file_name(0), "display-1.bmp");
        assert_eq!(file_name(15), "display-16.bmp");
    }

    #[test]
    fn the_scale_is_the_dpi_against_96_rounded() {
        assert_eq!(scale_percent(96), 100);
        assert_eq!(scale_percent(120), 125);
        assert_eq!(scale_percent(144), 150);
        assert_eq!(scale_percent(168), 175);
        assert_eq!(scale_percent(192), 200);
        assert_eq!(scale_percent(97), 101);
    }

    #[test]
    fn the_answer_is_one_line_with_each_display_in_the_order_written() {
        let line = answer_line(&[
            Display { left: 0, top: 0, width: 2560, height: 1440, dpi: 144, primary: true },
            Display { left: -1920, top: 120, width: 1920, height: 1080, dpi: 96, primary: false },
        ]);
        assert_eq!(
            line,
            r#"{"displays":[{"file":"display-1.bmp","left":0,"top":0,"width":2560,"height":1440,"dpi":144,"scale":150,"primary":true},{"file":"display-2.bmp","left":-1920,"top":120,"width":1920,"height":1080,"dpi":96,"scale":100,"primary":false}]}"#
        );
        assert!(!line.contains('\n'));
        let parsed = crate::json::parse(line.as_bytes()).expect("the line is JSON");
        let rows = parsed.get("displays").and_then(|v| v.as_array()).expect("displays");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].get("left").and_then(|v| v.as_i64()), Some(-1920));
        assert_eq!(answer_line(&[]), r#"{"displays":[]}"#);
    }

    #[test]
    fn the_primary_display_comes_first_then_from_the_top_left() {
        let d = |left: i32, top: i32, primary: bool| Display { left, top, width: 10, height: 10, dpi: 96, primary };
        let mut list = vec![d(1920, 0, false), d(-1920, 0, false), d(0, 0, true), d(0, -1080, false)];
        in_order(&mut list);
        assert_eq!(list, vec![d(0, 0, true), d(0, -1080, false), d(-1920, 0, false), d(1920, 0, false)]);
    }

    #[test]
    fn the_header_is_a_32_bit_bmp_from_the_bottom_up() {
        let h = bmp_header(3, 2, 96).expect("a header");
        let u32_at = |i: usize| u32::from_le_bytes([h[i], h[i + 1], h[i + 2], h[i + 3]]);
        let i32_at = |i: usize| i32::from_le_bytes([h[i], h[i + 1], h[i + 2], h[i + 3]]);
        assert_eq!(&h[0..2], b"BM");
        assert_eq!(u32_at(2), 54 + 3 * 2 * 4);
        assert_eq!(u32_at(6), 0);
        assert_eq!(u32_at(10), 54);
        assert_eq!(u32_at(14), 40);
        assert_eq!(i32_at(18), 3);
        // Positive: the rows run from the bottom, as GetDIBits gives them.
        assert_eq!(i32_at(22), 2);
        assert_eq!(u16::from_le_bytes([h[26], h[27]]), 1);
        assert_eq!(u16::from_le_bytes([h[28], h[29]]), 32);
        assert_eq!(u32_at(30), 0);
        assert_eq!(u32_at(34), 24);
        // 96 DPI is 3780 pixels per metre.
        assert_eq!(i32_at(38), 3780);
        assert_eq!(i32_at(42), 3780);
        assert_eq!(u32_at(46), 0);
        assert_eq!(u32_at(50), 0);
        // 120 and 144 DPI: 4724 and 5669 pixels per metre.
        for (dpi, ppm) in [(120u32, 4724i32), (144, 5669)] {
            let h = bmp_header(3, 2, dpi).expect("a header");
            assert_eq!(i32::from_le_bytes([h[38], h[39], h[40], h[41]]), ppm, "{dpi} DPI");
        }
    }

    #[test]
    fn a_size_out_of_bounds_has_no_header() {
        for (w, h) in [(0, 1), (1, 0), (MAX_SIDE + 1, 1), (1, MAX_SIDE + 1)] {
            assert!(bmp_header(w, h, 96).is_err(), "{w} by {h}");
        }
        let big = bmp_header(MAX_SIDE, MAX_SIDE, 96).expect("the largest display");
        assert_eq!(u32::from_le_bytes([big[2], big[3], big[4], big[5]]) as u64, 54 + u64::from(MAX_SIDE) * u64::from(MAX_SIDE) * 4);
    }

    /// A new, empty folder of this test's own.
    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aicc-capture-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a test folder");
        dir
    }

    #[test]
    fn the_writer_writes_the_header_then_the_pixels_as_a_new_file() {
        let dir = folder("write");
        let path = dir.join(file_name(0));
        let pixels: Vec<u8> = (0..(2 * 2 * 4) as u8).collect();
        write_bmp(&path, 2, 2, 120, &pixels).expect("written");
        let bytes = std::fs::read(&path).expect("read back");
        assert_eq!(bytes.len(), 54 + 16);
        assert_eq!(&bytes[..54], &bmp_header(2, 2, 120).expect("a header")[..]);
        assert_eq!(&bytes[54..], &pixels[..]);
        // Never over a file that is there: that one is left as it was.
        let again = write_bmp(&path, 2, 2, 120, &[0u8; 16]).expect_err("a second write fails");
        assert_eq!(again.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&path).expect("read back"), bytes);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pixels_of_the_wrong_length_write_no_file() {
        let dir = folder("short");
        let path = dir.join(file_name(0));
        for wrong in [0usize, 15, 17] {
            let e = write_bmp(&path, 2, 2, 96, &vec![0u8; wrong]).expect_err("refused");
            assert_eq!(e.kind(), io::ErrorKind::InvalidInput);
            assert!(!path.exists(), "a file was left for {wrong} bytes");
        }
        let e = write_bmp(&path, 0, 2, 96, &[]).expect_err("refused");
        assert_eq!(e.kind(), io::ErrorKind::InvalidInput);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A display of 2 by 1 pixels, `left` pixels from the primary one.
    fn tiny(left: i32) -> Display {
        Display { left, top: 0, width: 2, height: 1, dpi: 96, primary: left == 0 }
    }

    #[test]
    fn a_run_that_grabs_every_display_writes_each_in_order() {
        let dir = folder("all-written");
        let mut n = 0u8;
        let run = write_all_or_none(&dir, &[tiny(0), tiny(2)], |_| {
            n += 1;
            Ok(vec![n; pixel_bytes(2, 1)])
        });
        assert_eq!(run, Ok(()));
        for (i, fill) in [1u8, 2].into_iter().enumerate() {
            let bytes = std::fs::read(dir.join(file_name(i))).expect("a display's file");
            assert_eq!(&bytes[..BMP_HEADER_BYTES], &bmp_header(2, 1, 96).expect("a header")[..]);
            assert_eq!(&bytes[BMP_HEADER_BYTES..], &vec![fill; pixel_bytes(2, 1)][..], "display {}", i + 1);
        }
        assert_eq!(std::fs::read_dir(&dir).expect("the folder").count(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_whose_second_grab_fails_removes_the_first_file_and_leaves_the_folder_empty() {
        let dir = folder("all-or-none-grab");
        let first = dir.join(file_name(0));
        let mut grabs = 0;
        let mut first_was_written = false;
        let run = write_all_or_none(&dir, &[tiny(0), tiny(2)], |_| {
            grabs += 1;
            if grabs == 1 {
                return Ok(vec![7u8; pixel_bytes(2, 1)]);
            }
            // The first file is there when the second grab fails, so the
            // run has one of its own to remove.
            first_was_written = first.exists();
            Err(Failure::Failed("the second grab failed".to_string()))
        });
        assert_eq!(run, Err(Failure::Failed("the second grab failed".to_string())));
        assert_eq!(grabs, 2, "both displays were grabbed");
        assert!(first_was_written, "display-1.bmp was not written before the second grab");
        assert_eq!(std::fs::read_dir(&dir).expect("the folder").count(), 0, "a failed run left a file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_that_meets_a_file_already_there_removes_its_own_and_leaves_that_one_as_it_was() {
        let dir = folder("all-or-none-there");
        let earlier = b"an earlier display-2.bmp".to_vec();
        std::fs::write(dir.join(file_name(1)), &earlier).expect("an earlier file");
        let run = write_all_or_none(&dir, &[tiny(0), tiny(2)], |_| Ok(vec![7u8; pixel_bytes(2, 1)]));
        assert!(matches!(run, Err(Failure::Failed(ref why)) if why.contains("display-2.bmp")), "{run:?}");
        assert!(!dir.join(file_name(0)).exists(), "display-1.bmp was left");
        assert_eq!(std::fs::read(dir.join(file_name(1))).expect("the earlier file"), earlier, "the earlier display-2.bmp changed");
        assert_eq!(std::fs::read_dir(&dir).expect("the folder").count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_pixel_is_made_opaque_and_nothing_else_changes() {
        let mut px = vec![1u8, 2, 3, 0, 4, 5, 6, 7];
        make_opaque(&mut px);
        assert_eq!(px, vec![1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_the_run_says_not_supported() {
        let dir = folder("unsupported");
        let run = run(&CaptureRequest { out: dir.clone() });
        assert!(matches!(run, Err(Failure::Failed(ref why)) if why.contains("not supported")), "{run:?}");
        assert_eq!(std::fs::read_dir(&dir).expect("the folder").count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
