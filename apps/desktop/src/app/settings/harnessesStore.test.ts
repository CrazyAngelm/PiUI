import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarnessRegistryClient, type HarnessRegistryClient } from '../../host-api/harnessRegistry';
import { labHost } from '../../host-api/lab/labTestKit';
import type { LabHost } from '../../host-api/lab/labHost';
import { harnessMeta } from '../harnessMeta';
import { HarnessesStore } from './harnessesStore.svelte';

function client(host: LabHost): HarnessRegistryClient {
  return createHarnessRegistryClient((command, args) => host.invoke(command, args), (channel, handler) => host.listen(channel, handler));
}

/** Runs a store action to completion under fake timers (lab latency). */
async function settle<T>(action: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return action;
}

describe('Settings → Harnesses store against the UI Lab host', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists built-in harnesses and ACP agents without running anything, and names their marks', async () => {
    const store = new HarnessesStore(client(labHost('demo')));
    await settle(store.start());
    expect(store.error).toBeUndefined();
    expect(store.builtins.map((harness) => harness.harness)).toEqual(['pi', 'prime-agent', 'codex', 'hermes', 'claude-code']);
    expect(store.agents.map((row) => [row.agent.descriptor.id, row.agent.state, row.status?.harness])).toEqual([
      ['gemini-cli', 'ready', 'acp:gemini-cli'], ['qwen-code', 'not-installed', 'acp:qwen-code'], ['lab-agent', 'untrusted', 'acp:lab-agent'],
    ]);
    expect(harnessMeta('acp:lab-agent').label).toBe('Lab Agent');
    store.dispose();
  });

  it('trusts the reviewed command line and follows registry events', async () => {
    const host = labHost('demo');
    const store = new HarnessesStore(client(host));
    await settle(store.start());
    const lab = store.agent('lab-agent');
    if (lab === undefined) throw new Error('Expected the seeded agent.');
    expect(await settle(store.trust(lab))).toBeUndefined();
    expect(store.agent('lab-agent')).toMatchObject({ state: 'ready', trusted: true, version: '1.4.0' });
    expect(store.busy).toBe('');
    // Another window removes an agent: the registry event refreshes this one.
    const other = client(host);
    const current = await settle(other.run({ type: 'list' }));
    await settle(other.run({ type: 'remove', expectedRevision: current.revision, id: 'qwen-code' }));
    await vi.runAllTimersAsync();
    expect(store.agents.map((row) => row.agent.descriptor.id)).toEqual(['gemini-cli', 'lab-agent']);
    store.dispose();
  });

  it('keeps a stale decision local, reloads the list and shows the host reason', async () => {
    const host = labHost('demo');
    // A window that has not heard about another window's change yet.
    const deaf = createHarnessRegistryClient((command, args) => host.invoke(command, args), async () => () => undefined);
    const store = new HarnessesStore(deaf);
    await settle(store.start());
    const reviewed = store.agent('lab-agent');
    if (reviewed === undefined) throw new Error('Expected the seeded agent.');
    const other = client(host);
    const current = await settle(other.run({ type: 'list' }));
    await settle(other.run({ type: 'allowSecrets', expectedRevision: current.revision, id: 'lab-agent', fingerprint: reviewed.fingerprint, names: ['LAB_AGENT_TOKEN'] }));
    const failure = await settle(store.trust(reviewed));
    expect(failure).toMatchObject({ code: 'CONFLICT', message: 'The harness list changed. Review it and try again.' });
    // Dialog failures stay in the dialog, not on the page or the card.
    expect(store.error).toBeUndefined();
    expect(store.agentErrors).toEqual({});
    await vi.runAllTimersAsync();
    expect(store.agent('lab-agent')?.allowedSecrets).toEqual(['LAB_AGENT_TOKEN']);
    // The review of the current list succeeds.
    const latest = store.agent('lab-agent');
    expect(latest && (await settle(store.trust(latest)))).toBeUndefined();
    expect(store.agent('lab-agent')?.state).toBe('ready');
    store.dispose();
  });

  it('adds a descriptor, reports host validation and runs one change at a time', async () => {
    const store = new HarnessesStore(client(labHost('demo')));
    await settle(store.start());
    const descriptor = { schemaVersion: 1 as const, id: 'tool-agent', displayName: 'Tool Agent', command: { program: 'tool-agent' }, version: { args: ['--version'] } };
    const first = store.add(descriptor);
    expect(await store.remove(store.agent('qwen-code') ?? (undefined as never))).toMatchObject({ message: 'Wait for the current harness change to finish.' });
    expect(await settle(first)).toBeUndefined();
    expect(store.agent('tool-agent')).toMatchObject({ source: 'user', state: 'not-installed' });
    expect(await settle(store.add(descriptor))).toMatchObject({ code: 'DUPLICATE' });
    expect(await settle(store.add({ ...descriptor, id: 'other', displayName: ' padded' }))).toMatchObject({
      code: 'INVALID_DESCRIPTOR', message: 'The display name must be 1-64 characters without control characters.',
    });
    await settle(store.check('acp:tool-agent'));
    expect(store.agentErrors).toEqual({});
    store.dispose();
  });

  it('shows safe mode refusals on the page and keeps listing', async () => {
    const store = new HarnessesStore(client(labHost('safe')));
    await settle(store.start());
    expect(store.safeMode).toBe(true);
    expect(store.agent('gemini-cli')?.state).toBe('checking');
    await settle(store.check());
    expect(store.error).toBe('Harness checks and changes are disabled in safe mode.');
    await settle(store.check('acp:gemini-cli'));
    expect(store.agentErrors['gemini-cli']).toBe('Harness checks and changes are disabled in safe mode.');
    store.dispose();
  });

  it('reports an unavailable registry without native detail and stops listening after dispose', async () => {
    const listen = vi.fn(async () => () => undefined);
    const failing = createHarnessRegistryClient((async () => { throw 'Command harness_registry_v1 not found'; }) as never, listen as never);
    const store = new HarnessesStore(failing);
    await store.start();
    expect(store.error).toBe('PiUI could not read the harness list.');
    expect(store.registry).toBeUndefined();
    const stop = vi.fn();
    const late = new HarnessesStore(createHarnessRegistryClient(vi.fn() as never, (async () => stop) as never));
    late.dispose();
    await late.start();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
