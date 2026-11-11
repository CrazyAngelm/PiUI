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
