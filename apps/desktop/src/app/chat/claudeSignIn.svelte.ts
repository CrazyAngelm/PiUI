import type { HarnessSummary } from '../../../../../contracts/workspace-v15';
import { WorkspaceOperationError } from '../../host-api/workspaceClient';

/**
 * Claude Code sign-in state for the new-chat composer (ADR-029). PiUI never
 * reads credentials: the host's cached verdict is the catalog `reason` it
 * reports after a start or catalog check was refused for a missing Claude
 * subscription login. A check is a catalog-only `initialize` of the user's own
 * `claude` CLI; it never starts a conversation or a model turn.
 */

/** The host's fixed sign-in guidance, reported as the Claude Code catalog reason. */
export const CLAUDE_SIGN_IN_REASON = 'Sign in to Claude Code with your Claude subscription: run `claude` in a terminal and use /login.';

/** Composer copy with `{0}` = the `claude` command and `{1}` = `/login`. */
export const SIGNED_OUT_COPY = 'Not signed in — run {0} in a terminal and use {1}.';

/** The last verdict the host cached: known signed out, or not known to be. */
export function cachedSignedOut(harnesses: readonly HarnessSummary[]): boolean {
  return harnesses.some((summary) => summary.kind === 'claude-code' && summary.reason === CLAUDE_SIGN_IN_REASON);
}

export type SignInVerdict = 'signed-in' | 'signed-out' | 'unchecked';

/** What a Claude Code catalog request proved: its failure is a verdict only for `SIGN_IN_REQUIRED`. */
export function verdictOf(outcome: { ok: true } | { ok: false; error: unknown }): SignInVerdict {
  if (outcome.ok) return 'signed-in';
  return outcome.error instanceof WorkspaceOperationError && outcome.error.code === 'SIGN_IN_REQUIRED' ? 'signed-out' : 'unchecked';
}

/** Splits translated copy at `{n}` placeholders so commands can render as code. */
export function copyParts(text: string): { text: string; code?: number }[] {
  return text
    .split(/(\{\d+\})/)
    .filter((part) => part !== '')
    .map((part) => {
      const match = /^\{(\d+)\}$/.exec(part);
      return match ? { text: part, code: Number(match[1]) } : { text: part };
    });
}

type Settled = { ok: true } | { ok: false; error: unknown };
const settle = (request: Promise<unknown>): Promise<Settled> =>
  request.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * One composer's view of the sign-in check. `load` requests the Claude Code
 * catalog of a workspace: `refresh` forces a new native check, otherwise an
 * in-flight or finished request is shared. The newest verdict seen here wins
 * over the host's cached one; the host catalog itself is left alone, so the
 * composer's own selections never re-run.
 */
export class ClaudeSignInCheck {
  /** Newest verdict proved by a request in this view; `undefined` until one settles. */
  verdict = $state<'signed-in' | 'signed-out' | undefined>();
  checking = $state(false);
  /** The last explicit check could not run (not a sign-in verdict). */
  failed = $state(false);
  /** The last explicit check verified the subscription login. */
  confirmed = $state(false);

  constructor(private readonly load: (workspaceId: string, refresh: boolean) => Promise<unknown>) {}

  /** Signed out by the newest verdict, else by the host's cached one. */
  signedOut(cached: boolean): boolean {
    return this.verdict === undefined ? cached : this.verdict === 'signed-out';
  }

  /** "Check again": one fresh catalog-only check. */
  async check(workspaceId: string): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.failed = false;
    this.confirmed = false;
    const verdict = verdictOf(await settle(this.load(workspaceId, true)));
    this.checking = false;
    if (verdict === 'unchecked') {
      this.failed = true;
      return;
    }
    this.verdict = verdict;
    this.confirmed = verdict === 'signed-in';
  }

  /** Follows a catalog request the composer makes anyway (shared, so no second native start). */
  async observe(workspaceId: string): Promise<void> {
    const verdict = verdictOf(await settle(this.load(workspaceId, false)));
    // An explicit check that started meanwhile is newer.
    if (verdict !== 'unchecked' && !this.checking) this.verdict = verdict;
  }
}
