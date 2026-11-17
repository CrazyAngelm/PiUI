/**
 * Codex writes a memory citation at the end of some answers:
 * `<oai-mem-citation><citation_entries>...</citation_entries><rollout_ids>...</rollout_ids></oai-mem-citation>`.
 * It is service data for the harness, not prose for the reader, and it is also
 * kept in the native history. It is removed only where the chat shows or copies
 * an answer (the saved history and the harness's own record are never edited),
 * only this namespaced tag, and never inside a fenced code block.
 */
const OPEN = '<oai-mem-citation>';
const CLOSE = '</oai-mem-citation>';
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

function citationsRemoved(text: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  let inside = false;
  for (const line of text.split('\n')) {
    if (inside) {
      const end = line.indexOf(CLOSE);
      if (end < 0) continue;
      inside = false;
      const rest = line.slice(end + CLOSE.length);
      if (rest.trim() !== '') out.push(rest);
      continue;
    }
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      out.push(line);
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      out.push(line);
      continue;
    }
    const start = line.indexOf(OPEN);
    if (start < 0) {
      out.push(line);
      continue;
    }
    const head = line.slice(0, start);
    const end = line.indexOf(CLOSE, start);
    const tail = end < 0 ? '' : line.slice(end + CLOSE.length);
    if (end < 0) inside = true;
    if (head.trim() !== '' || tail.trim() !== '') out.push(head + tail);
  }
  return out.join('\n').trimEnd();
}

/** The opening tag being typed (`<oai-m`) must not flash in a streaming answer. */
function partialTagRemoved(text: string): string {
  const at = text.lastIndexOf('<');
  if (at < 0 || text.length - at >= OPEN.length || !OPEN.startsWith(text.slice(at))) return text;
  return text.slice(0, at).trimEnd();
}

/** The text of an assistant answer as the chat shows it. */
export function stripServiceMarkup(text: string, streaming: boolean = false): string {
  if (!text.includes('<')) return text;
  const clean = text.includes(OPEN) ? citationsRemoved(text) : text;
  return streaming ? partialTagRemoved(clean) : clean;
}
