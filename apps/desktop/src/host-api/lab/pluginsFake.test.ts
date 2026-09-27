import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessRegistryV1 } from '../../../../../contracts/harness-registry-v1';
import type { PluginCommandResultV1, PluginsCommandV1, PluginsRegistryV1, PluginsResponseV1, PluginTemplateResultV1 } from '../../../../../contracts/plugins-v1';
import type { OrchestrationCatalogV6, OrchestrationRunV6, PipelineDefinition, StoredDefinition, TeamDefinition } from './labContracts';
import type { LabHost } from './labHost';
import { labUuid } from './labRandom';
import { labHost, rejection } from './labTestKit';

/**
 * The UI Lab plugin host (ADR-032): the seeded example plugins with one
 * broken sample, the review-before-install flow, settings checks, safe mode,
 * commands, templates, plugin ACP agents and a plugin node in a lab run.
 */
async function plugins(host: LabHost, command: PluginsCommandV1 = { type: 'list' }): Promise<PluginsResponseV1> {
  return host.invoke<PluginsResponseV1>('plugins_v1', { command });
}

function entry(registry: PluginsRegistryV1, id: string) {
  const found = registry.plugins.find((plugin) => plugin.id === id);
  if (found === undefined) throw new Error(`No plugin ${id}.`);
  return found;
}

async function runCommand(host: LabHost, request: Record<string, unknown>): Promise<PluginCommandResultV1> {
  const pending = host.invoke<PluginCommandResultV1>('plugin_command_v1', { request });
  await vi.runAllTimersAsync();
  return pending;
}

async function commandFailure(host: LabHost, request: Record<string, unknown>): Promise<unknown> {
  const pending = rejection(host.invoke('plugin_command_v1', { request }));
  await vi.runAllTimersAsync();
  return pending;
}

describe('UI Lab plugin host', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds the example plugins and a broken sample that stays contained', async () => {
    const host = labHost();
    const { registry } = await plugins(host);
    expect(registry.safeMode).toBe(false);
    expect(registry.plugins.map((plugin) => [plugin.id, plugin.active])).toEqual([
      ['example.hello-command', true],
      ['example.midnight-theme', true],
      ['example.pipeline-pack', true],
      ['example.opencode-acp', false],
      ['lab.broken-sample', true],
    ]);
    const hello = entry(registry, 'example.hello-command');
    expect(hello.contributes.panels[0]?.url).toBe('http://piui-plugin.localhost/example.hello-command/ui/index.html?panel=hello');
    // Node's permission model: the package and the data folder, nothing else.
    expect(hello.backend?.commandLine.args[0]).toBe('--permission');
    expect(hello.backend?.commandLine.args.at(-1)).toMatch(/\/backend\/main\.mjs$/);
    expect(hello.backend?.commandLine.args.some((arg) => /allow-(net|child-process|worker)/.test(arg))).toBe(false);
    expect(hello.backend?.limits).toEqual({ nodeVersion: 'v24.13.0', enforced: true, network: false });
    expect(hello.settings).toEqual({ greeting: 'Hello', prepareText: false });

    const broken = entry(registry, 'lab.broken-sample');
    expect(broken.backend?.state).toBe('crash-loop');
    expect(broken.log.at(-1)?.event).toBe('crash-loop');
    expect(await commandFailure(host, { pluginId: 'lab.broken-sample', commandId: 'check', origin: 'palette' })).toMatchObject({
      code: 'BACKEND_UNAVAILABLE', message: "The plugin's backend keeps stopping. Restart it in Settings → Plugins.",
    });
    // Restarting clears the crash loop; the next use crashes once more and is reported, never thrown past the host.
    await plugins(host, { type: 'restartBackend', id: 'lab.broken-sample' });
    expect(await commandFailure(host, { pluginId: 'lab.broken-sample', commandId: 'check', origin: 'palette' })).toMatchObject({ code: 'BACKEND_FAILED' });
    expect(entry((await plugins(host)).registry, 'lab.broken-sample').backend?.state).toBe('crashed');
  });

  it('installs only the reviewed package and reviews updates again', async () => {
    const host = labHost();
    const before = (await plugins(host)).registry;
    const picked = await plugins(host, { type: 'pick', source: 'zip' });
    const review = picked.review;
    if (!review) throw new Error('Expected a review.');
    expect(review).toMatchObject({
      source: 'zip', id: 'lab.word-count', permissions: ['commands', 'chat.read'], alreadyInstalled: false,
      contributes: { commands: ['Count words'] },
    });
    expect(review.backend?.commandLine.program).toBe('C:/Program Files/nodejs/node.exe');
    expect(review.update).toBeUndefined();

    // A different code hash than the one reviewed, or a stale revision, installs nothing.
    expect(await rejection(plugins(host, { type: 'install', expectedRevision: before.revision, stagingId: review.stagingId, codeHash: '0'.repeat(64) })))
      .toMatchObject({ code: 'TRUST_CHANGED' });
    expect(await rejection(plugins(host, { type: 'install', expectedRevision: before.revision, stagingId: review.stagingId, codeHash: review.codeHash })))
      .toMatchObject({ code: 'REVIEW_EXPIRED' });
    const again = (await plugins(host, { type: 'pick', source: 'folder' })).review;
    if (!again) throw new Error('Expected a review.');
    expect(await rejection(plugins(host, { type: 'install', expectedRevision: before.revision - 1, stagingId: again.stagingId, codeHash: again.codeHash })))
      .toMatchObject({ code: 'CONFLICT' });

    const third = (await plugins(host, { type: 'pick', source: 'folder' })).review;
    if (!third) throw new Error('Expected a review.');
    const installed = await plugins(host, { type: 'install', expectedRevision: before.revision, stagingId: third.stagingId, codeHash: third.codeHash });
    const wordCount = entry(installed.registry, 'lab.word-count');
    expect(wordCount).toMatchObject({ active: true, enabled: true, source: 'installed', permissions: ['commands', 'chat.read'] });
    expect(installed.registry.revision).toBe(before.revision + 1);

    // The same package again is reported as installed.
    const same = (await plugins(host, { type: 'pick', source: 'zip' })).review;
    expect(same).toMatchObject({ alreadyInstalled: true, update: { fromVersion: '0.3.0', permissionsAdded: [], codeChanged: false } });

    // A development folder runs from where it is and reloads without a new install.
    const dev = (await plugins(host, { type: 'pick', source: 'development' })).review;
    if (!dev) throw new Error('Expected a review.');
    expect(dev).toMatchObject({ source: 'development', id: 'lab.dev-notes', alreadyInstalled: false });
    const loaded = await plugins(host, { type: 'install', expectedRevision: installed.registry.revision, stagingId: dev.stagingId, codeHash: dev.codeHash });
    const notes = entry(loaded.registry, 'lab.dev-notes');
    expect(notes).toMatchObject({ source: 'development', folder: 'C:/Users/example/code/dev-notes', active: true });
    const reloaded = await plugins(host, { type: 'reload', expectedRevision: loaded.registry.revision, id: 'lab.dev-notes' });
    expect(entry(reloaded.registry, 'lab.dev-notes').log.at(-1)?.event).toBe('reloaded');
    // Installed plugins are not reloaded from a folder.
    expect(await rejection(plugins(host, { type: 'reload', expectedRevision: reloaded.registry.revision, id: 'lab.word-count' }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('checks settings, keeps panels to their permissions and switches plugins off and on', async () => {
    const host = labHost();
    let { registry } = await plugins(host);
    expect(await rejection(plugins(host, { type: 'setSettings', expectedRevision: registry.revision, id: 'example.hello-command', values: { greeting: 'x'.repeat(41) } })))
      .toMatchObject({ code: 'INVALID_SETTINGS', problems: [{ code: 'field', message: '“{0}” is too long.', subject: 'greeting' }] });
    expect(await rejection(plugins(host, { type: 'setSettings', expectedRevision: registry.revision, id: 'example.hello-command', values: { unknown: true } })))
      .toMatchObject({ code: 'INVALID_SETTINGS', problems: [{ message: '“{0}” is not a declared field.', subject: 'unknown' }] });
    registry = (await plugins(host, { type: 'setSettings', expectedRevision: registry.revision, id: 'example.hello-command', values: { greeting: 'Hi', prepareText: true }, origin: 'panel' })).registry;
    expect(entry(registry, 'example.hello-command').settings).toEqual({ greeting: 'Hi', prepareText: true });
    // The pipeline pack has no ui.settings permission: a panel cannot store values for it.
    expect(await rejection(plugins(host, { type: 'setSettings', expectedRevision: registry.revision, id: 'example.pipeline-pack', values: {}, origin: 'panel' })))
      .toMatchObject({ code: 'PERMISSION_DENIED' });

    registry = (await plugins(host, { type: 'setEnabled', expectedRevision: registry.revision, id: 'example.hello-command', enabled: false })).registry;
    const off = entry(registry, 'example.hello-command');
    expect(off.active).toBe(false);
    expect(off.contributes.panels[0]?.url).toBeUndefined();
    expect(await commandFailure(host, { pluginId: 'example.hello-command', commandId: 'say-hello', origin: 'palette' })).toMatchObject({ code: 'INACTIVE' });
    registry = (await plugins(host, { type: 'setEnabled', expectedRevision: registry.revision, id: 'example.hello-command', enabled: true })).registry;
    expect(entry(registry, 'example.hello-command').active).toBe(true);
  });

  it('runs commands for their surfaces only and never sends anything', async () => {
    const host = labHost();
    const hello = await runCommand(host, { pluginId: 'example.hello-command', commandId: 'say-hello', origin: 'palette' });
    expect(hello).toEqual({ protocol: 1, notice: 'Hello from the Hello command plugin!' });
    const thanks = await runCommand(host, { pluginId: 'example.hello-command', commandId: 'insert-thanks', origin: 'composer' });
    expect(thanks.text).toMatch(/^Thanks!/);
    // A composer-only command cannot be run from the palette.
    expect(await commandFailure(host, { pluginId: 'example.hello-command', commandId: 'insert-thanks', origin: 'palette' })).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await commandFailure(host, { pluginId: 'example.hello-command', commandId: 'missing', origin: 'palette' })).toMatchObject({ code: 'NOT_FOUND' });
    const started = entry((await plugins(host)).registry, 'example.hello-command');
    expect(started.backend?.state).toBe('running');
    expect(started.log.at(-1)?.event).toBe('backend-started');
  });

  it('serves templates of active plugins and the Tier 1A Pi contributions', async () => {
    const host = labHost();
    const template = await host.invoke<PluginTemplateResultV1>('plugin_template_v1', { request: { pluginId: 'example.pipeline-pack', templateId: 'draft-and-critique' } });
    expect(JSON.parse(template.text)).toMatchObject({ format: 'piui-system' });
    expect(await rejection(host.invoke('plugin_template_v1', { request: { pluginId: 'example.pipeline-pack', templateId: 'missing' } }))).toMatchObject({ code: 'NOT_FOUND' });
    const catalog = await host.invoke<{ commands: unknown[]; composerActions: unknown[] }>('list_piui_contributions');
    expect(catalog.commands).toHaveLength(1);
    expect(catalog.composerActions).toHaveLength(1);
  });

  it('lists plugins read-only in safe mode', async () => {
    const host = labHost('safe');
    const { registry } = await plugins(host);
    expect(registry.safeMode).toBe(true);
    expect(registry.plugins.length).toBeGreaterThan(0);
    expect(registry.plugins.every((plugin) => !plugin.active)).toBe(true);
    for (const command of [
      { type: 'pick', source: 'folder' },
      { type: 'setEnabled', expectedRevision: registry.revision, id: 'example.hello-command', enabled: false },
      { type: 'remove', expectedRevision: registry.revision, id: 'example.hello-command' },
    ] as PluginsCommandV1[]) {
      expect(await rejection(plugins(host, command))).toMatchObject({ code: 'SAFE_MODE' });
    }
    expect(await commandFailure(host, { pluginId: 'example.hello-command', commandId: 'say-hello', origin: 'palette' })).toMatchObject({ code: 'SAFE_MODE' });
    expect(await host.invoke('list_piui_contributions')).toEqual({ commands: [], composerActions: [] });
  });

  it('adds a plugin ACP agent to Settings → Harnesses while the plugin is active', async () => {
    const host = labHost();
    const harnesses = async (): Promise<HarnessRegistryV1> => {
      const pending = host.invoke<HarnessRegistryV1>('harness_registry_v1', { command: { type: 'list' } });
      await vi.runAllTimersAsync();
      return pending;
    };
    expect((await harnesses()).agents.some((agent) => agent.descriptor.id === 'opencode')).toBe(false);
    const { registry } = await plugins(host);
    const enabled = await plugins(host, { type: 'setEnabled', expectedRevision: registry.revision, id: 'example.opencode-acp', enabled: true });
    expect(entry(enabled.registry, 'example.opencode-acp').contributes.acpAgents).toEqual([{ id: 'opencode', displayName: 'OpenCode', registered: true }]);
    const listed = await harnesses();
    const agent = listed.agents.find((item) => item.descriptor.id === 'opencode');
    expect(agent).toMatchObject({ source: 'plugin', plugin: { id: 'example.opencode-acp', name: 'OpenCode agent' }, trusted: false });
    // It leaves with its plugin, not from Settings → Harnesses.
    expect(await rejection(host.invoke('harness_registry_v1', { command: { type: 'remove', expectedRevision: listed.revision, id: 'opencode' } })))
      .toMatchObject({ code: 'PLUGIN_OWNED' });
    await plugins(host, { type: 'remove', expectedRevision: enabled.registry.revision, id: 'example.opencode-acp' });
    expect((await harnesses()).agents.some((item) => item.descriptor.id === 'opencode')).toBe(false);
  });
});

describe('UI Lab plugin nodes (orchestration v6.5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function call<T>(host: LabHost, route: string, request: Record<string, unknown>): Promise<T> {
    return host.invoke<T>(route, { request });
  }

  async function releaseWithPluginNode(host: LabHost) {
    const workspaceId = host.state.projects.find((project) => project.name === 'piui')?.id ?? '';
    const catalog = await call<OrchestrationCatalogV6>(host, 'orchestration_catalog_v6', { workspaceId });
    const id = (items: readonly { name: string; id: string }[]) => items.find((item) => item.name === 'Release check')?.id;
    const team = await call<StoredDefinition<TeamDefinition> | null>(host, 'orchestration_get_team_v6', { workspaceId, id: id(catalog.teams) });
    const pipeline = await call<StoredDefinition<PipelineDefinition> | null>(host, 'orchestration_get_pipeline_v6', { workspaceId, id: id(catalog.pipelines) });
    if (team === null || pipeline === null) throw new Error('No Release check system.');
    const value: PipelineDefinition = {
      ...pipeline.value,
      steps: pipeline.value.steps.map((step) => (step.executor?.type === 'script'
        ? {
            ...step,
            name: 'Keep the changes',
            executor: { type: 'plugin', pluginId: 'example.pipeline-pack', nodeType: 'json-transform', config: { source: 'dependencies', pick: 'changes', rename: 'changes=items' } },
            resultFields: [{ name: 'items', kind: 'text-list' }],
          }
        : step)),
    };
    const saved = await call<StoredDefinition<PipelineDefinition>>(host, 'orchestration_save_pipeline_v6', { workspaceId, expectedRevision: pipeline.revision, value });
    const nodeId = value.steps.find((step) => step.executor?.type === 'plugin')?.id ?? '';
    return { workspaceId, teamId: team.value.id, pipelineId: saved.value.id, nodeId };
  }

  it('runs the JSON transform node on the host with checked result data and no session', async () => {
    const host = labHost();
    const system = await releaseWithPluginNode(host);
    const runId = labUuid('test:plugin-node');
    await call(host, 'orchestration_start_run_v6', { workspaceId: system.workspaceId, runId, teamId: system.teamId, pipelineId: system.pipelineId });
    let run: OrchestrationRunV6 | null = null;
    for (let second = 0; second < 240; second += 1) {
      run = await call<OrchestrationRunV6 | null>(host, 'orchestration_get_run_v6', { workspaceId: system.workspaceId, runId });
      if (run?.status !== 'running') break;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(run?.status).toBe('succeeded');
    const task = run?.tasks.find((item) => item.stepId === system.nodeId);
    expect(task?.status).toBe('succeeded');
    expect(Array.isArray(task?.resultData?.items)).toBe(true);
    expect(Object.keys(task?.resultData ?? {})).toEqual(['items']);
    expect(host.state.sessions.has(task?.execution?.id ?? '')).toBe(false);
  });

  it('refuses to start a run while the node’s plugin is not active', async () => {
    const host = labHost();
    const system = await releaseWithPluginNode(host);
    const { registry } = await plugins(host);
    await plugins(host, { type: 'setEnabled', expectedRevision: registry.revision, id: 'example.pipeline-pack', enabled: false });
    const refused = await rejection(call(host, 'orchestration_start_run_v6', {
      workspaceId: system.workspaceId, runId: labUuid('test:plugin-off'), teamId: system.teamId, pipelineId: system.pipelineId,
    }));
    expect(refused).toMatchObject({ code: 'runtime-unavailable' });
  });
});
