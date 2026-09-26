import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { createExtensionsClient, type ExtensionsClient } from '../../host-api/extensionsClient';
import { labHost, rejection } from '../../host-api/lab/labTestKit';
import type { ExtensionSummary } from '../../host-api/types';
import { ExtensionInventory } from './extensionInventory.svelte';
import ExtensionsSettings from './ExtensionsSettings.svelte';

function labClient(scenario: 'demo' | 'empty' = 'demo'): ExtensionsClient {
  const host = labHost(scenario);
  return createExtensionsClient((command, args) => host.invoke(command, args));
}

describe('extension inventory over the UI Lab host', () => {
  it('lists each harness separately and toggles through the host', async () => {
    const inventory = new ExtensionInventory(labClient());
    await inventory.load();
    expect(inventory.items.map((item) => [item.name, item.enabled])).toEqual([
      ['permission-guard', true], ['commit-digest', true], ['workspace-tools', false],
    ]);
    const tools = inventory.items.find((item) => item.name === 'workspace-tools') as ExtensionSummary;
    expect(await inventory.toggle(tools, true)).toBe(true);
    expect(inventory.items.find((item) => item.name === 'workspace-tools')?.enabled).toBe(true);
    inventory.select('prime-agent');
    expect(inventory.items).toEqual([]);
    await inventory.load();
    expect(inventory.items.map((item) => item.name)).toEqual(['review-workers']);
    expect(inventory.items.every((item) => item.agentKind === 'prime-agent')).toBe(true);
  });

  it('keeps the previous state and reports a local error when a change fails', async () => {
    const items: ExtensionSummary[] = [{ id: `ext-${'a'.repeat(32)}`, agentKind: 'pi', name: 'guard', source: 'Global', enabled: true }];
    const client: ExtensionsClient = {
      list: async () => items,
      setEnabled: async () => Promise.reject(new Error('Could not change the extension. Its previous state is kept.')),
    };
    const inventory = new ExtensionInventory(client);
    await inventory.load();
    const before = inventory.items[0];
    expect(await inventory.toggle(items[0] as ExtensionSummary, false)).toBe(false);
    expect(inventory.error).toBe('Could not change the extension. Its previous state is kept.');
    expect(inventory.items[0]?.enabled).toBe(true);
    expect(inventory.items[0]).not.toBe(before);
    expect(inventory.busyId).toBeUndefined();
  });

  it('ignores a late list for a harness the user switched away from', async () => {
    let release: (value: ExtensionSummary[]) => void = () => {};
    const client: ExtensionsClient = {
      list: (harness) => harness === 'pi' ? new Promise((resolve) => { release = resolve; }) : Promise.resolve([]),
      setEnabled: async () => [],
    };
    const inventory = new ExtensionInventory(client);
    const first = inventory.load();
    inventory.select('prime-agent');
    release([{ id: `ext-${'b'.repeat(32)}`, agentKind: 'pi', name: 'late', source: 'Global', enabled: true }]);
    await first;
    await Promise.resolve();
    expect(inventory.harness).toBe('prime-agent');
    expect(inventory.items.some((item) => item.name === 'late')).toBe(false);
  });

  it('rejects malformed ids and responses for another harness', async () => {
    const host = labHost();
    expect(await rejection(host.invoke('set_extension_enabled_v10', { agentKind: 'pi', extensionId: 'short', enabled: true })))
      .toMatchObject({ code: 'INVALID_ARGUMENT' });
    const mismatched = createExtensionsClient(async () => [{ id: 'ext-x', agentKind: 'prime-agent', name: 'x', source: 'Global', enabled: true }] as never);
    await expect(mismatched.list('pi')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('renders the harness switch, trust note and an empty first run', () => {
    const { body } = render(ExtensionsSettings, { props: { safeMode: true, client: labClient('empty') } });
    expect(body).toContain('Global extensions run with your full user permissions.');
    expect(body).toContain('only after you trust that folder');
    expect(body).toContain('Safe mode: extensions are not loaded now.');
    expect(body).toContain('aria-label="Harness"');
  });
});
