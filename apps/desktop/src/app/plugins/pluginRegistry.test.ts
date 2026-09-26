import { describe, expect, it, vi } from 'vitest';
import type { PluginsRegistryV1 } from '../../../../../contracts/plugins-v1';
import type { GraphNode } from '../../features/orchestration/agentGraph';
import { createPluginsClient, type PluginsClient } from '../../host-api/pluginsClient';
import { labHost } from '../../host-api/lab/labTestKit';
import type { PiUiContributionCatalog } from '../../host-api/types';
import { executeCommand } from './commands';
import { commandLineText, formatBytes, PERMISSION_TEXT } from './permissions';
import { defaultConfig, pluginNodeIssues, pluginNodeMenu } from './pluginNodes';
import { commandSource, commandTitle, PluginRegistry } from './pluginRegistry.svelte';

const PI: PiUiContributionCatalog = {
  commands: [{ extensionId: 'pi.health', extensionName: 'Project health', id: 'pi.health.status', title: 'Show project health', commandName: 'health' }],
  composerActions: [
    { extensionId: 'pi.zeta', extensionName: 'Zeta', id: 'pi.zeta.a', title: 'Zeta action', commandId: 'z', commandName: 'zeta', order: 10 },
    { extensionId: 'pi.health', extensionName: 'Project health', id: 'pi.health.action', title: 'Health report', commandId: 'pi.health.status', commandName: 'health', order: 5 },
  ],
};

async function labRegistry(scenario: 'demo' | 'safe' = 'demo'): Promise<{ registry: PluginRegistry; client: PluginsClient }> {
  const host = labHost(scenario);
  const client = createPluginsClient(host.invoke.bind(host), host.listen.bind(host));
  const registry = new PluginRegistry(client, async () => PI);
  await registry.start();
  await registry.loadContributions();
  return { registry, client };
}

describe('plugin registry', () => {
  it('projects the commands of active plugins and, in Pi chats, the Tier 1A contributions', async () => {
    const { registry } = await labRegistry();
    expect(registry.revision).toBeGreaterThan(0);
    const palette = registry.commands('palette');
    expect(palette.map((command) => command.key)).toEqual([
      'plugin:example.hello-command:say-hello',
      'plugin:lab.broken-sample:check',
    ]);
    expect(palette.map(commandTitle)).toEqual(['Say hello', 'Run the broken check']);
    expect(registry.commands('composer').map((command) => command.key)).toEqual([
      'plugin:example.hello-command:say-hello',
      'plugin:example.hello-command:insert-thanks',
    ]);
    // Pi extension contributions join only for a Pi chat, composer actions in their declared order.
    const piPalette = registry.commands('palette', 'pi');
    expect(piPalette.at(-1)).toMatchObject({ source: 'pi-extension', commandName: 'health', surfaces: ['palette'] });
    expect(commandSource(piPalette.at(-1)!)).toBe('Project health');
    expect(registry.commands('composer', 'pi').filter((command) => command.source === 'pi-extension').map(commandTitle)).toEqual(['Health report', 'Zeta action']);
    expect(registry.commands('composer', 'codex').every((command) => command.source === 'plugin')).toBe(true);
  });

  it('offers panels, themes, templates and node types of active plugins only', async () => {
    const { registry } = await labRegistry();
    expect(registry.panels('chat-details').map(({ plugin, panel }) => `${plugin.id}/${panel.id}`)).toEqual(['example.hello-command/hello']);
    expect(registry.themes().map(({ theme }) => theme.id)).toEqual(['midnight', 'paper']);
    expect(registry.templates().map(({ template }) => template.id)).toEqual(['draft-and-critique', 'collect-and-reshape']);
    expect(registry.nodeTypes().map(({ nodeType }) => nodeType.id)).toEqual(['json-transform']);
    expect(registry.activeTheme()).toBeUndefined();

    await registry.run({ type: 'setTheme', expectedRevision: registry.revision, theme: { pluginId: 'example.midnight-theme', themeId: 'midnight' } });
    expect(registry.activeTheme()?.label).toBe('Midnight');
    await registry.run({ type: 'setEnabled', expectedRevision: registry.revision, id: 'example.midnight-theme', enabled: false });
    // The choice is kept, but a disabled plugin's theme no longer applies.
    expect(registry.registry?.activeTheme).toEqual({ pluginId: 'example.midnight-theme', themeId: 'midnight' });
    expect(registry.activeTheme()).toBeUndefined();
    expect(registry.themes()).toEqual([]);
  });

  it('shows nothing active in safe mode, including Pi contributions', async () => {
    const { registry } = await labRegistry('safe');
    expect(registry.safeMode).toBe(true);
    expect(registry.plugins.length).toBeGreaterThan(0);
    expect([registry.active, registry.commands('palette', 'pi'), registry.panels('chat-details'), registry.nodeTypes()]).toEqual([[], [], [], []]);
  });

  it('keeps a translatable message when the host cannot list plugins', async () => {
    const failing: PluginsClient = {
      run: vi.fn(async () => { throw { code: 'IO_ERROR', message: 'PiUI could not save the plugin list.' }; }),
      runCommand: vi.fn(),
      template: vi.fn(),
      listen: vi.fn(async () => () => undefined),
    };
    const registry = new PluginRegistry(createPluginsClient(failing.run as never, failing.listen as never), async () => { throw new Error('no Pi'); });
    await registry.start();
    await registry.loadContributions();
    expect(registry.error).toBe('PiUI could not save the plugin list.');
    expect(registry.plugins).toEqual([]);
    expect(registry.piContributions).toEqual({ commands: [], composerActions: [] });
    // Anything that is not a host error becomes the generic message.
    const broken = new PluginRegistry(createPluginsClient((async () => { throw new Error('native text'); }) as never, failing.listen as never));
    await broken.refresh();
    expect(broken.error).toBe('PiUI could not read the plugin list.');
  });
});

describe('registry commands', () => {
  it('prepares text without sending: slash commands, declared text or the backend answer', async () => {
    const client: PluginsClient = {
      run: vi.fn(),
      runCommand: vi.fn(async () => ({ protocol: 1 as const, notice: 'Hi', text: 'Prepared' })),
      template: vi.fn(),
      listen: vi.fn(),
    };
    const pi = { key: 'pi:x:y', source: 'pi-extension' as const, extensionId: 'x', extensionName: 'X', id: 'y', title: 'Y', commandName: 'health', surfaces: ['palette' as const] };
    expect(await executeCommand(pi, 'palette', 'session-1', client)).toEqual({ text: '/health ' });
    const declared = { key: 'plugin:a.b:c', source: 'plugin' as const, pluginId: 'a.b', pluginName: 'A', command: { id: 'c', title: 'C', surfaces: ['composer' as const], insertText: 'TODO:' } };
    expect(await executeCommand(declared, 'composer', undefined, client)).toEqual({ text: 'TODO:' });
    expect(client.runCommand).not.toHaveBeenCalled();
    const backend = { ...declared, command: { id: 'd', title: 'D', surfaces: ['palette' as const] } };
    expect(await executeCommand(backend, 'palette', 'session-1', client)).toEqual({ text: 'Prepared', notice: 'Hi' });
    expect(client.runCommand).toHaveBeenCalledWith({ pluginId: 'a.b', commandId: 'd', origin: 'palette', sessionId: 'session-1' });
    await executeCommand(backend, 'palette', undefined, client);
    expect(client.runCommand).toHaveBeenLastCalledWith({ pluginId: 'a.b', commandId: 'd', origin: 'palette' });
  });
});

describe('plugin nodes', () => {
  it('builds Add-menu entries with declared defaults and tells equal titles apart', async () => {
    const { registry } = await labRegistry();
    const [found] = registry.nodeTypes();
    if (found === undefined) throw new Error('No node type.');
    expect(defaultConfig(found.nodeType)).toEqual({ source: 'dependencies' });
    const twin = { plugin: { ...found.plugin, id: 'other.pack', name: 'Other pack' }, nodeType: found.nodeType };
    const menu = pluginNodeMenu([found, twin]);
    expect(menu.map((entry) => entry.label)).toEqual(['JSON transform (Pipeline pack)', 'JSON transform (Other pack)']);
    expect(menu[0]?.node).toEqual({ pluginId: 'example.pipeline-pack', nodeType: 'json-transform', title: 'JSON transform', config: { source: 'dependencies' } });
    expect(pluginNodeMenu([found]).map((entry) => entry.label)).toEqual(['JSON transform']);
  });

  it('reports plugin nodes whose plugin is unavailable or whose configuration is invalid', async () => {
    const { registry } = await labRegistry();
    const node = (id: string, config: Record<string, string | number | boolean>, pluginId = 'example.pipeline-pack'): GraphNode =>
      ({ id, executor: { type: 'plugin', pluginId, nodeType: 'json-transform', config } }) as unknown as GraphNode;
    const graph = {
      nodes: [
        node('ok', { source: 'inputs', pick: 'a,b' }),
        node('bad-choice', { source: 'files' }),
        node('unknown-key', { script: 'x' }),
        node('missing', {}, 'example.gone'),
        { id: 'agent' } as GraphNode,
      ],
    };
    expect(pluginNodeIssues(graph, registry)).toEqual([
      { nodeId: 'bad-choice', message: 'This plugin node’s identity or configuration is not valid.' },
      { nodeId: 'unknown-key', message: 'This plugin node’s identity or configuration is not valid.' },
      { nodeId: 'missing', message: 'This plugin node needs its plugin: install and enable it in Settings → Plugins.' },
    ]);
    await registry.run({ type: 'setEnabled', expectedRevision: registry.revision, id: 'example.pipeline-pack', enabled: false });
    expect(pluginNodeIssues({ nodes: [node('ok', {})] }, registry)).toEqual([
      { nodeId: 'ok', message: 'This plugin node needs its plugin: install and enable it in Settings → Plugins.' },
    ]);
  });
});

describe('plugin themes', () => {
  it('sets only known color tokens with valid colors and removes them again', async () => {
    const { applyPluginTheme } = await import('./pluginTheme.svelte');
    const properties = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string>,
      style: { setProperty: (name: string, value: string) => properties.set(name, value), removeProperty: (name: string) => properties.delete(name) },
    } as unknown as HTMLElement;
    applyPluginTheme({
      id: 'midnight', label: 'Midnight', appearance: 'dark',
      tokens: { bg: '#0f1420', text: 'rgb(230, 236, 245)', 'font-ui': 'Comic Sans', accent: 'url(https://example.com/x)' },
    }, root);
    expect([...properties]).toEqual([['--piui-bg', '#0f1420'], ['--piui-text', 'rgb(230, 236, 245)']]);
    expect(root.dataset.pluginTheme).toBe('midnight');
    applyPluginTheme(undefined, root);
    expect(properties.size).toBe(0);
    expect(root.dataset.pluginTheme).toBeUndefined();
  });
});

describe('plain words', () => {
  it('describes every permission and formats sizes and command lines for display', () => {
    for (const text of Object.values(PERMISSION_TEXT)) {
      expect(text.label.length).toBeGreaterThan(5);
      expect(text.detail.length).toBeGreaterThan(5);
    }
    expect(formatBytes(612)).toBe('612 B');
    expect(formatBytes(4_318)).toBe('4.2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(commandLineText({ program: 'C:/Program Files/nodejs/node.exe', args: ['C:/data/main.mjs', 'say "hi"'] }))
      .toBe('"C:/Program Files/nodejs/node.exe" C:/data/main.mjs "say \\"hi\\""');
  });

  it('never lists a registry without its protocol', () => {
    const registry: Pick<PluginsRegistryV1, 'protocol'> = { protocol: 1 };
    expect(registry.protocol).toBe(1);
  });
});
