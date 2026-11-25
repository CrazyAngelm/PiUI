use super::{
    Target,
    protocol::{Action, Key},
};
use enigo::{Axis, Button, Direction, Enigo, Key as NativeKey, Keyboard, Mouse, Settings};
use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HWND, LPARAM, POINT, WPARAM},
    System::{
        LibraryLoader::GetModuleHandleW,
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
    },
    UI::{
        HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
        Input::KeyboardAndMouse::{GetAsyncKeyState, GetFocus, VK_RETURN},
        WindowsAndMessaging::{
            BN_CLICKED, BS_DEFPUSHBUTTON, BS_PUSHBUTTON, DS_CENTER, DS_MODALFRAME, DS_SETFONT,
            DS_SETFOREGROUND, DialogBoxIndirectParamW, ES_MULTILINE, ES_READONLY, ES_WANTRETURN,
            EndDialog, GA_ROOT, GetAncestor, GetCursorPos, GetDlgItem, GetDlgItemTextW,
            GetForegroundWindow, GetWindowThreadProcessId, IDCANCEL, IDOK, KillTimer, SetCursorPos,
            SetDlgItemTextW, SetTimer, USER_TIMER_MINIMUM, WM_CLOSE, WM_COMMAND, WM_INITDIALOG,
            WM_TIMER, WS_CAPTION, WS_CHILD, WS_EX_CLIENTEDGE, WS_POPUP, WS_SYSMENU, WS_TABSTOP,
            WS_VISIBLE, WS_VSCROLL, WindowFromPoint,
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

const PROMPT_ID: i32 = 100;
const APPROVAL_KEY_RELEASE: usize = 1;
const APPROVAL_TITLE: &str = "Nano Desktop · Computer Use";

fn dialog_words(words: &mut Vec<u16>, text: &str) {
    words.extend(text.encode_utf16().chain([0]));
}

fn dialog_control(
    words: &mut Vec<u16>,
    style: u32,
    extended_style: u32,
    bounds: [u16; 4],
    id: i32,
    class: u16,
    label: &str,
) {
    // Every DLGITEMTEMPLATE starts on a DWORD boundary.
    if words.len() % 2 != 0 {
        words.push(0);
    }
    let style = style | WS_CHILD | WS_VISIBLE | WS_TABSTOP;
    words.extend([
        style as u16,
        (style >> 16) as u16,
        extended_style as u16,
        (extended_style >> 16) as u16,
    ]);
    words.extend(bounds);
    words.extend([id as u16, 0xffff, class]);
    dialog_words(words, label);
    words.push(0);
}

fn approval_dialog() -> Vec<u32> {
    let style = WS_POPUP
        | WS_CAPTION
        | WS_SYSMENU
        | (DS_CENTER | DS_MODALFRAME | DS_SETFONT | DS_SETFOREGROUND) as u32;
    let mut words = vec![
        style as u16,
        (style >> 16) as u16,
        0,
        0,
        3,
        0,
        0,
        320,
        196,
        0,
        0,
    ];
    dialog_words(&mut words, APPROVAL_TITLE);
    words.push(9);
    dialog_words(&mut words, "Segoe UI");

    const BUTTON_CLASS: u16 = 0x0080;
    const EDIT_CLASS: u16 = 0x0081;
    dialog_control(
        &mut words,
        BS_DEFPUSHBUTTON as u32,
        0,
        [248, 170, 64, 18],
        IDCANCEL,
        BUTTON_CLASS,
        "Cancel",
    );
    dialog_control(
        &mut words,
        (ES_MULTILINE | ES_READONLY | ES_WANTRETURN) as u32 | WS_VSCROLL,
        WS_EX_CLIENTEDGE,
        [8, 8, 304, 154],
        PROMPT_ID,
        EDIT_CLASS,
        "",
    );
    dialog_control(
        &mut words,
        BS_PUSHBUTTON as u32,
        0,
        [178, 170, 64, 18],
        IDOK,
        BUTTON_CLASS,
        "Approve",
    );

    // DLGTEMPLATE itself must also start on a DWORD boundary.
    if words.len() % 2 != 0 {
        words.push(0);
    }
    words
        .chunks_exact(2)
        .map(|pair| u32::from(pair[0]) | (u32::from(pair[1]) << 16))
        .collect()
}

unsafe extern "system" fn approval_proc(
    dialog: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> isize {
    match message {
        WM_INITDIALOG => {
            // DialogBoxIndirectParamW keeps the caller's text alive through this callback.
            let expected = unsafe { &*(lparam as *const Vec<u16>) };
            let Ok(capacity) = i32::try_from(expected.len()) else {
                unsafe { EndDialog(dialog, 0) };
                return 1;
            };
            let mut displayed = vec![0u16; expected.len()];
            if unsafe { SetDlgItemTextW(dialog, PROMPT_ID, expected.as_ptr()) } == 0
                || unsafe { GetDlgItemTextW(dialog, PROMPT_ID, displayed.as_mut_ptr(), capacity) }
                    != (capacity - 1) as u32
                || displayed != *expected
            {
                unsafe { EndDialog(dialog, 0) };
            }
            // The Cancel button is the first tab stop and the default button.
            1
        }
        WM_COMMAND => {
            let id = (wparam & 0xffff) as i32;
            let notification = ((wparam >> 16) & 0xffff) as u32;
            if id == IDCANCEL {
                unsafe { EndDialog(dialog, 0) };
                return 1;
            }
            let button = unsafe { GetDlgItem(dialog, IDOK) };
            if id == IDOK
                && notification == BN_CLICKED
                && !button.is_null()
                && lparam == button as LPARAM
                && unsafe { GetFocus() } == button
            {
                if unsafe { GetAsyncKeyState(i32::from(VK_RETURN)) } < 0 {
                    // Dialog accelerators fire on key-down. Keep consent in
                    // this window until Enter is released, so it never
                    // repeats into the target window after approval.
                    if unsafe { SetTimer(dialog, APPROVAL_KEY_RELEASE, USER_TIMER_MINIMUM, None) }
                        == 0
                    {
                        unsafe { EndDialog(dialog, 0) };
                    }
                } else {
                    unsafe { EndDialog(dialog, 1) };
                }
                return 1;
            }
            0
        }
        WM_TIMER if wparam == APPROVAL_KEY_RELEASE => {
            if unsafe { GetAsyncKeyState(i32::from(VK_RETURN)) } >= 0 {
                unsafe { KillTimer(dialog, APPROVAL_KEY_RELEASE) };
                let approve = unsafe { GetDlgItem(dialog, IDOK) };
                if !approve.is_null() && unsafe { GetFocus() } == approve {
                    unsafe { EndDialog(dialog, 1) };
                }
            }
            1
        }
        WM_CLOSE => {
            unsafe { EndDialog(dialog, 0) };
            1
        }
        _ => 0,
    }
}

pub(super) fn confirm(prompt: &str) -> bool {
    if prompt.contains('\0') {
        return false;
    }
    let prompt = prompt.replace("\r\n", "\n").replace('\n', "\r\n");
    let text: Vec<u16> = prompt.encode_utf16().chain([0]).collect();
    let template = approval_dialog();
    unsafe {
        DialogBoxIndirectParamW(
            GetModuleHandleW(ptr::null()),
            template.as_ptr().cast(),
            ptr::null_mut(),
            Some(approval_proc),
            &text as *const Vec<u16> as LPARAM,
        ) == 1
    }
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

pub(super) fn capture(target: &Target) -> Result<Vec<u8>, &'static str> {
    let window = Window::all()
        .map_err(|_| MISSING_WINDOW)?
        .into_iter()
        .find(|window| describe(window).is_some_and(|current| current == *target))
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
    let foreground = unsafe { GetForegroundWindow() };
    let mut pid = 0;
    if u64::from(foreground as usize as u32) == target.id
        && unsafe { GetWindowThreadProcessId(foreground, &mut pid) } != 0
        && pid == target.pid
    {
        Ok(())
    } else {
        Err("Activate the selected window before approving input.")
    }
}

fn require_no_held_input() -> Result<(), &'static str> {
    // The Win32 virtual-key range includes mouse buttons and modifier keys.
    if (1..=0xfe).any(|key| unsafe { GetAsyncKeyState(key) } < 0) {
        Err("Release held keys and mouse buttons before approving input.")
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
    require_no_held_input()?;
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
        point(target, *x, *y)?;
    }
    require_no_held_input()?;
    require_focus(target)?;
    match action {
        Action::Click { .. } => input.button(Button::Left, Direction::Click),
        Action::Type { text } => input.text(text),
        Action::Scroll { lines, .. } => input.scroll(i32::from(*lines), Axis::Vertical),
        Action::Key { key } => input.key(key_code(*key), Direction::Click),
    }
    .map_err(refusal)
}
