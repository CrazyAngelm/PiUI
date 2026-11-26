//! Native bounds for the separate browser WebViews in the Windows workbench.

use std::sync::atomic::Ordering;

use tauri::{
    LogicalSize, Manager, PhysicalPosition, PhysicalSize, Rect, Runtime, Webview, Window,
    WindowEvent,
};

use super::{CHROME, CHROME_HEIGHT, SiteBrowser, TAB_PREFIX, WINDOW, visibility};

fn rect(x: u32, y: u32, width: u32, height: u32) -> Rect {
    Rect {
        position: PhysicalPosition::new(x as i32, y as i32).into(),
        size: PhysicalSize::new(width, height).into(),
    }
}

struct Layout {
    workbench: Rect,
    toolbar: Rect,
    page: Rect,
}

impl Layout {
    fn new(size: PhysicalSize<u32>, toolbar_height: u32, open: bool) -> Self {
        let split = size.width / 2;
        let toolbar_height = toolbar_height.min(size.height);
        let dock_width = size.width - split;
        Self {
            workbench: rect(0, 0, if open { split } else { size.width }, size.height),
            toolbar: rect(split, 0, dock_width, toolbar_height),
            page: rect(
                split,
                toolbar_height,
                dock_width,
                size.height - toolbar_height,
            ),
        }
    }
}

fn toolbar_height(scale_factor: f64) -> u32 {
    LogicalSize::new(0.0, CHROME_HEIGHT)
        .to_physical::<u32>(scale_factor)
        .height
}

pub(super) fn bounds<R: Runtime>(window: &Window<R>, toolbar: bool) -> tauri::Result<Rect> {
    let layout = Layout::new(
        window.inner_size()?,
        toolbar_height(window.scale_factor()?),
        true,
    );
    Ok(if toolbar { layout.toolbar } else { layout.page })
}

fn arrange<R: Runtime>(window: &Window<R>, open: bool) -> tauri::Result<()> {
    let size = window.inner_size()?;
    if size.width == 0 || size.height == 0 {
        // Wry updates the main view's resize proportions when set_bounds is
        // called. Keep them valid while the client area is minimized.
        return Ok(());
    }
    let layout = Layout::new(size, toolbar_height(window.scale_factor()?), open);
    let mut result = Ok(());
    for view in window.webviews() {
        let bounds = match view.label() {
            WINDOW => layout.workbench,
            CHROME if open => layout.toolbar,
            label if open && label.starts_with(TAB_PREFIX) => layout.page,
            _ => continue,
        };
        result = result.and(view.set_bounds(bounds));
    }
    result
}

pub(super) fn configure<R: Runtime>(chrome: &Webview<R>) -> tauri::Result<()> {
    chrome.hide()?;
    let window = chrome.window();
    let resized = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) && let Some(browser) = resized.app_handle().try_state::<SiteBrowser>()
        {
            let _ = arrange(&resized, browser.dock_open.load(Ordering::Acquire));
        }
    });
    Ok(())
}

pub(super) fn set_open<R: Runtime>(
    window: &Window<R>,
    browser: &SiteBrowser,
    active: Option<u32>,
    open: bool,
) -> tauri::Result<()> {
    let Some(chrome) = window.get_webview(CHROME) else {
        return Err(tauri::Error::WebviewNotFound);
    };
    let workbench = window.get_webview(WINDOW);
    if open && workbench.is_none() {
        return Err(tauri::Error::WebviewNotFound);
    }
    let update = |open| {
        if open {
            arrange(window, true)?;
            chrome.show()?;
            visibility(window, active)
        } else {
            let tabs = visibility(window, None);
            let toolbar = chrome.hide();
            let workbench = arrange(window, false);
            tabs.and(toolbar).and(workbench)
        }
    };
    let focus = |open| {
        if let Some(target) = if open {
            Some(&chrome)
        } else {
            workbench.as_ref()
        } {
            let _ = target.set_focus();
        }
    };
    let was_open = browser.dock_open.swap(open, Ordering::AcqRel);
    if let Err(error) = update(open) {
        browser.dock_open.store(was_open, Ordering::Release);
        let _ = update(was_open);
        focus(was_open);
        return Err(error);
    }
    focus(open);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixels(rect: Rect) -> (i32, i32, u32, u32) {
        let position = rect.position.to_physical(1.0);
        let size = rect.size.to_physical(1.0);
        (position.x, position.y, size.width, size.height)
    }

    #[test]
    fn workbench_and_dock_cover_the_main_window_without_overlap() {
        let size = PhysicalSize::new(1181, 784);
        let layout = Layout::new(size, 110, true);
        assert_eq!(pixels(layout.workbench), (0, 0, 590, 784));
        assert_eq!(pixels(layout.toolbar), (590, 0, 591, 110));
        assert_eq!(pixels(layout.page), (590, 110, 591, 674));
        assert_eq!(
            pixels(Layout::new(size, 110, false).workbench),
            (0, 0, 1181, 784)
        );
    }

    #[test]
    fn the_toolbar_does_not_produce_negative_bounds_in_a_short_window() {
        let layout = Layout::new(PhysicalSize::new(720, 60), 88, true);
        assert_eq!(pixels(layout.toolbar), (360, 0, 360, 60));
        assert_eq!(pixels(layout.page), (360, 60, 360, 0));
    }
}
