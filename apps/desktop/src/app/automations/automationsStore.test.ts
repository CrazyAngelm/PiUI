import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationClient } from '../../host-api/orchestrationClient';
import type { AutomationsClient } from '../../host-api/automationsClient';
import { AutomationsStore } from './automationsStore.svelte';

function clients(schedules: 'live' | 'offline'): { client: OrchestrationClient; automations: AutomationsClient } {
  const client = {
    listenSchedules: schedules === 'live' ? async () => () => undefined : async () => { throw new Error('no events'); },
    orchestration_list_schedules_v7: async () => [],
    orchestration_catalog_v6: async () => ({ launchCommands: [], profiles: [] }),
  } as unknown as OrchestrationClient;
  const automations = {
    listen: async () => () => undefined,
    state: async () => ({ paused: false }),
  } as unknown as AutomationsClient;
  return { client, automations };
}

describe('AutomationsStore live updates', () => {
  it('says so when the event stream cannot start, so the list can be refreshed by hand', async () => {
    const { client, automations } = clients('offline');
    const store = new AutomationsStore('workspace', false, client, automations);
    const stop = store.start();
    await vi.waitFor(() => expect(store.liveError).toBe('Live updates are unavailable. Use Refresh to load recorded state.'));
    expect(store.error).toBe('');
    stop();
  });

  it('stays quiet while the event streams are live', async () => {
    const { client, automations } = clients('live');
    const store = new AutomationsStore('workspace', false, client, automations);
    const stop = store.start();
    await vi.waitFor(() => expect(store.loading).toBe(false));
    expect(store.liveError).toBe('');
    stop();
  });
});

describe('AutomationsStore coalesced refreshes', () => {
  /** Holds every schedules read until the test answers it, and hands out the event handlers. */
  function gated() {
    const reads: { answer: (names: string[]) => void; fail: (error: unknown) => void }[] = [];
    let onSchedule: ((event: { workspaceId: string }) => void) | undefined;
    let onPause: ((event: { paused: boolean }) => void) | undefined;
    let paused = false;
    const client = {
      listenSchedules: async (handler: typeof onSchedule) => {
        onSchedule = handler;
        return () => undefined;
      },
      orchestration_list_schedules_v7: () =>
        new Promise((resolve, reject) =>
          reads.push({ answer: (names) => resolve(names.map((name) => ({ value: { id: name, name }, revision: 1, enabled: false }))), fail: reject }),
        ),
      orchestration_catalog_v6: async () => ({ launchCommands: [], profiles: [] }),
    } as unknown as OrchestrationClient;
    const automations = {
      listen: async (handler: typeof onPause) => {
        onPause = handler;
        return () => undefined;
      },
      state: async () => ({ paused }),
    } as unknown as AutomationsClient;
    return {
      reads,
      client,
      automations,
      schedule: (workspaceId = 'workspace') => onSchedule?.({ workspaceId }),
      pause: (value: boolean) => {
        paused = value;
        onPause?.({ paused: value });
      },
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('reads once for a single schedule event and ignores other projects', async () => {
    const host = gated();
    const store = new AutomationsStore('workspace', false, host.client, host.automations);
    const stop = store.start();
    host.reads[0]?.answer(['one']);
    await settle();
    expect(host.reads).toHaveLength(1);

    host.schedule('other');
    expect(host.reads).toHaveLength(1);
    host.schedule();
    expect(host.reads).toHaveLength(2);
    host.reads[1]?.answer(['one', 'two']);
    await settle();
    expect(host.reads).toHaveLength(2);
    expect(store.schedules.map((item) => item.value.name)).toEqual(['one', 'two']);
    stop();
  });

  it('reads one more time after a burst of schedule and pause events while a read is in flight', async () => {
    const host = gated();
    const store = new AutomationsStore('workspace', false, host.client, host.automations);
    const stop = store.start();
    expect(host.reads).toHaveLength(1);
    host.schedule();
    host.schedule();
    host.pause(true);
    host.schedule();
    // The pause event carries its value: it shows before any read answers.
    expect(store.paused).toBe(true);
    expect(host.reads).toHaveLength(1);

    host.reads[0]?.answer(['old']);
    await settle();
    expect(host.reads).toHaveLength(2);
    host.reads[1]?.answer(['new']);
    await settle();
    expect(host.reads).toHaveLength(2);
    expect(store.schedules.map((item) => item.value.name)).toEqual(['new']);
    expect(store.paused).toBe(true);
    expect(store.loading).toBe(false);
    stop();
  });

  it('lets an awaited refresh resolve after a read that started after the call', async () => {
    const host = gated();
    const store = new AutomationsStore('workspace', false, host.client, host.automations);
    const stop = store.start();
    let done = false;
    void store.refresh().then(() => {
      done = true;
    });
    host.reads[0]?.answer(['old']);
    await settle();
    expect(done).toBe(false);
    expect(host.reads).toHaveLength(2);
    host.reads[1]?.answer(['new']);
    await settle();
    expect(done).toBe(true);
    stop();
  });

  it('keeps reading after a failed read', async () => {
    const host = gated();
    const store = new AutomationsStore('workspace', false, host.client, host.automations);
    const stop = store.start();
    host.schedule();
    host.reads[0]?.fail(new Error('host down'));
    await settle();
    expect(host.reads).toHaveLength(2);
    host.reads[1]?.fail(new Error('host down'));
    await settle();
    expect(store.error).not.toBe('');
    expect(store.loading).toBe(false);

    host.schedule();
    expect(host.reads).toHaveLength(3);
    host.reads[2]?.answer(['back']);
    await settle();
    expect(store.error).toBe('');
    expect(store.schedules.map((item) => item.value.name)).toEqual(['back']);
    stop();
  });
});
