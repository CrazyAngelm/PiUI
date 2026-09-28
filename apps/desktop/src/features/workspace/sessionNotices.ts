/**
 * Non-fatal runtime notices of a session (additive v15: `SessionSnapshot.notices`
 * and the `notice` workspace event, bridge CONTRACT.md "hostTools"). Read
 * defensively: an older host sends neither, and unknown codes are ignored.
 */
import type { HarnessKind, SessionSnapshot } from '../../../../../contracts/workspace-v15';

export const SESSION_NOTICE_CODES = ['unsupported-board-tool', 'unsupported-board-tool-resume'] as const;
export type SessionNoticeCode = (typeof SESSION_NOTICE_CODES)[number];

export interface SessionNoticeEvent {
  type: 'notice';
  code: string;
}

const known = (value: unknown): value is SessionNoticeCode =>
  typeof value === 'string' && (SESSION_NOTICE_CODES as readonly string[]).includes(value);

export function isNoticeEvent(event: { type: string }): event is SessionNoticeEvent {
  return event.type === 'notice' && typeof (event as { code?: unknown }).code === 'string';
}

/** Known notice codes of a snapshot, without duplicates. */
export function sessionNotices(snapshot: SessionSnapshot | undefined): SessionNoticeCode[] {
  const value = (snapshot as { notices?: unknown } | undefined)?.notices;
  return Array.isArray(value) ? [...new Set(value.filter(known))] : [];
}

/** The snapshot with one more notice (unknown codes are kept for a newer UI). */
export function withNotice(snapshot: SessionSnapshot, code: string): SessionSnapshot {
  const current = (snapshot as { notices?: unknown }).notices;
  const notices = Array.isArray(current) ? current.filter((item): item is string => typeof item === 'string') : [];
  if (notices.includes(code)) return snapshot;
  return { ...snapshot, notices: [...notices, code] } as SessionSnapshot;
}

/**
 * The board-tool notice to show for a chat. A Pi chat never gets the tool
 * (Pi RPC has no custom tools), so it shows before the host reports it.
 */
export function boardToolNotice(harness: HarnessKind, notices: readonly SessionNoticeCode[]): SessionNoticeCode | undefined {
  if (notices.includes('unsupported-board-tool-resume')) return 'unsupported-board-tool-resume';
  if (notices.includes('unsupported-board-tool') || harness === 'pi') return 'unsupported-board-tool';
  return undefined;
}
