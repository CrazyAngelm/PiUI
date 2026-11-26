//! The owner-modal approval uses a selectable, scrolling native edit control.

use std::ptr::null_mut;
use std::sync::{Arc, Mutex};

use tauri::Window;
use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BS_DEFPUSHBUTTON, DS_CENTER, DS_MODALFRAME, DS_SETFONT, DialogBoxIndirectParamW,
    ES_AUTOVSCROLL, ES_MULTILINE, ES_READONLY, EndDialog, GWLP_USERDATA, GetDlgItem,
    GetWindowLongPtrW, GetWindowTextLengthW, IDCANCEL, IDYES, PostMessageW, SetDlgItemTextW,
    SetWindowLongPtrW, WM_CLOSE, WM_COMMAND, WM_INITDIALOG, WM_NCDESTROY, WS_CAPTION, WS_CHILD,
    WS_EX_CLIENTEDGE, WS_POPUP, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE, WS_VSCROLL,
};

const DETAILS: i32 = 1100;
const TITLE: &str = "Нано · Заполнение формы";

#[derive(Default)]
struct Dialog {
    hwnd: usize,
    cancelled: bool,
}

#[derive(Default)]
struct PendingDialog(Arc<Mutex<Dialog>>);

impl Drop for PendingDialog {
    fn drop(&mut self) {
        if let Ok(mut dialog) = self.0.lock() {
            dialog.cancelled = true;
            if dialog.hwnd != 0 {
                // The UI thread takes the handle out of this slot before teardown.
                unsafe { PostMessageW(dialog.hwnd as HWND, WM_CLOSE, 0, 0) };
            }
        }
    }
}

pub(super) async fn confirm(
    owner: &Window,
    url: &str,
    field: &str,
    value: &str,
) -> Result<bool, &'static str> {
    let owner = owner.hwnd().map_err(|_| "unavailable")?.0 as usize;
    let turn = crate::chat_link::browser_confirmation_turn().ok_or("confirmation-busy")?;
    let text = format!("Адрес:\r\n{url}\r\n\r\nПоле:\r\n{field}\r\n\r\nЗначение:\r\n{value}");
    let dialog = PendingDialog::default();
    let state = dialog.0.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _turn = turn;
        let data = Data {
            state,
            details: wide(&text),
        };
        let template = template();
        // The template and callback data live for the entire modal message loop.
        unsafe {
            DialogBoxIndirectParamW(
                null_mut(),
                template.as_ptr().cast(),
                owner as HWND,
                Some(dialog_proc),
                (&raw const data) as LPARAM,
            )
        }
    })
    .await;
    drop(dialog);
    match result {
        Ok(result) if result == IDYES as isize => Ok(true),
        Ok(result) if result == IDCANCEL as isize => Ok(false),
        _ => Err("confirmation-unavailable"),
    }
}

struct Data {
    state: Arc<Mutex<Dialog>>,
    details: Vec<u16>,
}

unsafe extern "system" fn dialog_proc(
    hwnd: HWND,
    message: u32,
    command: WPARAM,
    data: LPARAM,
) -> isize {
    // Only DialogBoxIndirectParamW supplies this pointer, and its caller
    // retains the allocation until the dialog procedure has returned.
    unsafe {
        if message == WM_INITDIALOG {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, data);
            let data = &*(data as *const Data);
            let control = GetDlgItem(hwnd, DETAILS);
            let len = i32::try_from(data.details.len() - 1).ok();
            let loaded = !control.is_null()
                && SetDlgItemTextW(hwnd, DETAILS, data.details.as_ptr()) != 0
                && len == Some(GetWindowTextLengthW(control));
            if loaded
                && let Ok(mut dialog) = data.state.lock()
                && !dialog.cancelled
            {
                dialog.hwnd = hwnd as usize;
                return 1;
            }
            EndDialog(hwnd, IDCANCEL as isize);
            return 1;
        }
        let choice = (command & 0xffff) as i32;
        let clicked = message == WM_COMMAND && matches!(choice, IDYES | IDCANCEL);
        if clicked || matches!(message, WM_CLOSE | WM_NCDESTROY) {
            let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Data;
            let mut result = IDCANCEL;
            if let Some(data) = pointer.as_ref()
                && let Ok(mut dialog) = data.state.lock()
            {
                dialog.hwnd = 0;
                if clicked && !dialog.cancelled {
                    result = choice;
                }
            }
            if message != WM_NCDESTROY {
                EndDialog(hwnd, result as isize);
                return 1;
            }
        }
    }
    0
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

// Standard Win32 DLGTEMPLATE / DLGITEMTEMPLATE wire layout. Coordinates
// are font-scaled dialog units. A separate read-only control keeps the
// full address/value available to scroll, select and copy at any length.
fn template() -> Vec<u32> {
    let style =
        WS_POPUP | WS_CAPTION | WS_SYSMENU | (DS_MODALFRAME | DS_CENTER | DS_SETFONT) as u32;
    let mut words = Vec::new();
    dword(&mut words, style);
    dword(&mut words, 0);
    words.extend([4, 0, 0, 328, 192, 0, 0]);
    words.extend(wide(TITLE));
    words.push(9);
    words.extend(wide("MS Shell Dlg"));
    control(
        &mut words,
        0,
        0,
        [8, 8, 312, 29],
        0xffff,
        0x82, // STATIC
        "Выполните ручной шаг на сайте. После вашего «Готово» в этом чате Нано заполнит указанное поле. Адрес и значение можно прокрутить и скопировать.",
    );
    control(
        &mut words,
        WS_TABSTOP | WS_VSCROLL | (ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL) as u32,
        WS_EX_CLIENTEDGE,
        [8, 39, 312, 121],
        DETAILS as u16,
        0x81, // EDIT
        "",
    );
    control(
        &mut words,
        WS_TABSTOP,
        0,
        [206, 169, 54, 15],
        IDYES as u16,
        0x80, // BUTTON
        "Открыть",
    );
    control(
        &mut words,
        WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
        0,
        [266, 169, 54, 15],
        IDCANCEL as u16,
        0x80, // BUTTON
        "Отмена",
    );
    // Win32 requires DWORD alignment for the template and each control.
    words
        .chunks(2)
        .map(|pair| u32::from(pair[0]) | (u32::from(*pair.get(1).unwrap_or(&0)) << 16))
        .collect()
}

fn control(
    words: &mut Vec<u16>,
    style: u32,
    extended: u32,
    geometry: [u16; 4],
    id: u16,
    class: u16,
    text: &str,
) {
    if !words.len().is_multiple_of(2) {
        words.push(0);
    }
    dword(words, style | WS_CHILD | WS_VISIBLE);
    dword(words, extended);
    words.extend(geometry);
    words.extend([id, 0xffff, class]);
    words.extend(wide(text));
    words.push(0);
}

fn dword(words: &mut Vec<u16>, value: u32) {
    words.extend([value as u16, (value >> 16) as u16]);
}
