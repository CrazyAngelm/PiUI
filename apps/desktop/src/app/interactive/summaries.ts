import { get } from 'svelte/store';
import { t } from '../../features/locale/language';

/**
 * A `hermes-ui` block is live only in the chat transcript. Everywhere else (copied text, search,
 * short previews) one line with its title is more useful than its JSON. Port of the web app's
 * `HermesIntelligentUiBlocks.ReplaceWithSummaries`.
 */

// The fence closes on a line of three or more backticks; a block that is still streaming (or was
// cut off) runs to the end of the text, as in Markdown.
const BLOCK = /^[ \t]{0,3}```hermes-ui[^\n]*\n([\s\S]*?)(?:^[ \t]{0,3}`{3,}[ \t]*\r?$|(?![\s\S]))/gim;
const TITLE_FIELD = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const MAX_TITLE = 120;

export const hasInteractiveBlock = (text: string | null | undefined): boolean => typeof text === 'string' && /```hermes-ui/i.test(text);

function unescapeJsonString(raw: string): string {
  try {
    const value: unknown = JSON.parse(`"${raw}"`);
    return typeof value === 'string' ? value : raw;
  } catch {
    // A cut-off block may carry an escape JSON does not know (\d): keep it as written.
    return raw;
  }
}

function titleOf(json: string): string | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const title = (value as Record<string, unknown>).title;
      return typeof title === 'string' ? title : undefined;
    }
    return undefined;
  } catch {
    // Not finished yet: the title is often already there.
    const match = TITLE_FIELD.exec(json);
    return match?.[1] === undefined ? undefined : unescapeJsonString(match[1]);
  }
}

/** "Interactive block: Rent calculator", or just the label for a block without a title. */
export function describeInteractiveBlock(json: string, label: string): string {
  const title = titleOf(json)?.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE).trimEnd();
  return title ? `${label}: ${title}` : label;
}

export interface SummaryOptions {
  /** The block's name; the app's translation of "Interactive block" by default. */
  label?: string;
  /** Wraps each summary (for example into Markdown emphasis); none by default. */
  format?: (summary: string) => string;
}

/** The text with every `hermes-ui` block replaced by its one-line summary. Other text is untouched. */
export function summarizeInteractiveBlocks(text: string, options: SummaryOptions = {}): string {
  if (!hasInteractiveBlock(text)) return text;
  const label = options.label ?? get(t)('Interactive block');
  return text.replace(BLOCK, (_match, body: string) => {
    const summary = describeInteractiveBlock(body, label);
    return options.format === undefined ? summary : options.format(summary);
  });
}
