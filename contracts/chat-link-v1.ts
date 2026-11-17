/**
 * Nano Desktop chat links v1 (ADR-075): opening an `http` or `https` link of a
 * chat message in the system browser.
 *
 * The WebView supplies the address, so the host never opens it on that say-so.
 * It parses the address again, accepts only `http` and `https` with a host, no
 * user name or password, at most `CHAT_LINK_MAX_BYTES` bytes and no whitespace
 * or control character, refuses safe mode, and then asks the person in a
 * native dialog (not WebView content) that shows the exact address the browser
 * would receive. Only a Yes opens it. One dialog is open at a time. The address
 * is never logged. Unknown request fields are rejected.
 */
export const CHAT_LINK_ROUTE = 'chat_open_link_v1';
export const CHAT_LINK_MAX_BYTES = 2048;

/** Arguments of the route: `{ request }`. */
export interface ChatOpenLinkRequestV1 {
  url: string;
  /** Wording of the question (`ru`; anything else is English). Nothing else depends on it. */
  language?: 'en' | 'ru';
}

export interface ChatOpenLinkResultV1 {
  /** `false` when the person answered No. */
  opened: boolean;
}

export type ChatLinkErrorCode =
  /** Not an openable web address. */
  | 'INVALID_LINK'
  | 'SAFE_MODE'
  /** A confirmation is already on screen. */
  | 'BUSY'
  /** The person said Yes and the system browser could not be started or reported a failure (the page then copies the address). */
  | 'OPEN_FAILED';
