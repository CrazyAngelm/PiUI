//! Attention (contract `attention-v1`, ADR-065): a red numbered badge on the
//! taskbar button, and an optional flash, when a chat needs a person.
//!
//! The WebView decides what needs attention and reports a count; this module
//! only draws it. Nothing here starts an agent, touches the network or creates
//! an OS notification, so it behaves the same in safe mode. Windows has no
//! badge count, so the badge is an overlay icon drawn from a built-in bitmap
//! font; macOS and Linux use the platform badge count.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, UserAttentionType, WebviewWindow};

const MAIN_WINDOW: &str = "main";
/// The largest count accepted; a greater one is capped.
pub const MAX_COUNT: u32 = 9999;

/// Overlay icon edge in pixels; Windows scales it to the taskbar.
const ICON_SIZE: u32 = 32;
/// #E5484D, the shared danger red.
const BADGE_RED: [u8; 4] = [0xE5, 0x48, 0x4D, 0xFF];
const WHITE: [u8; 4] = [0xFF, 0xFF, 0xFF, 0xFF];
const GLYPH_COLUMNS: u32 = 5;
const GLYPH_ROWS: u32 = 7;
/// Glyph scale for one character and for the two characters of "9+".
const SINGLE_SCALE: u32 = 3;
const DOUBLE_SCALE: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttentionRequestV1 {
    pub count: u32,
    pub flash: bool,
}

impl AttentionRequestV1 {
    /// The count the host shows: never above [`MAX_COUNT`].
    pub fn capped_count(&self) -> u32 {
        self.count.min(MAX_COUNT)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "kebab-case")]
pub enum AttentionError {
    /// There is no main window to draw on.
    Unavailable,
    /// The OS refused the change.
    Failed,
}

/// Seven rows of five bits per glyph; the most significant of the five bits is
/// the left column.
fn glyph(character: char) -> [u8; GLYPH_ROWS as usize] {
    match character {
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
        ],
        '6' => [
            0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
        ],
        '+' => [
            0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000,
        ],
        _ => [0; GLYPH_ROWS as usize],
    }
}

/// The text on the badge: the digit up to 9, and "9+" from ten up.
fn badge_label(count: u32) -> &'static str {
    match count {
        0 => "0",
        1 => "1",
        2 => "2",
        3 => "3",
        4 => "4",
        5 => "5",
        6 => "6",
        7 => "7",
        8 => "8",
        9 => "9",
        _ => "9+",
    }
}

fn put(rgba: &mut [u8], x: u32, y: u32, color: [u8; 4]) {
    let at = ((y * ICON_SIZE + x) * 4) as usize;
    if let Some(pixel) = rgba.get_mut(at..at + 4) {
        pixel.copy_from_slice(&color);
    }
}

/// The overlay icon for a count: a 32x32 RGBA red circle with the count in
/// white, as `(pixels, width, height)`. The circle edge is anti-aliased
/// through its alpha; the corners stay transparent.
pub fn badge_rgba(count: u32) -> (Vec<u8>, u32, u32) {
    let mut rgba = vec![0_u8; (ICON_SIZE * ICON_SIZE * 4) as usize];
    let radius = ICON_SIZE as f32 / 2.0;
    for y in 0..ICON_SIZE {
        for x in 0..ICON_SIZE {
            let dx = x as f32 + 0.5 - radius;
            let dy = y as f32 + 0.5 - radius;
            let coverage = (radius + 0.5 - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0);
            if coverage > 0.0 {
                let mut color = BADGE_RED;
                color[3] = (coverage * 255.0).round() as u8;
                put(&mut rgba, x, y, color);
            }
        }
    }

    let label = badge_label(count);
    let characters = label.chars().count() as u32;
    let scale = if characters == 1 {
        SINGLE_SCALE
    } else {
        DOUBLE_SCALE
    };
    // One blank column between characters.
    let columns = characters * GLYPH_COLUMNS + (characters - 1);
    let left = (ICON_SIZE - columns * scale) / 2;
    let top = (ICON_SIZE - GLYPH_ROWS * scale) / 2;
    for (index, character) in label.chars().enumerate() {
        let origin = left + index as u32 * (GLYPH_COLUMNS + 1) * scale;
        for (row, bits) in glyph(character).into_iter().enumerate() {
            for column in 0..GLYPH_COLUMNS {
                if (bits >> (GLYPH_COLUMNS - 1 - column)) & 1 == 0 {
                    continue;
                }
                for step_y in 0..scale {
                    for step_x in 0..scale {
                        put(
                            &mut rgba,
                            origin + column * scale + step_x,
                            top + row as u32 * scale + step_y,
                            WHITE,
                        );
                    }
                }
            }
        }
    }
    (rgba, ICON_SIZE, ICON_SIZE)
}

#[cfg(windows)]
fn set_badge<R: Runtime>(window: &WebviewWindow<R>, count: u32) -> Result<(), AttentionError> {
    let icon = (count > 0).then(|| {
        let (rgba, width, height) = badge_rgba(count);
        tauri::image::Image::new_owned(rgba, width, height)
    });
    window
        .set_overlay_icon(icon)
        .map_err(|_| AttentionError::Failed)
}

#[cfg(not(windows))]
fn set_badge<R: Runtime>(window: &WebviewWindow<R>, count: u32) -> Result<(), AttentionError> {
    window
        .set_badge_count((count > 0).then_some(i64::from(count)))
        .map_err(|_| AttentionError::Failed)
}

fn apply<R: Runtime>(
    app: &AppHandle<R>,
    request: AttentionRequestV1,
) -> Result<(), AttentionError> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or(AttentionError::Unavailable)?;
    set_badge(&window, request.capped_count())?;
    // A focused window needs no flash; an unreadable focus state counts as focused.
    if request.flash && !window.is_focused().unwrap_or(true) {
        window
            .request_user_attention(Some(UserAttentionType::Informational))
            .map_err(|_| AttentionError::Failed)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn attention_set_v1(
    app: AppHandle,
    request: AttentionRequestV1,
) -> Result<(), AttentionError> {
    apply(&app, request)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(rgba: &[u8], x: u32, y: u32) -> [u8; 4] {
        let at = ((y * ICON_SIZE + x) * 4) as usize;
        [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]]
    }

    fn white_pixels(rgba: &[u8]) -> usize {
        rgba.chunks_exact(4).filter(|p| *p == WHITE).count()
    }

    #[test]
    fn the_icon_is_32_by_32_rgba() {
        let (rgba, width, height) = badge_rgba(1);
        assert_eq!((width, height), (32, 32));
        assert_eq!(rgba.len(), 32 * 32 * 4);
    }

    #[test]
    fn corners_are_transparent_and_the_ring_is_red() {
        let (rgba, _, _) = badge_rgba(3);
        for (x, y) in [(0, 0), (31, 0), (0, 31), (31, 31)] {
            assert_eq!(pixel(&rgba, x, y)[3], 0, "corner {x},{y}");
        }
        // Inside the circle and outside the glyph: the badge red, fully opaque.
        assert_eq!(pixel(&rgba, 2, 16), BADGE_RED);
        assert_eq!(pixel(&rgba, 16, 2), BADGE_RED);
        // The edge is anti-aliased: partly transparent red, never another hue.
        let edge = pixel(&rgba, 4, 4);
        assert_eq!(edge[..3], BADGE_RED[..3]);
        assert!(edge[3] > 0 && edge[3] < 255, "edge alpha {}", edge[3]);
    }

    #[test]
    fn every_count_draws_white_text() {
        for count in [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99] {
            let (rgba, _, _) = badge_rgba(count);
            assert!(white_pixels(&rgba) > 0, "count {count}");
        }
    }

    #[test]
    fn ten_and_above_read_nine_plus() {
        assert_eq!(badge_label(1), "1");
        assert_eq!(badge_label(9), "9");
        assert_eq!(badge_label(10), "9+");
        assert_eq!(badge_label(MAX_COUNT), "9+");
        let nine_plus = badge_rgba(10);
        assert_eq!(nine_plus, badge_rgba(11));
        assert_eq!(nine_plus, badge_rgba(MAX_COUNT));
        assert_ne!(nine_plus.0, badge_rgba(9).0);
    }

    #[test]
    fn different_digits_look_different() {
        assert_ne!(badge_rgba(1).0, badge_rgba(2).0);
    }

    #[test]
    fn the_text_stays_inside_the_circle() {
        for count in [1, 8, 9, 10] {
            let (rgba, _, _) = badge_rgba(count);
            for y in 0..ICON_SIZE {
                for x in 0..ICON_SIZE {
                    if pixel(&rgba, x, y) == WHITE {
                        let dx = x as f32 + 0.5 - 16.0;
                        let dy = y as f32 + 0.5 - 16.0;
                        assert!(
                            (dx * dx + dy * dy).sqrt() < 15.0,
                            "count {count} at {x},{y}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_request_is_camel_case_and_refuses_unknown_fields() {
        let request: AttentionRequestV1 =
            serde_json::from_value(serde_json::json!({"count": 2, "flash": true})).expect("valid");
        assert_eq!(
            request,
            AttentionRequestV1 {
                count: 2,
                flash: true
            }
        );
        assert!(
            serde_json::from_value::<AttentionRequestV1>(
                serde_json::json!({"count": 2, "flash": true, "sound": true})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<AttentionRequestV1>(serde_json::json!({"count": 2})).is_err()
        );
        assert!(
            serde_json::from_value::<AttentionRequestV1>(
                serde_json::json!({"count": -1, "flash": false})
            )
            .is_err()
        );
    }

    #[test]
    fn the_count_is_capped() {
        let request = |count| AttentionRequestV1 {
            count,
            flash: false,
        };
        assert_eq!(request(0).capped_count(), 0);
        assert_eq!(request(7).capped_count(), 7);
        assert_eq!(request(MAX_COUNT + 1).capped_count(), MAX_COUNT);
        assert_eq!(request(u32::MAX).capped_count(), MAX_COUNT);
    }

    #[test]
    fn errors_carry_a_kebab_case_code() {
        assert_eq!(
            serde_json::to_value(AttentionError::Unavailable).expect("encodes"),
            serde_json::json!({"code": "unavailable"})
        );
        assert_eq!(
            serde_json::to_value(AttentionError::Failed).expect("encodes"),
            serde_json::json!({"code": "failed"})
        );
    }
}
