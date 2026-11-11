/**
 * Color values of plugin themes. They live apart from the manifest rules so
 * the theme check at startup does not load the manifest schema validators.
 */
export interface Rgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` or `rgba(r, g, b, a)`. */
export function parseColor(text: string): Rgba | undefined {
  if (text.length > 40) return undefined;
  const hex = /^#([0-9A-Fa-f]+)$/.exec(text)?.[1];
  if (hex !== undefined) {
    const digit = (index: number) => parseInt(hex[index] ?? '0', 16) * 17;
    const pair = (index: number) => parseInt(hex.slice(index, index + 2), 16);
    if (hex.length === 3 || hex.length === 4) return { red: digit(0), green: digit(1), blue: digit(2), alpha: hex.length === 4 ? digit(3) / 255 : 1 };
    if (hex.length === 6 || hex.length === 8) return { red: pair(0), green: pair(2), blue: pair(4), alpha: hex.length === 8 ? pair(6) / 255 : 1 };
    return undefined;
  }
  const match = /^(rgba?)\((.*)\)$/.exec(text);
  if (!match) return undefined;
  const parts = (match[2] ?? '').split(',').map((part) => part.trim());
  if (match[1] === 'rgb' ? parts.length !== 3 : parts.length !== 3 && parts.length !== 4) return undefined;
  const channels = parts.slice(0, 3).map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (channels.some((value) => !(value >= 0 && value <= 255))) return undefined;
  let alpha = 1;
  if (parts[3] !== undefined) {
    if (!/^(?:0|1|0?\.\d{1,3})$/.test(parts[3])) return undefined;
    alpha = Number(parts[3]);
  }
  return { red: channels[0] ?? 0, green: channels[1] ?? 0, blue: channels[2] ?? 0, alpha };
}
