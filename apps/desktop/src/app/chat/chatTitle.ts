/** The longest name a chat takes from a message. */
export const CHAT_TITLE_LIMIT = 80;

/**
 * The name a new chat takes from its first message: the first line that has
 * words, as one line of at most 80 characters. It is the text as typed, so a
 * macro or a command stays what the person wrote. Empty when there are no
 * words; the host then names the chat after its agent.
 */
export function chatTitle(text: string): string {
  for (const raw of text.split(/\r?\n/u)) {
    // The host refuses a title with a control character.
    const line = raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!line) continue;
    const characters = [...line];
    if (characters.length <= CHAT_TITLE_LIMIT) return line;
    return `${characters.slice(0, CHAT_TITLE_LIMIT - 1).join('').trimEnd()}…`;
  }
  return '';
}
