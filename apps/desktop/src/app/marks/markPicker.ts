import type { Mark, MarkColor, MarkShape } from './marks.svelte';

export const DEFAULT_COLOR: MarkColor = 'blue';

/** A curated set; each entry is one grapheme. */
export const MARK_EMOJI: readonly string[] = [
  '⭐', '🔥', '🚀', '💡', '🎯', '📌', '✅', '❤️',
  '🐞', '🔧', '🧪', '📝', '📦', '🔒', '🌱', '⚡',
  '🎨', '🧠', '🤖', '📚', '🏠', '💼', '🛠️', '🔍',
  '📈', '🎮', '🌍', '☁️', '🧩', '💬', '📅', '✨',
  '🍀', '🦊', '🐙', '🐳', '🧭', '🏁', '🚧', '❗',
  '❓', '💎', '🎵', '📷', '🧹', '🛡️', '🔔', '🎁',
];

/** The colour and shape the dialog opens on: those of a shape mark, else blue and no shape. */
export function startingChoice(current: Mark | undefined): { color: MarkColor; shape: MarkShape | undefined } {
  return current?.kind === 'shape' ? { color: current.color, shape: current.shape } : { color: DEFAULT_COLOR, shape: undefined };
}

/** A colour recolours a shape mark at once; otherwise it only waits for a shape. */
export function pickColor(current: Mark | undefined, color: MarkColor): { color: MarkColor; commit: Mark | undefined } {
  return { color, commit: current?.kind === 'shape' ? { kind: 'shape', shape: current.shape, color } : undefined };
}

export function pickShape(color: MarkColor, shape: MarkShape): Mark {
  return { kind: 'shape', shape, color };
}
