//! Theme contributions: a whitelist of semantic color tokens, a strict color
//! grammar (hex or `rgb()`/`rgba()`, never `url()`, `var()` or expressions)
//! and WCAG contrast checks for the pairs a theme overrides together.

/// Color tokens a theme may override (`--piui-<name>`): the color scale of
/// `apps/desktop/src/styles/tokens.css`. Kept equal to the schema enum and
/// `PLUGIN_THEME_TOKENS` in `contracts/piui-plugin-v1.ts` by tests.
pub const THEME_TOKENS: &[&str] = &[
    "bg",
    "bg-raised",
    "bg-sunken",
    "surface-1",
    "surface-2",
    "surface-3",
    "overlay",
    "hover",
    "pressed",
    "selected",
    "selected-strong",
    "text",
    "text-muted",
    "text-faint",
    "text-disabled",
    "border",
    "border-subtle",
    "border-strong",
    "accent",
    "accent-ink",
    "accent-soft",
    "action",
    "action-hover",
    "action-pressed",
    "action-ink",
    "focus",
    "danger",
    "warning",
    "success",
    "info",
    "danger-surface",
    "danger-border",
    "danger-text",
    "warning-surface",
    "warning-border",
    "warning-text",
    "success-surface",
    "success-border",
    "success-text",
    "info-surface",
    "info-border",
    "info-text",
    "user-surface",
    "user-border",
    "code-surface",
    "syntax-keyword",
    "syntax-string",
    "syntax-number",
    "syntax-comment",
    "syntax-function",
    "syntax-type",
    "syntax-property",
    "syntax-punctuation",
    "diff-add",
    "diff-add-text",
    "diff-remove",
    "diff-remove-text",
];

/// Text/background pairs checked when a theme overrides both tokens, with
/// the minimum WCAG contrast ratio.
pub const CONTRAST_PAIRS: &[(&str, &str, f64)] = &[
    ("text", "bg", 4.5),
    ("text", "surface-1", 4.5),
    ("text-muted", "bg", 4.5),
    ("action-ink", "action", 4.5),
    ("accent-ink", "accent", 4.5),
];

/// An sRGB color with alpha in `0.0..=1.0`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
    pub alpha: f64,
}

/// Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` or
/// `rgba(r, g, b, a)` with channels 0-255 and alpha 0-1.
#[must_use]
pub fn parse_color(text: &str) -> Option<Rgba> {
    if text.len() > 40 {
        return None;
    }
    if let Some(hex) = text.strip_prefix('#') {
        return parse_hex(hex);
    }
    let (inner, with_alpha) = if let Some(rest) = text.strip_prefix("rgba(") {
        (rest.strip_suffix(')')?, true)
    } else {
        (text.strip_prefix("rgb(")?.strip_suffix(')')?, false)
    };
    let parts = inner.split(',').map(str::trim).collect::<Vec<_>>();
    if parts.len() != 3 && parts.len() != 4 {
        return None;
    }
    if !with_alpha && parts.len() == 4 {
        // `rgb()` with an alpha is accepted by browsers; keep one spelling.
        return None;
    }
    let channel = |value: &str| -> Option<u8> {
        if value.is_empty() || value.len() > 3 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        value
            .parse::<u16>()
            .ok()
            .and_then(|value| u8::try_from(value).ok())
    };
    let alpha = match parts.get(3) {
        None => 1.0,
        Some(value) => parse_alpha(value)?,
    };
    Some(Rgba {
        red: channel(parts[0])?,
        green: channel(parts[1])?,
        blue: channel(parts[2])?,
        alpha,
    })
}

fn parse_alpha(value: &str) -> Option<f64> {
    let valid = match value {
        "0" | "1" => true,
        _ => {
            let fraction = value.strip_prefix('0').unwrap_or(value);
            fraction.strip_prefix('.').is_some_and(|digits| {
                !digits.is_empty()
                    && digits.len() <= 3
                    && digits.bytes().all(|byte| byte.is_ascii_digit())
            })
        }
    };
    if !valid {
        return None;
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|alpha| (0.0..=1.0).contains(alpha))
}

fn parse_hex(hex: &str) -> Option<Rgba> {
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let digit = |index: usize| u8::from_str_radix(hex.get(index..=index)?, 16).ok();
    let pair = |index: usize| u8::from_str_radix(hex.get(index..index + 2)?, 16).ok();
    match hex.len() {
        3 | 4 => Some(Rgba {
            red: digit(0)? * 17,
            green: digit(1)? * 17,
            blue: digit(2)? * 17,
            alpha: if hex.len() == 4 {
                f64::from(digit(3)? * 17) / 255.0
            } else {
                1.0
            },
        }),
        6 | 8 => Some(Rgba {
            red: pair(0)?,
            green: pair(2)?,
            blue: pair(4)?,
            alpha: if hex.len() == 8 {
                f64::from(pair(6)?) / 255.0
            } else {
                1.0
            },
        }),
        _ => None,
    }
}

fn linear(channel: u8) -> f64 {
    let value = f64::from(channel) / 255.0;
    if value <= 0.039_28 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

fn luminance(color: Rgba) -> f64 {
    0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
}

/// Blends `top` over an opaque `bottom`.
fn over(top: Rgba, bottom: Rgba) -> Rgba {
    let mix = |upper: u8, lower: u8| -> u8 {
        let value = f64::from(upper) * top.alpha + f64::from(lower) * (1.0 - top.alpha);
        // Bounded to 0..=255 by construction.
        value.round().clamp(0.0, 255.0) as u8
    };
    Rgba {
        red: mix(top.red, bottom.red),
        green: mix(top.green, bottom.green),
        blue: mix(top.blue, bottom.blue),
        alpha: 1.0,
    }
}

/// WCAG contrast ratio of `foreground` on `background`. A translucent
/// background is judged over black and white and the worse result counts.
#[must_use]
pub fn contrast_ratio(foreground: Rgba, background: Rgba) -> f64 {
    let backdrops = if background.alpha < 1.0 {
        vec![
            over(
                background,
                Rgba {
                    red: 0,
                    green: 0,
                    blue: 0,
                    alpha: 1.0,
                },
            ),
            over(
                background,
                Rgba {
                    red: 255,
                    green: 255,
                    blue: 255,
                    alpha: 1.0,
                },
            ),
        ]
    } else {
        vec![background]
    };
    backdrops
        .into_iter()
        .map(|backdrop| {
            let text = over(foreground, backdrop);
            let (light, dark) = {
                let (a, b) = (luminance(text), luminance(backdrop));
                if a > b { (a, b) } else { (b, a) }
            };
            (light + 0.05) / (dark + 0.05)
        })
        .fold(f64::INFINITY, f64::min)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_parse_only_the_documented_grammar() {
        assert_eq!(
            parse_color("#fff"),
            Some(Rgba {
                red: 255,
                green: 255,
                blue: 255,
                alpha: 1.0
            })
        );
        assert_eq!(parse_color("#10111480").map(|color| color.red), Some(0x10));
        assert!(
            parse_color("rgba(8, 7, 9, 0.62)")
                .is_some_and(|color| (color.alpha - 0.62).abs() < 1e-9)
        );
        assert!(parse_color("rgb(1,2,3)").is_some());
        for invalid in [
            "red",
            "#ggg",
            "#12345",
            "rgb(256, 0, 0)",
            "rgb(1, 2)",
            "rgb(1, 2, 3, 0.5)",
            "rgba(1, 2, 3, 1.5)",
            "rgba(1, 2, 3, .1234)",
            "url(x)",
            "var(--piui-bg)",
            "#fff;background:url(x)",
            "hsl(0, 0%, 0%)",
        ] {
            assert!(parse_color(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn contrast_matches_wcag_reference_values() {
        let black = parse_color("#000").expect("black");
        let white = parse_color("#fff").expect("white");
        assert!((contrast_ratio(black, white) - 21.0).abs() < 0.01);
        assert!((contrast_ratio(white, white) - 1.0).abs() < 0.01);
        let dark_text = parse_color("#eee9ed").expect("text");
        let dark_bg = parse_color("#131214").expect("bg");
        assert!(contrast_ratio(dark_text, dark_bg) > 4.5);
        let low = parse_color("#555").expect("grey");
        assert!(contrast_ratio(low, parse_color("#666").expect("grey")) < 4.5);
    }
}
