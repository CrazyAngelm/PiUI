use super::{
    Target,
    protocol::{Action, Key},
};
use enigo::{Axis, Button, Direction, Enigo, Key as NativeKey, Keyboard, Mouse, Settings};
use windows_sys::Win32::{
    Foundation::POINT,
    UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
    UI::WindowsAndMessaging::{
        GA_ROOT, GetAncestor, GetCursorPos, GetForegroundWindow, IDOK, MB_DEFBUTTON2,
        MB_ICONWARNING, MB_OKCANCEL, MB_SETFOREGROUND, MessageBoxW, SetCursorPos, WindowFromPoint,
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

pub(super) fn confirm(prompt: &str) -> bool {
    let text: Vec<u16> = prompt.encode_utf16().chain([0]).collect();
    let title: Vec<u16> = "Nano Desktop · Computer Use"
        .encode_utf16()
        .chain([0])
        .collect();
    // Cancel gets the default focus. The selected app must regain focus after
    // this one-action dialog before any actual input is sent.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND,
        ) == IDOK
    }
}

fn describe(window: &Window) -> xcap::XCapResult<Target> {
    Ok(Target {
        id: u64::from(window.id()?),
        pid: window.pid()?,
        app: window.app_name()?,
        title: window.title()?,
        x: window.x()?,
        y: window.y()?,
        width: window.width()?,
        height: window.height()?,
    })
}

pub(super) fn windows() -> Result<Vec<Target>, &'static str> {
    Ok(Window::all()
        .map_err(|_| "Could not read open Windows windows.")?
        .iter()
        .filter(|window| matches!(window.is_minimized(), Ok(false)))
        .filter_map(|window| describe(window).ok())
        .collect())
}

pub(super) fn capture(target: &Target) -> Result<Vec<u8>, &'static str> {
    let window = Window::all()
        .map_err(|_| MISSING_WINDOW)?
        .into_iter()
        .find(|window| describe(window).is_ok_and(|current| current == *target))
        .ok_or(MISSING_WINDOW)?;
    let image = window
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

fn require_focus(target: &Target) -> Result<(), &'static str> {
    // HWND values returned by XCap are normalized to the low 32 bits.
    let foreground = unsafe { GetForegroundWindow() } as usize as u32;
    if u64::from(foreground) == target.id {
        Ok(())
    } else {
        Err("Activate the selected window before approving input.")
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
    let hit = unsafe { GetAncestor(WindowFromPoint(pt), GA_ROOT) } as usize as u32;
    if u64::from(hit) != target.id {
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
    require_focus(target)?;
    let refusal = |_| "Windows refused the requested input.";
    let mut input =
        Enigo::new(&Settings::default()).map_err(|_| "Windows input is unavailable.")?;
    if let Action::Click { x, y } | Action::Scroll { x, y, .. } = action {
        let position = point(target, *x, *y)?;
        let mut actual = POINT { x: 0, y: 0 };
        if unsafe { SetCursorPos(position.x, position.y) } == 0
            || unsafe { GetCursorPos(&mut actual) } == 0
            || (actual.x, actual.y) != (position.x, position.y)
        {
            return Err("The pointer moved. Inspect the window again.");
        }
        require_focus(target)?;
        point(target, *x, *y)?;
    }
    match action {
        Action::Click { .. } => input.button(Button::Left, Direction::Click),
        Action::Type { text } => input.text(text),
        Action::Scroll { lines, .. } => input.scroll(i32::from(*lines), Axis::Vertical),
        Action::Key { key } => input.key(key_code(*key), Direction::Click),
    }
    .map_err(refusal)
}
