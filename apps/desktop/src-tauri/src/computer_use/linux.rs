use enigo::{Direction, Enigo, Keyboard, Settings};
use x11rb::connection::Connection;
use x11rb::protocol::composite::{ConnectionExt as _, Redirect};
use x11rb::protocol::xproto::{
    AtomEnum, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ConnectionExt as _, GetImageReply,
    ImageFormat, ImageOrder, KeyButMask, MapState, VisualClass, Window,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;
use x11rb::{CURRENT_TIME, NONE};

use super::{
    Target,
    protocol::{Action, Key},
};

const UNAVAILABLE: &str = "A native X11 session is required.";
const STALE: &str = "The selected X11 window has changed or closed.";
const SCREENSHOT: &str = "The selected X11 window could not be captured.";
const INPUT: &str = "The X11 input could not be sent.";
const NOT_FOCUSED: &str = "Focus the selected X11 window before sending input.";
const OBSCURED: &str = "The point is covered by another X11 window.";
const OUTSIDE: &str = "The point is outside the selected X11 window.";

x11rb::atom_manager! {
    Atoms: AtomsCookie {
        _NET_CLIENT_LIST,
        _NET_WM_PID,
        _NET_WM_NAME,
        UTF8_STRING,
    }
}

struct Session {
    conn: RustConnection,
    root: Window,
    screen: usize,
    atoms: Atoms,
}

impl Session {
    fn connect() -> Result<Self, &'static str> {
        let display = std::env::var("DISPLAY").map_err(|_| UNAVAILABLE)?;
        if !(display.starts_with(':') || display.starts_with("unix:"))
            || std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| !kind.eq_ignore_ascii_case("x11"))
        {
            return Err(UNAVAILABLE);
        }

        let (conn, screen) = x11rb::connect(Some(&display)).map_err(|_| UNAVAILABLE)?;
        let root = conn.setup().roots[screen].root;
        let atoms = Atoms::new(&conn)
            .map_err(|_| UNAVAILABLE)?
            .reply()
            .map_err(|_| UNAVAILABLE)?;
        Ok(Self {
            conn,
            root,
            screen,
            atoms,
        })
    }

    fn target(&self, window: Window) -> Option<Target> {
        let conn = &self.conn;
        let attributes = conn.get_window_attributes(window).ok()?.reply().ok()?;
        if attributes.map_state != MapState::VIEWABLE || attributes.override_redirect {
            return None;
        }

        let geometry = conn.get_geometry(window).ok()?.reply().ok()?;
        if geometry.root != self.root || geometry.width == 0 || geometry.height == 0 {
            return None;
        }
        let position = conn
            .translate_coordinates(window, self.root, 0, 0)
            .ok()?
            .reply()
            .ok()?;
        if !position.same_screen {
            return None;
        }
        let pid_property = conn
            .get_property(
                false,
                window,
                self.atoms._NET_WM_PID,
                AtomEnum::CARDINAL,
                0,
                1,
            )
            .ok()?
            .reply()
            .ok()?;
        let pid = pid_property.value32()?.next().filter(|pid| *pid != 0)?;

        let class = conn
            .get_property(
                false,
                window,
                AtomEnum::WM_CLASS,
                AtomEnum::STRING,
                0,
                u32::MAX,
            )
            .ok()?
            .reply()
            .ok()?;
        let app = String::from_utf8_lossy(
            class
                .value
                .split(|byte| *byte == 0)
                .rfind(|name| !name.is_empty())?,
        )
        .into_owned();
        let title = self
            .name(window, self.atoms._NET_WM_NAME, self.atoms.UTF8_STRING)
            .or_else(|| self.name(window, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()))
            .unwrap_or_default();
        Some(Target {
            id: u64::from(window),
            pid,
            app,
            title,
            x: i32::from(position.dst_x),
            y: i32::from(position.dst_y),
            width: u32::from(geometry.width),
            height: u32::from(geometry.height),
        })
    }

    fn name(&self, window: Window, property: u32, kind: u32) -> Option<String> {
        let reply = self
            .conn
            .get_property(false, window, property, kind, 0, u32::MAX)
            .ok()?
            .reply()
            .ok()?;
        (reply.format == 8 && !reply.value.is_empty())
            .then(|| String::from_utf8_lossy(&reply.value).into_owned())
    }

    fn checked_target(&self, target: &Target) -> Result<Window, &'static str> {
        let id = Window::try_from(target.id).map_err(|_| STALE)?;
        let current = self.target(id).ok_or(STALE)?;
        if current.pid != target.pid
            || current.app != target.app
            || current.x != target.x
            || current.y != target.y
            || current.width != target.width
            || current.height != target.height
        {
            return Err(STALE);
        }
        Ok(id)
    }

    fn require_focus(&self, id: Window) -> Result<(), &'static str> {
        let focused = self
            .conn
            .get_input_focus()
            .map_err(|_| NOT_FOCUSED)?
            .reply()
            .map_err(|_| NOT_FOCUSED)?
            .focus;
        if self.is_inside(focused, id) {
            Ok(())
        } else {
            Err(NOT_FOCUSED)
        }
    }

    fn require_no_held_modifiers(&self) -> Result<(), &'static str> {
        let modifiers = self
            .conn
            .get_modifier_mapping()
            .map_err(|_| INPUT)?
            .reply()
            .map_err(|_| INPUT)?;
        let keymap = self
            .conn
            .query_keymap()
            .map_err(|_| INPUT)?
            .reply()
            .map_err(|_| INPUT)?;
        if modifiers
            .keycodes
            .iter()
            .copied()
            .filter(|code| *code != 0)
            .any(|code| keymap.keys[usize::from(code / 8)] & (1 << (code % 8)) != 0)
        {
            return Err(INPUT);
        }
        Ok(())
    }

    fn is_inside(&self, mut child: Window, id: Window) -> bool {
        while child != NONE && child != self.root {
            if child == id {
                return true;
            }
            let Some(tree) = self
                .conn
                .query_tree(child)
                .ok()
                .and_then(|cookie| cookie.reply().ok())
            else {
                return false;
            };
            child = tree.parent;
        }
        false
    }

    fn check_point(&self, id: Window, x: i16, y: i16) -> Result<(), &'static str> {
        let mut window = self.root;
        loop {
            let hit = self
                .conn
                .translate_coordinates(self.root, window, x, y)
                .map_err(|_| INPUT)?
                .reply()
                .map_err(|_| INPUT)?;
            if !hit.same_screen || hit.child == NONE {
                return Err(OBSCURED);
            }
            if hit.child == id {
                return Ok(());
            }
            window = hit.child;
        }
    }

    fn check_pointer(&self, id: Window, x: i16, y: i16) -> Result<(), &'static str> {
        let mut window = self.root;
        loop {
            let pointer = self
                .conn
                .query_pointer(window)
                .map_err(|_| INPUT)?
                .reply()
                .map_err(|_| INPUT)?;
            if !pointer.same_screen
                || pointer.root_x != x
                || pointer.root_y != y
                || pointer.child == NONE
            {
                return Err(OBSCURED);
            }
            if pointer.child == id {
                let buttons = KeyButMask::BUTTON1
                    | KeyButMask::BUTTON2
                    | KeyButMask::BUTTON3
                    | KeyButMask::BUTTON4
                    | KeyButMask::BUTTON5;
                if pointer.mask & buttons != 0u16.into() {
                    return Err(INPUT);
                }
                return Ok(());
            }
            window = pointer.child;
        }
    }

    fn pointer_action(
        &self,
        target: &Target,
        x: u32,
        y: u32,
        button: u8,
    ) -> Result<(), &'static str> {
        // Keep other clients from changing focus or stacking order between
        // the hit test and the synthetic button events.
        self.conn
            .grab_server()
            .map_err(|_| INPUT)?
            .check()
            .map_err(|_| INPUT)?;
        let result = self
            .checked_target(target)
            .and_then(|id| self.pointer_input(target, id, x, y, button));
        self.conn
            .ungrab_server()
            .map_err(|_| INPUT)?
            .check()
            .map_err(|_| INPUT)?;
        result
    }

    fn pointer_input(
        &self,
        target: &Target,
        id: Window,
        x: u32,
        y: u32,
        button: u8,
    ) -> Result<(), &'static str> {
        if x >= target.width || y >= target.height {
            return Err(OUTSIDE);
        }

        let x = i16::try_from(x).map_err(|_| OUTSIDE)?;
        let y = i16::try_from(y).map_err(|_| OUTSIDE)?;
        let hit = self
            .conn
            .translate_coordinates(id, self.root, x, y)
            .map_err(|_| INPUT)?
            .reply()
            .map_err(|_| INPUT)?;
        let screen = &self.conn.setup().roots[self.screen];
        if !hit.same_screen
            || hit.dst_x < 0
            || hit.dst_y < 0
            || hit.dst_x as u16 >= screen.width_in_pixels
            || hit.dst_y as u16 >= screen.height_in_pixels
        {
            return Err(OUTSIDE);
        }

        self.require_focus(id)?;
        self.check_point(id, hit.dst_x, hit.dst_y)?;
        self.conn
            .warp_pointer(NONE, id, 0, 0, 0, 0, x, y)
            .map_err(|_| INPUT)?
            .check()
            .map_err(|_| INPUT)?;
        self.require_focus(id)?;
        self.check_pointer(id, hit.dst_x, hit.dst_y)?;
        self.require_no_held_modifiers()?;
        self.fake_button(BUTTON_PRESS_EVENT, button)?;
        self.fake_button(BUTTON_RELEASE_EVENT, button)
    }

    fn fake_button(&self, event: u8, button: u8) -> Result<(), &'static str> {
        self.conn
            .xtest_fake_input(event, button, CURRENT_TIME, self.root, 0, 0, 0)
            .map_err(|_| INPUT)?
            .check()
            .map_err(|_| INPUT)
    }

    fn keyboard_input(&self, id: Window, action: &Action) -> Result<(), &'static str> {
        let mut keyboard = Enigo::new(&Settings::default()).map_err(|_| INPUT)?;
        self.require_focus(id)?;
        self.require_no_held_modifiers()?;
        match action {
            Action::Type { text } => {
                for character in text.chars() {
                    self.require_focus(id)?;
                    self.require_no_held_modifiers()?;
                    keyboard
                        .key(enigo::Key::Unicode(character), Direction::Click)
                        .map_err(|_| INPUT)?;
                }
                Ok(())
            }
            Action::Key { key } => keyboard
                .key(
                    match key {
                        Key::Enter => enigo::Key::Return,
                        Key::Escape => enigo::Key::Escape,
                        Key::Tab => enigo::Key::Tab,
                        Key::Backspace => enigo::Key::Backspace,
                        Key::Up => enigo::Key::UpArrow,
                        Key::Down => enigo::Key::DownArrow,
                        Key::Left => enigo::Key::LeftArrow,
                        Key::Right => enigo::Key::RightArrow,
                        Key::Home => enigo::Key::Home,
                        Key::End => enigo::Key::End,
                        Key::Space => enigo::Key::Space,
                    },
                    Direction::Click,
                )
                .map_err(|_| INPUT),
            _ => Err(INPUT),
        }
    }
}

pub(super) fn confirm(prompt: &str) -> bool {
    use gtk::prelude::*;

    if prompt.contains('\0') || gtk::init().is_err() {
        return false;
    }

    let dialog = gtk::Dialog::builder()
        .title("Nano Desktop · Computer Use")
        .modal(true)
        .default_width(560)
        .default_height(360)
        .build();
    let cancel = dialog.add_button("Cancel", gtk::ResponseType::Cancel);
    dialog.add_button("Allow", gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Cancel);

    let text = gtk::TextView::builder()
        .editable(false)
        .cursor_visible(false)
        .wrap_mode(gtk::WrapMode::WordChar)
        .left_margin(12)
        .right_margin(12)
        .top_margin(12)
        .bottom_margin(12)
        .build();
    let Some(buffer) = text.buffer() else {
        return false;
    };
    buffer.set_text(prompt);

    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vscrollbar_policy(gtk::PolicyType::Automatic)
        .build();
    scroll.add(&text);
    dialog.content_area().pack_start(&scroll, true, true, 0);
    dialog.show_all();
    cancel.grab_focus();
    let approved = dialog.run() == gtk::ResponseType::Accept;
    dialog.hide();
    dialog.close();
    approved
}

pub(super) fn available() -> bool {
    let Ok(session) = Session::connect() else {
        return false;
    };
    session
        .conn
        .xtest_get_version(2, 2)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some()
        && session
            .conn
            .composite_query_version(0, 4)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some_and(|version| version.major_version > 0 || version.minor_version >= 2)
}

pub(super) fn windows() -> Result<Vec<Target>, &'static str> {
    let session = Session::connect()?;
    let clients = session
        .conn
        .get_property(
            false,
            session.root,
            session.atoms._NET_CLIENT_LIST,
            AtomEnum::WINDOW,
            0,
            u32::MAX,
        )
        .map_err(|_| UNAVAILABLE)?
        .reply()
        .map_err(|_| UNAVAILABLE)?;
    let clients = clients.value32().ok_or(UNAVAILABLE)?;
    Ok(clients
        .filter_map(|window| session.target(window))
        .collect())
}

pub(super) fn perform(target: &Target, action: &Action) -> Result<(), &'static str> {
    let session = Session::connect()?;
    match action {
        Action::Click { x, y } => session.pointer_action(target, *x, *y, 1),
        Action::Scroll { x, y, lines } => {
            let button = if *lines < 0 { 4 } else { 5 };
            for _ in 0..lines.unsigned_abs() {
                session.pointer_action(target, *x, *y, button)?;
            }
            Ok(())
        }
        Action::Type { .. } | Action::Key { .. } => {
            session.keyboard_input(session.checked_target(target)?, action)
        }
    }
}

pub(super) fn capture(target: &Target) -> Result<Vec<u8>, &'static str> {
    let session = Session::connect()?;
    let id = session.checked_target(target)?;
    let conn = &session.conn;
    conn.composite_query_version(0, 4)
        .map_err(|_| SCREENSHOT)?
        .reply()
        .map_err(|_| SCREENSHOT)?;
    let attributes = conn
        .get_window_attributes(id)
        .map_err(|_| SCREENSHOT)?
        .reply()
        .map_err(|_| SCREENSHOT)?;
    let geometry = conn
        .get_geometry(id)
        .map_err(|_| SCREENSHOT)?
        .reply()
        .map_err(|_| SCREENSHOT)?;
    let pixmap = conn.generate_id().map_err(|_| SCREENSHOT)?;
    let name_pixmap = || {
        conn.composite_name_window_pixmap(id, pixmap)
            .map_err(|_| SCREENSHOT)?
            .check()
            .map_err(|_| SCREENSHOT)
    };
    // The named pixmap belongs to this window, including when another window
    // covers it. If the desktop has no compositor, redirect it on this connection.
    if name_pixmap().is_err() {
        conn.composite_redirect_window(id, Redirect::AUTOMATIC)
            .map_err(|_| SCREENSHOT)?
            .check()
            .map_err(|_| SCREENSHOT)?;
        name_pixmap()?;
    }

    let offset = i16::try_from(geometry.border_width).map_err(|_| SCREENSHOT)?;
    let image = conn
        .get_image(
            ImageFormat::Z_PIXMAP,
            pixmap,
            offset,
            offset,
            geometry.width,
            geometry.height,
            u32::MAX,
        )
        .map_err(|_| SCREENSHOT)?
        .reply()
        .map_err(|_| SCREENSHOT)?;
    encode_png(
        &session,
        attributes.visual,
        geometry.width,
        geometry.height,
        image,
    )
}

fn encode_png(
    session: &Session,
    visual_id: u32,
    width: u16,
    height: u16,
    image: GetImageReply,
) -> Result<Vec<u8>, &'static str> {
    let setup = session.conn.setup();
    let visual = setup.roots[session.screen]
        .allowed_depths
        .iter()
        .flat_map(|depth| &depth.visuals)
        .find(|visual| visual.visual_id == visual_id && visual.class == VisualClass::TRUE_COLOR)
        .ok_or(SCREENSHOT)?;
    let format = setup
        .pixmap_formats
        .iter()
        .find(|format| format.depth == image.depth)
        .ok_or(SCREENSHOT)?;
    let pixel_bytes = match format.bits_per_pixel {
        16 | 24 | 32 => usize::from(format.bits_per_pixel) / 8,
        _ => return Err(SCREENSHOT),
    };
    let width_usize = usize::from(width);
    let row_bytes = width_usize * pixel_bytes;
    let pad_bytes = usize::from(format.scanline_pad) / 8;
    if pad_bytes == 0 {
        return Err(SCREENSHOT);
    }
    let stride = row_bytes.div_ceil(pad_bytes) * pad_bytes;
    let needed = stride * usize::from(height);
    let input = image.data.get(..needed).ok_or(SCREENSHOT)?;

    let little_endian = setup.image_byte_order == ImageOrder::LSB_FIRST;
    let mut rgb = Vec::with_capacity(width_usize * usize::from(height) * 3);
    for row in input.chunks_exact(stride) {
        for pixel in row[..row_bytes].chunks_exact(pixel_bytes) {
            let mut word = [0; 4];
            let value = if little_endian {
                word[..pixel_bytes].copy_from_slice(pixel);
                u32::from_le_bytes(word)
            } else {
                word[4 - pixel_bytes..].copy_from_slice(pixel);
                u32::from_be_bytes(word)
            };
            rgb.extend([
                color_channel(value, visual.red_mask),
                color_channel(value, visual.green_mask),
                color_channel(value, visual.blue_mask),
            ]);
        }
    }

    let mut png = Vec::new();
    let mut encoder = png::Encoder::new(&mut png, u32::from(width), u32::from(height));
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|_| SCREENSHOT)?;
    writer.write_image_data(&rgb).map_err(|_| SCREENSHOT)?;
    writer.finish().map_err(|_| SCREENSHOT)?;
    Ok(png)
}

fn color_channel(value: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let maximum = u64::from(mask >> shift);
    let channel = u64::from((value & mask) >> shift);
    ((channel * 255 + maximum / 2) / maximum) as u8
}

#[cfg(test)]
mod tests {
    use super::color_channel;

    #[test]
    fn scales_true_color_masks_to_eight_bit_rgb() {
        assert_eq!(color_channel(0x00a5_0000, 0x00ff_0000), 0xa5);
        assert_eq!(color_channel(0x07e0, 0x07e0), 255);
        assert_eq!(color_channel(0x0400, 0x07e0), 130);
        assert_eq!(color_channel(0x001f, 0x001f), 255);
        assert_eq!(color_channel(0, 0x07e0), 0);
    }
}
