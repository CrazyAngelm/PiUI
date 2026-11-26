//! The Windows helper marks confirmed pointer actions outside the chat window.
use std::{
    ptr::null_mut,
    sync::{Arc, OnceLock, mpsc},
    thread,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WAIT_OBJECT_0, WPARAM,
    },
    Graphics::Gdi::{
        COLOR_HIGHLIGHT, CombineRgn, CreateEllipticRgn, DeleteObject, GetSysColorBrush, RGN_DIFF,
        RGN_ERROR, SetWindowRgn, UpdateWindow,
    },
    System::{
        LibraryLoader::GetModuleHandleW,
        Threading::{CreateEventW, INFINITE, SetEvent},
    },
    UI::{
        Input::KeyboardAndMouse::GetDoubleClickTime,
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetSystemMetrics,
            HWND_TOPMOST, KillTimer, LWA_ALPHA, MSG, MWMO_INPUTAVAILABLE,
            MsgWaitForMultipleObjectsEx, PM_REMOVE, PeekMessageW, PostQuitMessage, QS_ALLINPUT,
            RegisterClassW, SM_CXCURSOR, SM_CYCURSOR, SW_HIDE, SWP_NOACTIVATE, SWP_SHOWWINDOW,
            SetLayeredWindowAttributes, SetTimer, SetWindowPos, ShowWindow, UnregisterClassW,
            WM_DESTROY, WM_QUIT, WM_TIMER, WNDCLASSW, WS_DISABLED, WS_EX_LAYERED, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
        },
    },
};

static POINTER: OnceLock<Option<PointerWorker>> = OnceLock::new();
const HIDE_TIMER: usize = 1;

pub(super) fn mark(position: POINT) {
    if let Some(worker) =
        POINTER.get_or_init(|| PointerWorker::spawn(|_| {}).map(|(worker, _)| worker))
    {
        worker.send(Some(position));
    }
}

// An owned auto-reset event. Win32 handles may be signaled from any thread.
struct WakeEvent(usize);

impl WakeEvent {
    fn new() -> Option<Self> {
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        (!event.is_null()).then_some(Self(event as usize))
    }

    fn handle(&self) -> HANDLE {
        self.0 as HANDLE
    }
}

impl Drop for WakeEvent {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle()) };
    }
}

struct PointerWorker {
    send: mpsc::Sender<Option<POINT>>,
    wake: Arc<WakeEvent>,
}

impl PointerWorker {
    fn spawn(ready: impl FnOnce(HWND) + Send + 'static) -> Option<(Self, thread::JoinHandle<()>)> {
        let wake = Arc::new(WakeEvent::new()?);
        let (send, receive) = mpsc::channel();
        let worker_wake = Arc::clone(&wake);
        let thread = thread::Builder::new()
            .name("nano-computer-use-pointer".into())
            .spawn(move || {
                if let Some(marker) = Marker::new() {
                    ready(marker.window);
                    pump(&marker, receive, &worker_wake);
                }
            })
            .ok()?;
        Some((Self { send, wake }, thread))
    }

    fn send(&self, position: Option<POINT>) {
        if self.send.send(position).is_ok() {
            unsafe { SetEvent(self.wake.handle()) };
        }
    }
}

impl Drop for PointerWorker {
    fn drop(&mut self) {
        self.send(None);
    }
}

fn pump(marker: &Marker, receive: mpsc::Receiver<Option<POINT>>, wake: &WakeEvent) {
    let wake = wake.handle();
    loop {
        // Top-level windows must receive sent and queued messages while idle too.
        let notified = unsafe {
            MsgWaitForMultipleObjectsEx(1, &wake, INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE)
        };
        if notified != WAIT_OBJECT_0 && notified != WAIT_OBJECT_0 + 1 {
            return;
        }
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) } != 0 {
            if message.message == WM_QUIT {
                return;
            }
            if message.hwnd == marker.window
                && message.message == WM_TIMER
                && message.wParam == HIDE_TIMER
            {
                marker.hide();
            } else {
                unsafe { DispatchMessageW(&message) };
            }
        }
        let mut position = None;
        loop {
            match receive.try_recv() {
                Ok(Some(point)) => position = Some(point),
                Ok(None) | Err(mpsc::TryRecvError::Disconnected) => return,
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }
        if let Some(point) = position {
            marker.show(point);
        }
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_DESTROY {
        unsafe { PostQuitMessage(0) };
        return 0;
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

struct Marker {
    window: HWND,
    module: HINSTANCE,
    class_name: Vec<u16>,
    edge: i32,
}

impl Marker {
    fn new() -> Option<Self> {
        let class_name: Vec<_> = "NanoComputerUsePointer\0".encode_utf16().collect();
        let module = unsafe { GetModuleHandleW(std::ptr::null()) };
        let edge = unsafe { GetSystemMetrics(SM_CXCURSOR).max(GetSystemMetrics(SM_CYCURSOR)) };
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: module,
            hbrBackground: unsafe { GetSysColorBrush(COLOR_HIGHLIGHT) },
            lpszClassName: class_name.as_ptr(),
            ..Default::default()
        };
        if edge <= 0 || unsafe { RegisterClassW(&class) } == 0 {
            return None;
        }
        let window = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT,
                class_name.as_ptr(),
                std::ptr::null(),
                WS_POPUP | WS_DISABLED,
                0,
                0,
                edge,
                edge,
                null_mut(),
                null_mut(),
                module,
                std::ptr::null(),
            )
        };
        let marker = Self {
            window,
            module,
            class_name,
            edge,
        };
        if window.is_null() || !marker.set_ring() {
            return None;
        }
        if unsafe { SetLayeredWindowAttributes(window, 0, u8::MAX, LWA_ALPHA) } == 0 {
            return None;
        }
        Some(marker)
    }

    fn set_ring(&self) -> bool {
        let edge = self.edge;
        let stroke = (edge / 8).max(1);
        // Win32 takes ownership of the outer region only if SetWindowRgn succeeds.
        unsafe {
            let outer = CreateEllipticRgn(0, 0, edge, edge);
            let inner = CreateEllipticRgn(stroke, stroke, edge - stroke, edge - stroke);
            let attached = !outer.is_null()
                && !inner.is_null()
                && CombineRgn(outer, outer, inner, RGN_DIFF) != RGN_ERROR
                && SetWindowRgn(self.window, outer, 0) != 0;
            if !inner.is_null() {
                DeleteObject(inner);
            }
            if !attached && !outer.is_null() {
                DeleteObject(outer);
            }
            attached
        }
    }

    fn show(&self, point: POINT) {
        let radius = self.edge / 2;
        unsafe {
            SetWindowPos(
                self.window,
                HWND_TOPMOST,
                point.x - radius,
                point.y - radius,
                self.edge,
                self.edge,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            UpdateWindow(self.window);
            // Match the system double-click interval without blocking input.
            if SetTimer(self.window, HIDE_TIMER, GetDoubleClickTime(), None) == 0 {
                self.hide();
            }
        }
    }

    fn hide(&self) {
        unsafe {
            KillTimer(self.window, HIDE_TIMER);
            ShowWindow(self.window, SW_HIDE);
        }
    }
}

impl Drop for Marker {
    fn drop(&mut self) {
        unsafe {
            if !self.window.is_null() {
                DestroyWindow(self.window);
            }
            UnregisterClassW(self.class_name.as_ptr(), self.module);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GWL_STYLE, GetWindowLongW, IsWindow, IsWindowVisible, SMTO_ABORTIFHUNG,
        SendMessageTimeoutW, WM_QUERYENDSESSION,
    };

    #[test]
    fn the_native_marker_pumps_messages_while_idle_and_cleans_up() {
        let (ready, wait) = mpsc::channel();
        let (worker, thread) = PointerWorker::spawn(move |window| {
            ready.send(window as usize).expect("notify test");
        })
        .expect("spawn marker worker");
        let window = wait.recv().expect("create pointer marker") as HWND;
        let ex_style = unsafe { GetWindowLongW(window, GWL_EXSTYLE) } as u32;
        let style = unsafe { GetWindowLongW(window, GWL_STYLE) } as u32;
        let pass_through = WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE;
        assert_eq!(ex_style & pass_through, pass_through);
        assert_ne!(style & WS_DISABLED, 0);

        assert_eq!(unsafe { IsWindowVisible(window) }, 0);
        let mut answer = 0;
        let replied = unsafe {
            SendMessageTimeoutW(
                window,
                WM_QUERYENDSESSION,
                0,
                0,
                SMTO_ABORTIFHUNG,
                GetDoubleClickTime(),
                &mut answer,
            )
        };
        assert_ne!(replied, 0, "an idle HWND must keep pumping sent messages");
        assert_ne!(answer, 0, "default window procedure permits session end");

        drop(worker);
        thread.join().expect("marker worker shuts down");
        assert_eq!(unsafe { IsWindow(window) }, 0);
    }
}
