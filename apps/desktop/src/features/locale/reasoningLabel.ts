/**
 * The one place that turns a native reasoning level into text. Every screen that
 * names a level (the slider, the composer chip, the pipeline inspector, the cards)
 * goes through `reasoningLabel`, so a level reads the same everywhere and
 * `xhigh` and `max` are never shown as "High".
 *
 * The harness owns the ids; this only names the ones Pi, Codex, Claude Code and
 * Prime report. An id it does not know is shown as the harness wrote it.
 */

/** A `$t`-style lookup: the Russian copy for a key, or the key itself. */
export type Translate = (value: string) => string;

/**
 * English names by native level id. The Russian catalog (`ru/reasoning.ts`) is
 * keyed by `reasoning:<id>` rather than by these words or the bare id: "High" and
 * "Medium" already belong to other settings, and a bare `none` is another
 * screen's "нет".
 */
const LEVEL_NAMES: Readonly<Record<string, string>> = {
  off: 'Off',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

/** Prefix of the Russian catalog keys. */
export const CATALOG_PREFIX = 'reasoning:';

/** Native ids with a name of their own, lowest first. */
export const KNOWN_REASONING_LEVELS: readonly string[] = Object.keys(LEVEL_NAMES);

/**
 * The visible name of a native level. '' is the harness default ("Auto"). A
 * level the catalog knows is translated; otherwise the English name, then the id.
 */
export function reasoningLabel(level: string, t: Translate): string {
  if (level === '') return t('Auto');
  const key = `${CATALOG_PREFIX}${level}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return Object.hasOwn(LEVEL_NAMES, level) ? (LEVEL_NAMES[level] as string) : level;
}
