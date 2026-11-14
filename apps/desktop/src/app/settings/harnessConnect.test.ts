import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessRegistryFixture } from '../../../../../contracts/fixtures/harness-registry-v1';
import type { AcpAgentEntryV1, HarnessState } from '../../../../../contracts/harness-registry-v1';
import type { HarnessConnectInfoV1 } from '../../../../../contracts/harness-connect-v1';
import { createHarnessConnectClient, type HarnessConnectClient } from '../../host-api/harnessConnect';
import { labHost } from '../../host-api/lab/labTestKit';
import type { LabHost } from '../../host-api/lab/labHost';
import { canConnectAgent, canConnectBuiltin, connectGuide, connectIsPrimary, HarnessConnectStore, rowStatus } from './harnessConnect.svelte';

function client(host: LabHost): HarnessConnectClient {
  return createHarnessConnectClient((command, args) => host.invoke(command, args));
}

const failing: HarnessConnectClient = {
  describe: async () => { throw new Error('missing'); },
  openTerminal: async () => { throw { code: 'NO_TERMINAL', message: 'host text', recoverable: true }; },
};

describe('connect guide', () => {
  const described: HarnessConnectInfoV1[] = [
    { harness: 'pi', command: 'pi', then: '/login', terminal: true },
    { harness: 'codex', command: 'codex login', terminal: false },
  ];

  it('picks the dialog kind by harness', () => {
    expect(connectGuide('nano', described)).toEqual({ kind: 'nano' });
    expect(connectGuide('acp:gemini-cli', described)).toEqual({ kind: 'acp' });
    expect(connectGuide('codex', described)).toEqual({ kind: 'terminal', info: described[1] });
    // The host does not describe Prime Agent or Hermes: one line of guidance.
    expect(connectGuide('prime-agent', described)).toEqual({ kind: 'guidance' });
    expect(connectGuide('hermes', described)).toEqual({ kind: 'guidance' });
    expect(connectGuide('claude-code', described)).toEqual({ kind: 'guidance' });
  });

  it('keeps the command and Copy when the host has not described anything', () => {
    expect(connectGuide('claude-code', undefined)).toEqual({ kind: 'terminal', info: { harness: 'claude-code', command: 'claude', then: '/login', terminal: false } });
    expect(connectGuide('codex', undefined)).toEqual({ kind: 'terminal', info: { harness: 'codex', command: 'codex login', terminal: false } });
    expect(connectGuide('pi', undefined)).toMatchObject({ kind: 'terminal', info: { command: 'pi', terminal: false } });
    expect(connectGuide('hermes', undefined)).toEqual({ kind: 'guidance' });
  });
});

describe('row presentation', () => {
  it('shows a dot for every state and marks only ready as ready', () => {
    const states: HarnessState[] = ['ready', 'checking', 'not-installed', 'unsupported-version', 'unverified-version', 'sign-in-required', 'untrusted', 'unavailable'];
    for (const state of states) expect(rowStatus(state, false).ready).toBe(state === 'ready');
    expect(rowStatus('sign-in-required', false)).toEqual({ dot: 'waiting', label: 'Sign-in required', ready: false });
    expect(rowStatus('checking', true)).toMatchObject({ dot: 'offline', label: 'Not checked' });
    expect(rowStatus('checking', false)).toMatchObject({ dot: 'running', label: 'Checking…' });
  });

  it('offers Connect only where it can help, and as the main action only for a sign-in', () => {
    expect(canConnectBuiltin('not-installed')).toBe(false);
    expect(canConnectBuiltin('ready')).toBe(true);
    expect(canConnectBuiltin('sign-in-required')).toBe(true);
    expect(connectIsPrimary('sign-in-required')).toBe(true);
    expect(connectIsPrimary('ready')).toBe(false);
    const agent = (state: HarnessState) => ({ ...harnessRegistryFixture.agents[0], state }) as AcpAgentEntryV1;
    expect(canConnectAgent(agent('ready'))).toBe(true);
    expect(canConnectAgent(agent('sign-in-required'))).toBe(true);
    expect(canConnectAgent(agent('untrusted'))).toBe(false);
    expect(canConnectAgent(agent('not-installed'))).toBe(false);
  });
});

describe('Harness connect store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('describes once per mount and opens a terminal through the host', async () => {
    const host = labHost('demo');
    const invoke = vi.spyOn(host, 'invoke');
    const store = new HarnessConnectStore(client(host));
    await Promise.all([store.describe(), store.describe()]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(store.infos?.map((info) => [info.harness, info.terminal])).toEqual([['pi', true], ['codex', true], ['claude-code', true]]);
    expect(store.guide('codex')).toMatchObject({ kind: 'terminal', info: { command: 'codex login', terminal: true } });
    await store.open('codex');
    expect(store.opened).toBe('codex');
    expect(store.error).toBeUndefined();
    expect(store.busy).toBe(false);
    store.reset();
    expect(store.opened).toBeUndefined();
  });

  it('reports safe mode: no terminal is offered and a direct request is refused', async () => {
    const host = labHost('safe');
    const store = new HarnessConnectStore(client(host));
    await store.describe();
    expect(store.infos?.every((info) => !info.terminal)).toBe(true);
    await store.open('claude-code');
    expect(store.opened).toBeUndefined();
    expect(store.error).toBe('Safe mode is on: Nano Desktop starts no agent program.');
  });

  it('does not offer a terminal for a harness that is not installed', async () => {
    const host = labHost('demo');
    host.state.harnesses = host.state.harnesses.map((summary) => (summary.kind === 'pi' ? { ...summary, installed: false } : summary));
    const store = new HarnessConnectStore(client(host));
    await store.describe();
    expect(store.infos?.map((info) => [info.harness, info.terminal])).toEqual([['pi', false], ['codex', true], ['claude-code', true]]);
    await store.open('pi');
    expect(store.opened).toBeUndefined();
    expect(store.error).toBe('Could not open a terminal. Run the command yourself.');
  });

  it('falls back to copy-only when describe fails, and maps an open failure to fixed copy', async () => {
    const store = new HarnessConnectStore(failing);
    await store.describe();
    expect(store.infos).toBeUndefined();
    expect(store.guide('claude-code')).toMatchObject({ kind: 'terminal', info: { command: 'claude', then: '/login', terminal: false } });
    await store.open('codex');
    expect(store.error).toBe('A terminal app was not found. Run the command yourself.');
    expect(store.opened).toBeUndefined();
    expect(store.busy).toBe(false);
  });

  it('drops the outcome of a request that a dialog change has already outdated', async () => {
    let failCodex: ((cause: unknown) => void) | undefined;
    let finishPi: (() => void) | undefined;
    const openTerminal = vi.fn((harness: string) =>
      harness === 'codex'
        ? new Promise<void>((_resolve, reject) => { failCodex = reject; })
        : new Promise<void>((resolve) => { finishPi = resolve; }),
    );
    const store = new HarnessConnectStore({ describe: async () => [], openTerminal });
    const codex = store.open('codex');
    // The Codex dialog closes and Pi's opens before the Codex request settles.
    store.reset();
    expect(store.busy).toBe(false);
    const pi = store.open('pi');
    failCodex?.({ code: 'TERMINAL_UNAVAILABLE' });
    await codex;
    expect(store.error).toBeUndefined();
    expect(store.busy).toBe(true);
    finishPi?.();
    await pi;
    expect(store.opened).toBe('pi');
    expect(store.error).toBeUndefined();
    expect(store.busy).toBe(false);
  });

  it('ignores a success that arrives after the dialog was reset', async () => {
    let finish: (() => void) | undefined;
    const store = new HarnessConnectStore({ describe: async () => [], openTerminal: () => new Promise<void>((resolve) => { finish = resolve; }) });
    const opening = store.open('codex');
    store.reset();
    finish?.();
    await opening;
    expect(store.opened).toBeUndefined();
    expect(store.busy).toBe(false);
  });

  it('ignores a second request while one is running', async () => {
    let finish: (() => void) | undefined;
    const openTerminal = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const store = new HarnessConnectStore({ describe: async () => [], openTerminal });
    const first = store.open('pi');
    await store.open('pi');
    expect(openTerminal).toHaveBeenCalledTimes(1);
    finish?.();
    await first;
    expect(store.opened).toBe('pi');
  });
});
