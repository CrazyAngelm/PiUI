import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { HarnessSummary, WorkspaceCatalog } from '../../../../../contracts/workspace-v15';
import { CLAUDE_SIGN_IN_MESSAGE } from '../../host-api/lab/catalogFake';
import { WorkspaceOperationError, workspaceError } from '../../host-api/workspaceClient';
import type { WorkspaceStore } from '../workspaceStore.svelte';
import { WORKSPACE_CONTEXT } from '../shell/context';
import ClaudeSignInStatus from './ClaudeSignInStatus.svelte';
import {
  CLAUDE_SIGN_IN_REASON,
  ClaudeSignInCheck,
  SIGNED_OUT_COPY,
  cachedSignedOut,
  copyParts,
  isSignInMessage,
  verdictOf,
} from './claudeSignIn.svelte';

const claude = (reason: string | undefined = undefined): HarnessSummary => ({
  kind: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.232', status: 'available', ...(reason ? { reason } : {}),
});
const signInError = () => new WorkspaceOperationError('SIGN_IN_REQUIRED', CLAUDE_SIGN_IN_REASON);

describe('Claude Code sign-in state', () => {
  it('reads the host verdict from the catalog reason the host and the UI Lab report', () => {
    expect(CLAUDE_SIGN_IN_REASON).toBe(CLAUDE_SIGN_IN_MESSAGE);
    expect(workspaceError({ code: 'SIGN_IN_REQUIRED' }).message).toBe(CLAUDE_SIGN_IN_REASON);
    expect(isSignInMessage(workspaceError({ code: 'SIGN_IN_REQUIRED' }).message)).toBe(true);
    expect(isSignInMessage('Could not load models.')).toBe(false);
    expect(cachedSignedOut([claude(CLAUDE_SIGN_IN_REASON)])).toBe(true);
    // No reason: never checked in this host process, or verified.
    expect(cachedSignedOut([claude()])).toBe(false);
    expect(cachedSignedOut([{ ...claude(), status: 'unverified', reason: 'The installed Claude Code version is outside the tested range.' }])).toBe(false);
  });

  it('counts only a refused login as a signed-out verdict', () => {
    expect(verdictOf({ ok: true })).toBe('signed-in');
    expect(verdictOf({ ok: false, error: signInError() })).toBe('signed-out');
    expect(verdictOf({ ok: false, error: new Error('Could not load models.') })).toBe('unchecked');
    expect(verdictOf({ ok: false, error: new WorkspaceOperationError('NOT_TRUSTED', 'x') })).toBe('unchecked');
  });

  it('splits copy so the commands render as code in every language', () => {
    expect(copyParts(SIGNED_OUT_COPY)).toEqual([
      { text: 'Not signed in — run ' }, { text: '{0}', code: 0 }, { text: ' in a terminal and use ' }, { text: '{1}', code: 1 }, { text: '.' },
    ]);
  });

  it('checks again with a fresh catalog-only request and refreshes the host catalog on a new verdict', async () => {
    let answer: (value: unknown) => void = () => {};
    const load = vi.fn((_workspaceId: string, _refresh: boolean) => new Promise((resolve) => { answer = resolve; }));
    const reload = vi.fn(async () => undefined);
    const check = new ClaudeSignInCheck(load, reload);
    const pending = check.check('workspace', true);
    expect(check.checking).toBe(true);
    await check.check('workspace', true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('workspace', true);
    answer({ protocol: 18 });
    await pending;
    expect([check.checking, check.confirmed, check.failed]).toEqual([false, true, false]);
    expect(reload).toHaveBeenCalledTimes(1);

    // Still signed out: the cached verdict already says so, nothing to refresh.
    const refused = new ClaudeSignInCheck(async () => { throw signInError(); }, reload);
    await refused.check('workspace', true);
    expect([refused.confirmed, refused.failed]).toEqual([false, false]);
    expect(reload).toHaveBeenCalledTimes(1);
    // A first refusal the catalog did not know yet refreshes it.
    await refused.check('workspace', false);
    expect(reload).toHaveBeenCalledTimes(2);

    // A check that could not run is not a verdict.
    const broken = new ClaudeSignInCheck(async () => { throw new Error('Could not load models.'); }, reload);
    await broken.check('workspace', true);
    expect([broken.confirmed, broken.failed]).toEqual([false, true]);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('follows the composer catalog request without a second check', async () => {
    const reload = vi.fn(async () => undefined);
    const load = vi.fn(async () => { throw signInError(); });
    const check = new ClaudeSignInCheck(load, reload);
    let signedOut = false;
    await check.observe('workspace', () => signedOut);
    expect(load).toHaveBeenCalledWith('workspace', false);
    expect(reload).toHaveBeenCalledTimes(1);
    signedOut = true;
    await check.observe('workspace', () => signedOut);
    expect(reload).toHaveBeenCalledTimes(1);
    expect([check.checking, check.confirmed, check.failed]).toEqual([false, false, false]);
  });
});

describe('ClaudeSignInStatus', () => {
  const catalog = (harness: HarnessSummary, trust: 'trusted' | 'restricted' = 'trusted', safeMode = false): WorkspaceCatalog => ({
    protocol: 15, safeMode, sessions: [], harnesses: [harness],
    workspaces: [{ id: 'workspace', name: 'piui', trust, missing: false, personal: false }],
  });
  const html = (value: WorkspaceCatalog): string => {
    const store = { catalog: value, safeMode: value.safeMode, loadCatalog: async () => value } as unknown as WorkspaceStore;
    const { body } = render(ClaudeSignInStatus, { props: { workspaceId: 'workspace' }, context: new Map([[WORKSPACE_CONTEXT, store]]) });
    // Hydration markers are not content.
    return body.replace(/<!--[\s\S]*?-->/g, '');
  };

  it('shows the cached signed-out verdict with the sign-in commands and Check again', () => {
    const body = html(catalog(claude(CLAUDE_SIGN_IN_REASON)));
    expect(body).toContain('role="status"');
    expect(body).toMatch(/Not signed in — run\s*<code[^>]*>claude<\/code>\s*in a terminal and use\s*<code[^>]*>\/login<\/code>/);
    expect(body).toMatch(/<button[^>]*aria-describedby="[^"]+-status"[^>]*>[\s\S]*Check again/);
  });

  it('stays quiet without a signed-out verdict', () => {
    expect(html(catalog(claude()))).not.toContain('signin');
  });

  it('offers no check where no check can run', () => {
    expect(html(catalog(claude(CLAUDE_SIGN_IN_REASON), 'restricted'))).not.toContain('Check again');
    expect(html(catalog(claude(CLAUDE_SIGN_IN_REASON), 'trusted', true))).not.toContain('Check again');
  });
});
