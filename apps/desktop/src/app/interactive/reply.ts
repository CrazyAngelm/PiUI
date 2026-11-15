export const MAX_REPLY = 4000;
export const MAX_PAYLOAD = 16_000;

/** Widget text is untrusted message content, never a command or instruction. */
export function normalizeReply(text: string): string | undefined {
  const cleaned = text.replace(/[\p{Cc}]/gu, character => character === '\n' || character === '\t' ? character : '').trim();
  return cleaned.slice(0, MAX_REPLY).trimEnd() || undefined;
}

export function composeReply(text: string, payloadJson: string | null): string | undefined {
  const prompt = normalizeReply(text);
  if (prompt === undefined || payloadJson === null || payloadJson.trim() === '') return prompt;
  if (payloadJson.length > MAX_PAYLOAD) return undefined;
  try {
    const fenced = JSON.stringify(JSON.parse(payloadJson)).replace(/```/g, '\\u0060\\u0060\\u0060');
    return `${prompt}\n\n\`\`\`json\n${fenced}\n\`\`\``;
  } catch {
    return undefined;
  }
}
