use super::{
    Target,
    protocol::{Action, Key},
};
use enigo::{Axis, Button, Direction, Enigo, Key as NativeKey, Keyboard, Mouse, Settings};
use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HWND, POINT},
    System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    },
    UI::{
        HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
        Input::KeyboardAndMouse::GetAsyncKeyState,
        WindowsAndMessaging::{
            GA_ROOT, GetAncestor, GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId,
            SetCursorPos, SetForegroundWindow, WindowFromPoint,
        },
    },
};
use xcap::Window;

const MISSING_WINDOW: &str = "This window is no longer available.";

pub(super) fn initialize() {
    // The DWM capture and window bounds use physical desktop pixels.
    // If the executable manifest already selected this, Windows keeps it.
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

pub(super) fn available() -> bool {
    true
}

pub(super) fn process_image(pid: u32) -> Option<PathBuf> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    // Win32 extended-length paths are bounded at 32,767 UTF-16 code units.
    let mut path = vec![0u16; 32_768];
    let mut length = path.len() as u32;
    let result = unsafe {
        let result = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length);
        CloseHandle(process);
        result
    };
    (result != 0).then(|| PathBuf::from(OsString::from_wide(&path[..length as usize])))
}

fn describe(window: &Window) -> Option<Target> {
    let pid = window.pid().ok()?;
    let executable = process_image(pid)?;
    let app = executable.file_name()?.to_str()?.to_owned();
    Some(Target {
        id: u64::from(window.id().ok()?),
        pid,
        app,
        title: window.title().ok()?,
        x: window.x().ok()?,
        y: window.y().ok()?,
        width: window.width().ok()?,
        height: window.height().ok()?,
    })
}

pub(super) fn windows() -> Result<Vec<Target>, &'static str> {
    Ok(Window::all()
        .map_err(|_| "Could not read open Windows windows.")?
        .iter()
        .filter(|window| matches!(window.is_minimized(), Ok(false)))
        .filter_map(describe)
        .collect())
}

fn find_window(target: &Target) -> Result<Window, &'static str> {
    Window::all()
        .map_err(|_| MISSING_WINDOW)?
        .into_iter()
        .filter(|window| matches!(window.is_minimized(), Ok(false)))
        .find(|window| describe(window).is_some_and(|current| current == *target))
        .ok_or(MISSING_WINDOW)
}

pub(super) fn capture(target: &Target) -> Result<Vec<u8>, &'static str> {
    let image = find_window(target)?
        .capture_image()
        .map_err(|_| "This window could not be captured by Windows.")?;
    if image.dimensions() != (target.width, target.height) {
        return Err("Window scaling changed. Inspect the window again.");
    }
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, target.width, target.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|_| "Could not encode window screenshot.")?;
    writer
        .write_image_data(image.as_raw())
        .map_err(|_| "Could not encode window screenshot.")?;
    writer
        .finish()
        .map_err(|_| "Could not encode window screenshot.")?;
    Ok(bytes)
}

fn matches_window(window: HWND, target: &Target) -> bool {
    // HWND values returned by XCap are normalized to the low 32 bits.
    let mut pid = 0;
    !window.is_null()
        && u64::from(window as usize as u32) == target.id
        && unsafe { GetWindowThreadProcessId(window, &mut pid) } != 0
        && pid == target.pid
}

fn require_focus(target: &Target) -> Result<(), &'static str> {
    if matches_window(unsafe { GetForegroundWindow() }, target) {
        Ok(())
    } else {
        Err("Windows did not focus the selected window. Activate it and inspect it again.")
    }
}

fn activate(target: &Target) -> Result<(), &'static str> {
    if require_focus(target).is_err() {
        let window = target.id as u32 as usize as HWND;
        if !matches_window(window, target) {
            return Err(MISSING_WINDOW);
        }
        // Respect Windows' foreground policy. The actual foreground window is
        // checked below even if Windows accepted the activation request.
        unsafe { SetForegroundWindow(window) };
    }
    require_focus(target)
}

fn require_no_held_input() -> Result<(), &'static str> {
    // The Win32 virtual-key range includes mouse buttons and modifier keys.
    if (1..=0xfe).any(|key| unsafe { GetAsyncKeyState(key) } < 0) {
        Err("Release held keys and mouse buttons before sending input.")
    } else {
        Ok(())
    }
}

fn point(target: &Target, x: u32, y: u32) -> Result<POINT, &'static str> {
    let x =
        i32::try_from(i64::from(target.x) + i64::from(x)).map_err(|_| "Invalid screen point.")?;
    let y =
        i32::try_from(i64::from(target.y) + i64::from(y)).map_err(|_| "Invalid screen point.")?;
    let pt = POINT { x, y };
    // Top-level hit testing catches floating dialogs or another app covering
    // the point, even when the foreground window itself did not change.
    let hit = unsafe { GetAncestor(WindowFromPoint(pt), GA_ROOT) };
    if !matches_window(hit, target) {
        return Err("The selected point is covered by another window.");
    }
    Ok(pt)
}

fn key_code(key: Key) -> NativeKey {
    match key {
        Key::Enter => NativeKey::Return,
        Key::Escape => NativeKey::Escape,
        Key::Tab => NativeKey::Tab,
        Key::Backspace => NativeKey::Backspace,
        Key::Up => NativeKey::UpArrow,
        Key::Down => NativeKey::DownArrow,
        Key::Left => NativeKey::LeftArrow,
        Key::Right => NativeKey::RightArrow,
        Key::Home => NativeKey::Home,
        Key::End => NativeKey::End,
        Key::Space => NativeKey::Space,
    }
}

pub(super) fn perform(target: &Target, action: &Action) -> Result<(), &'static str> {
    find_window(target)?;
    require_no_held_input()?;
    activate(target)?;
    let refusal = |_| "Windows refused the requested input.";
    let mut input =
        Enigo::new(&Settings::default()).map_err(|_| "Windows input is unavailable.")?;
    find_window(target)?;
    require_focus(target)?;
    let pointer = if let Action::Click { x, y } | Action::Scroll { x, y, .. } = action {
        let position = point(target, *x, *y)?;
        if unsafe { SetCursorPos(position.x, position.y) } == 0 {
            return Err("Windows refused to move the pointer.");
        }
        Some((*x, *y))
    } else {
        None
    };
    require_no_held_input()?;
    let pointer = if let Some((x, y)) = pointer {
        // Moving the pointer can trigger hover UI or change window geometry.
        find_window(target)?;
        let position = point(target, x, y)?;
        let mut actual = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut actual) } == 0
            || (actual.x, actual.y) != (position.x, position.y)
        {
            return Err("The pointer moved. Inspect the window again.");
        }
        Some(position)
    } else {
        None
    };
    require_focus(target)?;
    match action {
        Action::Click { .. } => input.button(Button::Left, Direction::Click),
        Action::Type { text } => input.text(text),
        Action::Scroll { lines, .. } => input.scroll(i32::from(*lines), Axis::Vertical),
        Action::Key { key } => input.key(key_code(*key), Direction::Click),
    }
    .map_err(refusal)?;
    if let Some(position) = pointer {
        super::windows_pointer::mark(position);
    }
    Ok(())
}
