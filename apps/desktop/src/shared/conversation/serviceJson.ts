/**
 * Some models print a tool call's arguments as assistant text (`{"id":1,"timeoutMs":20000}`).
 * Such a message carries no prose for the reader: the chat folds it into a closed
 * "Service data" row instead of showing raw JSON. Anything that is not a JSON
 * object by itself (prose, a fenced block, an array of items) is left as it is.
 */
export function isServiceJson(text: string | undefined, streaming = false): boolean {
  const value = text?.trim();
  if (!value || value[0] !== '{') return false;
  if (value.endsWith('}')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }
  // Mid-stream the object is not closed yet; a `{"key":` start is still arguments, not prose.
  return streaming && /^\{\s*"[^"\n]{1,40}"\s*:/.test(value);
}
