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

  it('checks again with one fresh catalog-only request and lets its verdict win over the cached one', async () => {
    let answer: (value: unknown) => void = () => {};
    const load = vi.fn((_workspaceId: string, _refresh: boolean) => new Promise((resolve) => { answer = resolve; }));
    const check = new ClaudeSignInCheck(load);
    expect(check.signedOut(true)).toBe(true);
    const pending = check.check('workspace');
    expect(check.checking).toBe(true);
    // A second click while checking starts nothing.
    await check.check('workspace');
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('workspace', true);
    answer({ protocol: 18 });
    await pending;
    expect([check.checking, check.confirmed, check.failed, check.verdict]).toEqual([false, true, false, 'signed-in']);
    expect(check.signedOut(true)).toBe(false);

    // Still signed out after /login was not run.
    const refused = new ClaudeSignInCheck(async () => { throw signInError(); });
    await refused.check('workspace');
    expect([refused.confirmed, refused.failed, refused.signedOut(false)]).toEqual([false, false, true]);

    // A check that could not run is not a verdict: the cached one stays.
    const broken = new ClaudeSignInCheck(async () => { throw new Error('Could not load models.'); });
    await broken.check('workspace');
    expect([broken.confirmed, broken.failed, broken.verdict]).toEqual([false, true, undefined]);
    expect(broken.signedOut(true)).toBe(true);
  });

  it('follows the composer catalog request without starting a second check', async () => {
    const load = vi.fn(async () => { throw signInError(); });
    const check = new ClaudeSignInCheck(load);
    await check.observe('workspace');
    expect(load).toHaveBeenCalledWith('workspace', false);
    expect(check.signedOut(false)).toBe(true);
    expect([check.checking, check.confirmed, check.failed]).toEqual([false, false, false]);
    // A shared request that failed for another reason proves nothing.
    const other = new ClaudeSignInCheck(async () => { throw new WorkspaceOperationError('NOT_TRUSTED', 'x'); });
    await other.observe('workspace');
    expect(other.verdict).toBeUndefined();
  });
});

describe('ClaudeSignInStatus', () => {
  const catalog = (harness: HarnessSummary, trust: 'trusted' | 'restricted' = 'trusted', safeMode = false): WorkspaceCatalog => ({
    protocol: 15, safeMode, sessions: [], harnesses: [harness],
    workspaces: [{ id: 'workspace', name: 'piui', trust, missing: false, personal: false }],
  });
  const html = (value: WorkspaceCatalog): string => {
    const store = { catalog: value, safeMode: value.safeMode } as unknown as WorkspaceStore;
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
