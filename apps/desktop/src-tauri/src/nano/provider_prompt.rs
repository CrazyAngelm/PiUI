//! Native API-key entry for external model sources. The WebView receives only
//! the connection result; the password control and its contents stay native.

use tauri::{Runtime, WebviewWindow};
use zeroize::Zeroizing;

#[derive(Clone, Copy)]
pub(super) enum PromptLanguage {
    English,
    Russian,
}

#[derive(Debug, thiserror::Error)]
pub(super) enum PromptError {
    #[cfg(not(windows))]
    #[error("native provider key entry is unavailable on this platform")]
    Unsupported,
    #[cfg(windows)]
    #[error("the native provider key dialog could not be opened")]
    Unavailable,
}

#[cfg(windows)]
pub(super) async fn prompt_api_key<R: Runtime>(
    window: &WebviewWindow<R>,
    endpoint: &str,
    model: &str,
    language: PromptLanguage,
) -> Result<Option<Zeroizing<String>>, PromptError> {
    if [endpoint, model]
        .iter()
        .any(|value| value.is_empty() || value.chars().any(char::is_control))
    {
        return Err(PromptError::Unavailable);
    }
    let owner = window.clone();
    let endpoint = endpoint.to_owned();
    let model = model.to_owned();
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            if send.is_closed() {
                return;
            }
            let result = owner
                .hwnd()
                .map_err(|_| PromptError::Unavailable)
                .and_then(|parent| windows::prompt(parent.0, &endpoint, &model, language));
            let _ = send.send(result);
        })
        .map_err(|_| PromptError::Unavailable)?;
    receive.await.map_err(|_| PromptError::Unavailable)?
}

#[cfg(not(windows))]
pub(super) async fn prompt_api_key<R: Runtime>(
    _window: &WebviewWindow<R>,
    _endpoint: &str,
    _model: &str,
    _language: PromptLanguage,
) -> Result<Option<Zeroizing<String>>, PromptError> {
    Err(PromptError::Unsupported)
}

#[cfg(windows)]
mod windows {
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BS_DEFPUSHBUTTON, BS_PUSHBUTTON, DS_CENTER, DS_MODALFRAME, DS_SETFONT,
        DialogBoxIndirectParamW, ES_AUTOHSCROLL, ES_MULTILINE, ES_PASSWORD, ES_READONLY, EndDialog,
        GWLP_USERDATA, GetDlgItem, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
        IDCANCEL, IDOK, SetWindowLongPtrW, SetWindowTextW, WM_CLOSE, WM_COMMAND, WM_INITDIALOG,
        WS_BORDER, WS_CAPTION, WS_CHILD, WS_POPUP, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE, WS_VSCROLL,
    };

    use super::{PromptError, PromptLanguage, Zeroizing};

    const KEY_FIELD: u16 = 100;
    const DESTINATION_FIELD: u16 = 101;
    const STATIC_CLASS: u16 = 0x0082;
    const EDIT_CLASS: u16 = 0x0081;
    const BUTTON_CLASS: u16 = 0x0080;

    pub(super) fn prompt(
        owner: HWND,
        endpoint: &str,
        model: &str,
        language: PromptLanguage,
    ) -> Result<Option<Zeroizing<String>>, PromptError> {
        let template = dialog_template(endpoint, model, language);
        let mut secret = None::<Zeroizing<String>>;
        // The DWORD-aligned template and the result slot outlive the modal call.
        // The predefined dialog and control classes need no module resources.
        let result = unsafe {
            DialogBoxIndirectParamW(
                null_mut(),
                template.as_ptr().cast(),
                owner,
                Some(dialog_proc),
                (&raw mut secret) as LPARAM,
            )
        };
        match result {
            result if result == IDCANCEL as isize => Ok(None),
            result if result == IDOK as isize => secret.map(Some).ok_or(PromptError::Unavailable),
            _ => Err(PromptError::Unavailable),
        }
    }

    unsafe extern "system" fn dialog_proc(
        dialog: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> isize {
        // All control access is synchronous on the dialog's owning thread.
        unsafe {
            if message == WM_INITDIALOG {
                SetWindowLongPtrW(dialog, GWLP_USERDATA, lparam);
                return 1; // Windows focuses the first tab stop, the key field.
            }
            let command = if message == WM_CLOSE {
                IDCANCEL
            } else if message == WM_COMMAND {
                i32::from(wparam as u16)
            } else {
                return 0;
            };
            let edit = GetDlgItem(dialog, i32::from(KEY_FIELD));
            if edit.is_null() {
                EndDialog(dialog, -1);
                return 1;
            }
            if command == IDCANCEL {
                SetWindowTextW(edit, [0u16].as_ptr());
                EndDialog(dialog, IDCANCEL as isize);
                return 1;
            }
            if command != IDOK {
                return 0;
            }

            let length = GetWindowTextLengthW(edit);
            if length <= 0 {
                return 1;
            }
            let Some(capacity) = length.checked_add(1) else {
                EndDialog(dialog, -1);
                return 1;
            };
            let mut text = Zeroizing::new(vec![0u16; capacity as usize]);
            let copied = GetWindowTextW(edit, text.as_mut_ptr(), capacity);
            SetWindowTextW(edit, [0u16].as_ptr());
            let output = GetWindowLongPtrW(dialog, GWLP_USERDATA) as *mut Option<Zeroizing<String>>;
            if copied <= 0 || output.is_null() {
                EndDialog(dialog, -1);
                return 1;
            }
            let Ok(value) = String::from_utf16(&text[..copied as usize]) else {
                EndDialog(dialog, -1);
                return 1;
            };
            // WM_INITDIALOG stored the modal caller's result slot. EndDialog
            // returns control to that caller only after this callback returns.
            *output = Some(Zeroizing::new(value));
            EndDialog(dialog, IDOK as isize);
            1
        }
    }

    fn dialog_template(endpoint: &str, model: &str, language: PromptLanguage) -> Vec<u32> {
        let (title, key, destination, model_label, connect, cancel) = match language {
            PromptLanguage::English => (
                "Connect external provider",
                "&API key",
                "&Destination",
                "Model",
                "&Connect",
                "Cancel",
            ),
            PromptLanguage::Russian => (
                "Подключить внешнего провайдера",
                "&Ключ API",
                "&Адрес запроса",
                "Модель",
                "&Подключить",
                "Отмена",
            ),
        };
        let mut words = Vec::new();
        dword(
            &mut words,
            WS_POPUP | WS_CAPTION | WS_SYSMENU | (DS_CENTER | DS_MODALFRAME | DS_SETFONT) as u32,
        );
        dword(&mut words, 0);
        words.extend([6, 0, 0, 270, 111, 0, 0]); // Six controls, no menu or custom class.
        wide(&mut words, title);
        words.push(9);
        wide(&mut words, "Segoe UI");

        control(
            &mut words,
            WS_CHILD | WS_VISIBLE,
            [8, 56, 254, 12],
            0,
            STATIC_CLASS,
            key,
        );
        control(
            &mut words,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | (ES_PASSWORD | ES_AUTOHSCROLL) as u32,
            [8, 70, 254, 14],
            KEY_FIELD,
            EDIT_CLASS,
            "",
        );
        control(
            &mut words,
            WS_CHILD | WS_VISIBLE,
            [8, 8, 254, 12],
            0,
            STATIC_CLASS,
            destination,
        );
        control(
            &mut words,
            WS_CHILD
                | WS_VISIBLE
                | WS_TABSTOP
                | WS_BORDER
                | WS_VSCROLL
                | (ES_READONLY | ES_MULTILINE) as u32,
            [8, 22, 254, 31],
            DESTINATION_FIELD,
            EDIT_CLASS,
            &format!("{endpoint}\r\n{model_label}: {model}"),
        );
        control(
            &mut words,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
            [142, 90, 58, 15],
            IDOK as u16,
            BUTTON_CLASS,
            connect,
        );
        control(
            &mut words,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON as u32,
            [204, 90, 58, 15],
            IDCANCEL as u16,
            BUTTON_CLASS,
            cancel,
        );
        if !words.len().is_multiple_of(2) {
            words.push(0);
        }
        words
            .chunks_exact(2)
            .map(|pair| u32::from(pair[0]) | (u32::from(pair[1]) << 16))
            .collect()
    }

    fn control(
        words: &mut Vec<u16>,
        style: u32,
        bounds: [u16; 4],
        id: u16,
        class: u16,
        title: &str,
    ) {
        if !words.len().is_multiple_of(2) {
            words.push(0);
        }
        dword(words, style);
        dword(words, 0);
        words.extend(bounds);
        words.extend([id, 0xFFFF, class]);
        wide(words, title);
        words.push(0); // No control creation data.
    }

    fn dword(words: &mut Vec<u16>, value: u32) {
        words.extend([value as u16, (value >> 16) as u16]);
    }

    fn wide(words: &mut Vec<u16>, value: &str) {
        words.extend(value.encode_utf16());
        words.push(0);
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateDialogIndirectParamW, DestroyWindow, GWL_STYLE, GetNextDlgTabItem, GetWindowLongW,
        };

        fn read_string(words: &[u16], index: &mut usize) -> String {
            let length = words[*index..]
                .iter()
                .position(|&word| word == 0)
                .expect("NUL");
            let text = String::from_utf16(&words[*index..*index + length]).expect("UTF-16");
            *index += length + 1;
            text
        }

        #[test]
        fn key_field_is_password_masked_and_the_first_tab_stop() {
            for (language, label) in [
                (PromptLanguage::English, "&API key"),
                (PromptLanguage::Russian, "&Ключ API"),
            ] {
                let template = dialog_template(
                    "https://fixture.test/v1/chat/completions",
                    "vendor/model",
                    language,
                );
                let words: Vec<u16> = template
                    .iter()
                    .flat_map(|word| [*word as u16, (*word >> 16) as u16])
                    .collect();
                assert_eq!(words[4], 6);
                let mut index = 11;
                assert!(!read_string(&words, &mut index).is_empty());
                index += 1;
                assert_eq!(read_string(&words, &mut index), "Segoe UI");
                for (number, (id, class)) in [
                    (0, STATIC_CLASS),
                    (KEY_FIELD, EDIT_CLASS),
                    (0, STATIC_CLASS),
                    (DESTINATION_FIELD, EDIT_CLASS),
                    (IDOK as u16, BUTTON_CLASS),
                    (IDCANCEL as u16, BUTTON_CLASS),
                ]
                .into_iter()
                .enumerate()
                {
                    index += index % 2;
                    let style = u32::from(words[index]) | (u32::from(words[index + 1]) << 16);
                    assert_eq!(words[index + 8..index + 11], [id, 0xFFFF, class]);
                    assert_eq!(style & WS_TABSTOP != 0, id != 0);
                    if id == KEY_FIELD {
                        assert_ne!(style & ES_PASSWORD as u32, 0);
                    }
                    index += 11;
                    let title = read_string(&words, &mut index);
                    if number == 0 {
                        assert_eq!(title, label);
                    } else if id == KEY_FIELD {
                        assert!(title.is_empty());
                    } else if id == DESTINATION_FIELD {
                        assert_ne!(style & ES_READONLY as u32, 0);
                        assert!(title.starts_with("https://fixture.test/v1/chat/completions\r\n"));
                        assert!(title.ends_with("vendor/model"));
                    }
                    assert_eq!(words[index], 0);
                    index += 1;
                }
            }
        }

        #[test]
        fn windows_creates_the_masked_field_and_keyboard_order() {
            let template = dialog_template(
                "https://fixture.test/v1/chat/completions",
                "vendor/model",
                PromptLanguage::English,
            );
            // Modeless creation leaves this template hidden. The smoke test
            // observes controls without entering text or opening the real prompt.
            let (edit, first_tab, style, destroyed) = unsafe {
                let dialog = CreateDialogIndirectParamW(
                    null_mut(),
                    template.as_ptr().cast(),
                    null_mut(),
                    None,
                    0,
                );
                assert!(!dialog.is_null(), "Windows must accept the template");
                let edit = GetDlgItem(dialog, i32::from(KEY_FIELD));
                let first_tab = GetNextDlgTabItem(dialog, null_mut(), 0);
                let style = GetWindowLongW(edit, GWL_STYLE);
                (edit, first_tab, style, DestroyWindow(dialog))
            };
            assert_ne!(destroyed, 0);
            assert!(!edit.is_null());
            assert_eq!(first_tab, edit);
            assert_ne!(style & ES_PASSWORD, 0);
        }
    }
}
