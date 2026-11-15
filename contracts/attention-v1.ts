/**
 * Attention v1 (ADR-065): the taskbar badge and the taskbar flash that tell a
 * person a chat finished its turn or needs an answer.
 *
 * Local only: the WebView decides what needs attention (from its own session
 * list) and reports the number; the host draws it. Nothing is sent over the
 * network and no OS notification centre entry is created. Safe mode works the
 * same, because nothing here starts an agent.
 *
 * Command: `attention_set_v1` ({ request: AttentionSetRequestV1 } -> null).
 * The request rejects unknown fields. Failures reject with
 * `{ code: AttentionErrorCodeV1 }`.
 *
 * - Windows shows a red circle with the number (an overlay icon on the taskbar
 *   button; "9+" from ten up). macOS and Linux use the platform badge count.
 *   `count` 0 removes the badge. The host caps `count` at 9999.
 * - `flash` asks the OS to flash the taskbar button once, and only while the
 *   main window is not focused.
 */
export const ATTENTION_PROTOCOL = 1 as const;

/** The largest count the host accepts; a greater one is capped. */
export const ATTENTION_MAX_COUNT = 9999;

export interface AttentionSetRequestV1 {
  /** Chats waiting to be seen; 0 removes the badge. */
  readonly count: number;
  /** Flash the taskbar button (ignored while the window is focused). */
  readonly flash: boolean;
}

export type AttentionErrorCodeV1 = 'unavailable' | 'failed';
