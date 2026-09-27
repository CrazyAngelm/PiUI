import type { AcpAgentDescriptorV1, CommandLineV1 } from '../../../../../contracts/harness-registry-v1';
import type { PluginManifest, PluginPermission, PluginValue } from '../../../../../contracts/piui-plugin-v2';
import {
  PLUGINS_EVENT_V1,
  type PluginBackendState,
  type PluginCommandRequestV1,
  type PluginCommandResultV1,
  type PluginEntryV1,
  type PluginLogEntryV1,
  type PluginLogEvent,
  type PluginProblemV1,
  type PluginReviewV1,
  type PluginsCommandV1,
  type PluginsErrorCode,
  type PluginsRegistryV1,
  type PluginsResponseV1,
  type PluginTemplateRequestV1,
  type PluginTemplateResultV1,
} from '../../../../../contracts/plugins-v1';
import helloManifest from '../../../../../examples/plugins/hello-command/piui-plugin.json';
import themeManifest from '../../../../../examples/plugins/midnight-theme/piui-plugin.json';
import packManifest from '../../../../../examples/plugins/pipeline-pack/piui-plugin.json';
import acpManifest from '../../../../../examples/plugins/acp-agent/piui-plugin.json';
import statusManifest from '../../../../../examples/plugins/status-tools/piui-plugin.json';
import collectTemplate from '../../../../../examples/plugins/pipeline-pack/templates/collect-and-reshape.piui.json?raw';
import draftTemplate from '../../../../../examples/plugins/pipeline-pack/templates/draft-and-critique.piui.json?raw';
import { transformJson } from '../../../../../examples/plugins/pipeline-pack/backend/transform.mjs';
import type { PiUiContributionCatalog } from '../types';
import { checkPluginManifest, resolvePluginValues, v2Contributions } from '../pluginManifest';
import { labAcpRegistry } from './acpFake';
import type { LabEventBus } from './labBus';
import type { LabClock } from './labClock';
import type { HostErrorPayload } from './labErrors';
import type { LabHandlers } from './labHandlers';
import { labUuid } from './labRandom';
import { boolean, decodeArgument, enumOf, json, object, option, string, tagged, u64, type Schema } from './labSchema';
import type { LabState } from './labState';
import type { LabSessions } from './sessionRuntime';

/**
 * UI Lab plugin host: the fake of `plugins_v1`, `plugin_command_v1`,
 * `plugin_template_v1` and the Pi extension `list_piui_contributions` route.
 * Rules mirror `apps/desktop/src-tauri/src/plugins/`: a review before every
 * install (the reviewed code hash must match), revision checks, settings
 * checked against their declarations, safe mode read-only, and nothing
 * activating while a plugin has problems. Nothing runs: commands answer from
 * small scripts, and the pipeline pack's node runs the example's pure
 * transform. The fake picker offers a "Word count" package (folder or .zip)
 * and a "Dev notes" development folder.
 *
 * Scenarios `demo` and `long` install the four example plugins (the ACP one
 * disabled) and a "Broken sample" whose backend keeps crashing; `safe` lists
 * them read-only; `empty` has none.
 */

const LAB_PIUI = '0.1.1';
const NODE = 'C:/Program Files/nodejs/node.exe';
/** What the lab's Node.js enforces (v1.1): a current Node.js without `--allow-net`. */
const LIMITS = { nodeVersion: 'v24.13.0', enforced: true, network: false } as const;
const DATA = 'C:/Users/example/AppData/Roaming/dev.piui.desktop/plugins-v1/packages';
const COMMAND_LATENCY_MS = 150;

const MESSAGES: Readonly<Record<PluginsErrorCode, string>> = {
  SAFE_MODE: 'Plugins cannot be changed or run in safe mode.',
  CONFLICT: 'The plugin list changed. Review it and try again.',
  INVALID_PACKAGE: 'This is not a valid PiUI plugin package.',
  INCOMPATIBLE: 'This plugin does not support this PiUI version.',
  DUPLICATE: 'A plugin with this ID is already installed another way. Remove it first.',
  NOT_FOUND: 'This plugin or its contribution no longer exists.',
  REVIEW_EXPIRED: 'This review expired. Choose the package again.',
  TRUST_CHANGED: 'The package changed after you reviewed it. Review it again.',
  INACTIVE: 'This plugin is not active. Check it in Settings → Plugins.',
  PERMISSION_DENIED: 'The plugin does not have permission for this.',
  INVALID_SETTINGS: 'These settings are not valid.',
  BACKEND_UNAVAILABLE: "The plugin's backend could not start.",
  BACKEND_FAILED: 'The plugin reported an error.',
  BACKEND_TIMEOUT: 'The plugin did not answer in time. Its backend was stopped.',
  LIMIT: 'Remove a plugin before adding another (64 at most).',
  IO_ERROR: 'PiUI could not save the plugin list.',
};

function failure(code: PluginsErrorCode, extra: { message?: string; problems?: PluginProblemV1[]; detail?: string } = {}): HostErrorPayload & { problems?: PluginProblemV1[]; detail?: string } {
  return { code, message: extra.message ?? MESSAGES[code], recoverable: true, ...(extra.problems ? { problems: extra.problems } : {}), ...(extra.detail ? { detail: extra.detail } : {}) };
}

function manifest(value: unknown): PluginManifest {
  const checked = checkPluginManifest(value, LAB_PIUI);
  if (!checked.ok) throw new Error(`Lab plugin manifest is invalid: ${JSON.stringify(checked.problems)}`);
  return checked.manifest;
}

const HELLO = manifest(helloManifest);
const THEMES = manifest(themeManifest);
const PACK = manifest(packManifest);
const ACP = manifest(acpManifest);
const STATUS = manifest(statusManifest);

const WORD_COUNT = manifest({
  schemaVersion: 1,
  id: 'lab.word-count',
  name: 'Word count',
  version: '0.3.0',
  publisher: 'Lab Tools',
  description: 'Counts words in the open chat and prepares a reminder to keep answers short.',
  engines: { piui: '>=0.1.0 <1.0.0' },
  permissions: ['commands', 'chat.read'],
  backend: { entry: 'backend/main.mjs' },
  contributes: {
    commands: [{ id: 'count-words', title: 'Count words', description: 'Prepares a length reminder for the open chat.', surfaces: ['palette', 'composer'] }],
  },
});

const DEV_NOTES = manifest({
  schemaVersion: 1,
  id: 'lab.dev-notes',
  name: 'Dev notes',
  version: '0.0.1',
  publisher: 'You',
  description: 'A plugin you are writing, loaded from its folder.',
  engines: { piui: '>=0.1.0 <1.0.0' },
  permissions: ['commands'],
  contributes: {
    commands: [{ id: 'todo', title: 'Insert TODO list', surfaces: ['composer'], insertText: 'TODO:\n- ' }],
  },
});

const BROKEN = manifest({
  schemaVersion: 1,
  id: 'lab.broken-sample',
  name: 'Broken sample',
  version: '2.0.1',
  publisher: 'Lab Tools',
  description: 'Its backend exits right after it starts, to show how PiUI contains a crashing plugin.',
  engines: { piui: '>=0.1.0 <1.0.0' },
  permissions: ['commands', 'network'],
  backend: { entry: 'dist/server.mjs' },
  contributes: {
    commands: [{ id: 'check', title: 'Run the broken check', surfaces: ['palette'] }],
  },
});

const TEMPLATES: Readonly<Record<string, string>> = {
  'example.pipeline-pack/draft-and-critique': draftTemplate,
  'example.pipeline-pack/collect-and-reshape': collectTemplate,
};

/** Tier 1A declarative contributions of a globally installed Pi package. */
const PI_CONTRIBUTIONS: PiUiContributionCatalog = {
  commands: [
    { extensionId: 'lab.project-health', extensionName: 'Project health', id: 'lab.project-health.status', title: 'Show project health', description: 'Asks Pi for the health report of this project.', commandName: 'health' },
  ],
  composerActions: [
    { extensionId: 'lab.project-health', extensionName: 'Project health', id: 'lab.project-health.action', title: 'Health report', commandId: 'lab.project-health.status', commandName: 'health', order: 120 },
  ],
};

interface LabPlugin {
  manifest: PluginManifest;
  source: 'installed' | 'development';
  root: string;
  enabled: boolean;
  codeHash: string;
  installedAt: string;
  settings: Record<string, PluginValue>;
  problems: PluginProblemV1[];
  backendState: PluginBackendState;
  restarts: number;
  log: PluginLogEntryV1[];
  /** Lab behaviour of the broken sample. */
  crashing?: boolean;
}

interface LabStaged {
  manifest: PluginManifest;
  source: 'folder' | 'zip' | 'development';
  location: string;
  root: string;
  codeHash: string;
  files: number;
  bytes: number;
}

const hash = (seed: string): string => labUuid(seed).replaceAll('-', '').repeat(2);

/** The origin panels load from: the host protocol origin (and the dev server's port in development). */
export function labPluginOrigin(): string {
  const port = typeof window !== 'undefined' && import.meta.env.DEV ? window.location.port : '';
  return port ? `http://piui-plugin.localhost:${port}` : 'http://piui-plugin.localhost';
}

const PERMISSION_ORDER: readonly PluginPermission[] = [
  'commands', 'ui.panel', 'ui.settings', 'node.run', 'acp.agents', 'chat.read', 'notifications', 'project.read', 'project.write', 'network',
];
const sortedPermissions = (permissions: readonly PluginPermission[]): PluginPermission[] =>
  [...new Set(permissions)].sort((left, right) => PERMISSION_ORDER.indexOf(left) - PERMISSION_ORDER.indexOf(right));

export class LabPluginHost {
  revision: number;
  private readonly plugins: LabPlugin[] = [];
  private readonly staged = new Map<string, LabStaged>();
  private activeTheme: { pluginId: string; themeId: string } | undefined;
  private acpReport: [string, string, boolean][] = [];
  private stagingSerial = 0;

  constructor(private readonly runtime: LabSessions, private readonly bus: LabEventBus, private readonly clock: LabClock) {
    const { state } = runtime;
    const seeded = state.scenario !== 'empty';
    if (seeded) {
      const at = clock.iso();
      const add = (plugin: PluginManifest, extra: Partial<LabPlugin> = {}) =>
        this.plugins.push({
          manifest: plugin,
          source: 'installed',
          root: `${DATA}/${labUuid(plugin.id)}`,
          enabled: true,
          codeHash: hash(plugin.id),
          installedAt: at,
          settings: {},
          problems: [],
          backendState: 'stopped',
          restarts: 0,
          log: [{ at, event: 'installed' }],
          ...extra,
        });
      add(HELLO);
      add(THEMES);
      add(PACK);
      add(STATUS);
      add(ACP, { enabled: false, log: [{ at, event: 'installed' }, { at, event: 'disabled' }] });
      add(BROKEN, {
        crashing: true,
        backendState: 'crash-loop',
        restarts: 4,
        log: (['installed', 'backend-started', 'backend-crashed', 'backend-started', 'backend-crashed', 'backend-started', 'backend-crashed', 'crash-loop'] as PluginLogEvent[]).map((event) => ({ at, event })),
      });
    }
    this.revision = seeded ? 5 : 0;
    this.syncAcp(false);
  }

  private get safeMode(): boolean {
    return this.runtime.state.safeMode;
  }

  private find(id: string): LabPlugin | undefined {
    return this.plugins.find((plugin) => plugin.manifest.id === id);
  }

  private isActive(plugin: LabPlugin): boolean {
    return plugin.enabled && !this.safeMode && plugin.problems.length === 0;
  }

  private settingsOf(plugin: LabPlugin): Record<string, PluginValue> {
    const fields = plugin.manifest.contributes.settings ?? [];
    const resolved = resolvePluginValues(fields, plugin.settings);
    if (resolved.ok) return resolved.values;
    const defaults = resolvePluginValues(fields, {});
    return defaults.ok ? defaults.values : {};
  }

  /** The host's command line: Node's permission flags for the package and its data folder, then the entry. */
  private commandLine(plugin: { manifest: PluginManifest; root: string }): CommandLineV1 | undefined {
    if (!plugin.manifest.backend) return undefined;
    const data = `${DATA}/data/${labUuid(`data:${plugin.manifest.id}`)}`;
    return {
      program: NODE,
      args: [
        '--permission',
        `--allow-fs-read=${plugin.root}`,
        `--allow-fs-read=${data}`,
        `--allow-fs-write=${data}`,
        `${plugin.root}/${plugin.manifest.backend.entry}`,
      ],
    };
  }

  private entry(plugin: LabPlugin): PluginEntryV1 {
    const { manifest: m } = plugin;
    const active = this.isActive(plugin);
    const line = this.commandLine(plugin);
    const contributes = m.contributes;
    const added = v2Contributions(m);
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      publisher: m.publisher,
      ...(m.description ? { description: m.description } : {}),
      source: plugin.source,
      ...(plugin.source === 'development' ? { folder: plugin.root } : {}),
      enabled: plugin.enabled,
      active,
      permissions: sortedPermissions(m.permissions),
      codeHash: plugin.codeHash,
      installedAt: plugin.installedAt,
      ...(line ? { backend: { state: plugin.backendState, restarts: plugin.restarts, commandLine: line, nodeFound: true, limits: { ...LIMITS } } } : {}),
      problems: structuredClone(plugin.problems),
      log: structuredClone(plugin.log),
      contributes: {
        commands: (contributes.commands ?? []).map((command) => ({
          id: command.id,
          title: command.title,
          ...(command.description ? { description: command.description } : {}),
          surfaces: command.surfaces ?? ['palette'],
          ...(command.insertText !== undefined ? { insertText: command.insertText } : {}),
        })),
        settings: structuredClone(contributes.settings ?? []),
        panels: (contributes.panels ?? []).map((panel) => ({
          ...panel,
          ...(active && m.ui && m.permissions.includes('ui.panel') ? { url: `${labPluginOrigin()}/${m.id}/${m.ui.entry}?panel=${panel.id}` } : {}),
        })),
        themes: (contributes.themes ?? []).map((theme) => ({ id: theme.id, label: theme.label, appearance: theme.appearance, tokens: { ...theme.tokens } as Record<string, string> })),
        templates: (contributes.templates ?? []).map((template) => ({ id: template.id, title: template.title, ...(template.description ? { description: template.description } : {}) })),
        nodeTypes: (contributes.nodeTypes ?? []).map((node) => ({
          id: node.id,
          title: node.title,
          ...(node.description ? { description: node.description } : {}),
          config: structuredClone(node.config ?? []),
          timeoutSeconds: node.timeoutSeconds ?? 60,
          resultFields: structuredClone(node.resultFields ?? []),
        })),
        acpAgents: (contributes.acpAgents ?? []).map((agent: AcpAgentDescriptorV1) => ({
          id: agent.id,
          displayName: agent.displayName,
          registered: this.acpReport.some(([pluginId, id, registered]) => pluginId === m.id && id === agent.id && registered),
        })),
        ...(added.statusItems.length
          ? {
              statusItems: added.statusItems.map((item) => ({
                id: item.id,
                text: item.text,
                ...(item.tooltip ? { tooltip: item.tooltip } : {}),
                ...(item.command ? { command: item.command } : {}),
                alignment: item.alignment ?? 'end',
              })),
            }
          : {}),
        ...(added.keybindings.length ? { keybindings: added.keybindings.map((binding) => ({ command: binding.command, key: binding.key })) } : {}),
        ...(added.renderers.length
          ? {
              renderers: added.renderers.map((renderer) => ({
                id: renderer.id,
                title: renderer.title,
                toolNames: [...renderer.toolNames],
                ...(active && m.ui && (m.permissions as readonly PluginPermission[]).includes('ui.renderer') ? { url: `${labPluginOrigin()}/${m.id}/${m.ui.entry}?renderer=${renderer.id}` } : {}),
              })),
            }
          : {}),
      },
      settings: this.settingsOf(plugin),
    };
  }

  view(): PluginsRegistryV1 {
    return {
      protocol: 1,
      revision: this.revision,
      safeMode: this.safeMode,
      checked: true,
      piuiVersion: LAB_PIUI,
      ...(this.activeTheme ? { activeTheme: { ...this.activeTheme } } : {}),
      plugins: this.plugins.map((plugin) => this.entry(plugin)),
    };
  }

  private changed(): void {
    this.bus.emit(PLUGINS_EVENT_V1, { protocol: 1, revision: this.revision });
  }

  private transact(expectedRevision: number, change: () => void): void {
    if (expectedRevision !== this.revision) throw failure('CONFLICT');
    change();
    this.revision += 1;
  }

  private record(plugin: LabPlugin, event: PluginLogEvent): void {
    plugin.log = [...plugin.log, { at: this.clock.iso(), event }].slice(-20);
  }

  /** Registers the ACP agents of active plugins with the lab harness registry. */
  private syncAcp(notify = true): void {
    const registry = labAcpRegistry(this.runtime.state);
    if (registry === undefined) return;
    const agents = this.safeMode
      ? []
      : this.plugins
          .filter((plugin) => this.isActive(plugin) && plugin.manifest.permissions.includes('acp.agents'))
          .flatMap((plugin) => (plugin.manifest.contributes.acpAgents ?? []).map((descriptor) => ({ pluginId: plugin.manifest.id, pluginName: plugin.manifest.name, descriptor })));
    this.acpReport = registry.setPluginAgents(agents);
    if (notify) this.changed();
  }

  private review(stagingId: string, staged: LabStaged): PluginReviewV1 {
    const { manifest: m } = staged;
    const previous = this.find(m.id);
    const permissions = sortedPermissions(m.permissions);
    const line = this.commandLine(staged);
    const added = v2Contributions(m);
    return {
      stagingId,
      source: staged.source,
      location: staged.location,
      id: m.id,
      name: m.name,
      version: m.version,
      publisher: m.publisher,
      ...(m.description ? { description: m.description } : {}),
      permissions,
      ...(line ? { backend: { commandLine: line, nodeFound: true, limits: { ...LIMITS } } } : {}),
      codeHash: staged.codeHash,
      files: staged.files,
      bytes: staged.bytes,
      contributes: {
        commands: (m.contributes.commands ?? []).map((command) => command.title),
        settings: (m.contributes.settings ?? []).length,
        panels: (m.contributes.panels ?? []).map((panel) => panel.title),
        themes: (m.contributes.themes ?? []).map((theme) => theme.label),
        templates: (m.contributes.templates ?? []).map((template) => template.title),
        nodeTypes: (m.contributes.nodeTypes ?? []).map((node) => node.title),
        acpAgents: (m.contributes.acpAgents ?? []).map((agent) => ({ id: agent.id, displayName: agent.displayName, commandLine: { program: agent.command.program, args: [...(agent.command.args ?? [])] } })),
        ...(added.statusItems.length ? { statusItems: added.statusItems.map((item) => item.text) } : {}),
        ...(added.keybindings.length
          ? { keybindings: added.keybindings.map((binding) => ({ command: (m.contributes.commands ?? []).find((command) => command.id === binding.command)?.title ?? binding.command, key: binding.key })) }
          : {}),
        ...(added.renderers.length ? { renderers: added.renderers.map((renderer) => renderer.title) } : {}),
      },
      ...(previous
        ? {
            update: {
              fromVersion: previous.manifest.version,
              permissionsAdded: permissions.filter((permission) => !(previous.manifest.permissions as readonly PluginPermission[]).includes(permission)),
              permissionsRemoved: sortedPermissions(previous.manifest.permissions).filter((permission) => !permissions.includes(permission)),
              codeChanged: previous.codeHash !== staged.codeHash,
            },
          }
        : {}),
      alreadyInstalled: staged.source !== 'development' && previous !== undefined && previous.source === 'installed'
        && previous.manifest.version === m.version && previous.codeHash === staged.codeHash,
    };
  }

  private stage(source: 'folder' | 'zip' | 'development'): [string, LabStaged] {
    const development = source === 'development';
    const plugin = development ? DEV_NOTES : WORD_COUNT;
    const existing = this.find(plugin.id);
    if (existing && (existing.source === 'development') !== development) throw failure('DUPLICATE');
    this.stagingSerial += 1;
    const stagingId = labUuid(`staging:${this.stagingSerial}`);
    const location = development ? 'C:/Users/example/code/dev-notes' : source === 'zip' ? 'C:/Users/example/Downloads/word-count-0.3.0.zip' : 'C:/Users/example/Downloads/word-count';
    const staged: LabStaged = {
      manifest: plugin,
      source,
      location,
      root: development ? location : `${DATA}/${labUuid(`package:${stagingId}`)}`,
      codeHash: hash(`${plugin.id}@${plugin.version}`),
      files: development ? 1 : 3,
      bytes: development ? 612 : 4_318,
    };
    this.staged.set(stagingId, staged);
    return [stagingId, staged];
  }

  async run(command: PluginsCommandV1): Promise<PluginsResponseV1> {
    if (command.type !== 'list' && this.safeMode) throw failure('SAFE_MODE');
    switch (command.type) {
      case 'list':
        return { registry: this.view() };
      case 'pick': {
        const [stagingId, staged] = this.stage(command.source);
        return { registry: this.view(), review: this.review(stagingId, staged) };
      }
      case 'install': {
        const staged = this.staged.get(command.stagingId);
        if (staged === undefined) throw failure('REVIEW_EXPIRED');
        this.staged.delete(command.stagingId);
        if (staged.codeHash !== command.codeHash) throw failure('TRUST_CHANGED');
        const previous = this.find(staged.manifest.id);
        this.transact(command.expectedRevision, () => {
          const record: LabPlugin = {
            manifest: staged.manifest,
            source: staged.source === 'development' ? 'development' : 'installed',
            root: staged.root,
            enabled: true,
            codeHash: staged.codeHash,
            installedAt: this.clock.iso(),
            settings: previous?.settings ?? {},
            problems: [],
            backendState: 'stopped',
            restarts: 0,
            log: previous?.log ?? [],
          };
          if (previous) this.plugins.splice(this.plugins.indexOf(previous), 1, record);
          else this.plugins.push(record);
          this.record(record, previous ? 'updated' : 'installed');
        });
        this.syncAcp(false);
        this.changed();
        return { registry: this.view() };
      }
      case 'discard':
        this.staged.delete(command.stagingId);
        return { registry: this.view() };
      case 'setEnabled': {
        const plugin = this.find(command.id);
        if (plugin === undefined) throw failure('NOT_FOUND');
        this.transact(command.expectedRevision, () => {
          plugin.enabled = command.enabled;
          if (!command.enabled && plugin.backendState === 'running') plugin.backendState = 'stopped';
          this.record(plugin, command.enabled ? 'enabled' : 'disabled');
        });
        this.syncAcp(false);
        this.changed();
        return { registry: this.view() };
      }
      case 'remove': {
        const plugin = this.find(command.id);
        if (plugin === undefined) throw failure('NOT_FOUND');
        this.transact(command.expectedRevision, () => {
          this.plugins.splice(this.plugins.indexOf(plugin), 1);
          if (this.activeTheme?.pluginId === command.id) this.activeTheme = undefined;
        });
        this.syncAcp(false);
        this.changed();
        return { registry: this.view() };
      }
      case 'reload': {
        const plugin = this.find(command.id);
        if (plugin === undefined || plugin.source !== 'development') throw failure('NOT_FOUND');
        if (command.expectedRevision !== this.revision) throw failure('CONFLICT');
        plugin.backendState = plugin.manifest.backend ? 'stopped' : plugin.backendState;
        this.record(plugin, 'reloaded');
        this.revision += 1;
        this.changed();
        return { registry: this.view() };
      }
      case 'restartBackend': {
        const plugin = this.find(command.id);
        if (plugin === undefined || !this.isActive(plugin)) throw failure('INACTIVE');
        plugin.backendState = 'stopped';
        this.changed();
        return { registry: this.view() };
      }
      case 'setSettings': {
        const plugin = this.find(command.id);
        if (plugin === undefined || !this.isActive(plugin)) throw failure('INACTIVE');
        if (command.origin === 'panel' && !plugin.manifest.permissions.includes('ui.settings')) throw failure('PERMISSION_DENIED');
        const merged = { ...plugin.settings, ...command.values };
        const resolved = resolvePluginValues(plugin.manifest.contributes.settings ?? [], merged);
        if (!resolved.ok) throw failure('INVALID_SETTINGS', { problems: [{ code: 'field', message: resolved.message, subject: resolved.key }] });
        this.transact(command.expectedRevision, () => {
          plugin.settings = merged;
        });
        this.changed();
        return { registry: this.view() };
      }
      case 'setTheme': {
        const theme = command.theme;
        if (theme !== null) {
          const plugin = this.find(theme.pluginId);
          if (plugin === undefined || !this.isActive(plugin)) throw failure('INACTIVE');
          if (!(plugin.manifest.contributes.themes ?? []).some((candidate) => candidate.id === theme.themeId)) throw failure('NOT_FOUND');
        }
        this.transact(command.expectedRevision, () => {
          this.activeTheme = theme === null ? undefined : { ...theme };
        });
        this.changed();
        return { registry: this.view() };
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  async runCommand(request: PluginCommandRequestV1): Promise<PluginCommandResultV1> {
    if (this.safeMode) throw failure('SAFE_MODE');
    const plugin = this.find(request.pluginId);
    if (plugin === undefined || !this.isActive(plugin)) throw failure('INACTIVE');
    const command = (plugin.manifest.contributes.commands ?? []).find((item) => item.id === request.commandId);
    if (command === undefined) throw failure('NOT_FOUND');
    const surfaces = command.surfaces ?? ['palette'];
    const added = v2Contributions(plugin.manifest);
    const allowed = request.origin === 'panel'
      || (request.origin === 'status'
        ? (plugin.manifest.permissions as readonly PluginPermission[]).includes('ui.status') && added.statusItems.some((item) => item.command === command.id)
        : request.origin === 'keybinding'
          ? added.keybindings.some((binding) => binding.command === command.id)
          : surfaces.includes(request.origin));
    if (!allowed) throw failure('PERMISSION_DENIED');
    if (command.insertText !== undefined) return { protocol: 1, text: command.insertText };
    await this.clock.delay(COMMAND_LATENCY_MS);
    if (plugin.crashing) {
      if (plugin.backendState === 'crash-loop') {
        throw failure('BACKEND_UNAVAILABLE', { message: "The plugin's backend keeps stopping. Restart it in Settings → Plugins." });
      }
      plugin.backendState = 'crashed';
      plugin.restarts += 1;
      this.record(plugin, 'backend-crashed');
      this.changed();
      throw failure('BACKEND_FAILED', { message: "The plugin's backend stopped before it answered." });
    }
    if (plugin.backendState !== 'running') {
      plugin.backendState = 'running';
      this.record(plugin, 'backend-started');
      this.changed();
    }
    const settings = this.settingsOf(plugin);
    const chat = request.sessionId && plugin.manifest.permissions.includes('chat.read') ? this.runtime.record(request.sessionId) : undefined;
    switch (`${plugin.manifest.id}/${command.id}`) {
      case 'example.hello-command/say-hello': {
        const greeting = typeof settings.greeting === 'string' && settings.greeting.trim() ? settings.greeting.trim() : 'Hello';
        const where = chat ? ` to “${chat.title}”` : '';
        return {
          protocol: 1,
          notice: `${greeting}${where} from the Hello command plugin!`,
          ...(settings.prepareText === true && chat ? { text: `${greeting}! Could you summarize where we are?` } : {}),
        };
      }
      case 'example.status-tools/chat-title': {
        if (!chat) return { protocol: 1, notice: 'Open a chat to see its title.' };
        const words = chat.title.trim().split(/\s+/u).filter(Boolean).length;
        return { protocol: 1, notice: `“${chat.title}” (${words} ${words === 1 ? 'word' : 'words'})` };
      }
      case 'lab.word-count/count-words': {
        const words = chat ? chat.blocks.reduce((total, block) => total + JSON.stringify(block).split(/\s+/).length, 0) : 0;
        return { protocol: 1, notice: chat ? `About ${words} words in this chat.` : 'No chat is open.', text: 'Please keep your next answer under 200 words.' };
      }
      default:
        return { protocol: 1, notice: `${command.title} finished.` };
    }
  }

  template(request: PluginTemplateRequestV1): PluginTemplateResultV1 {
    if (this.safeMode) throw failure('SAFE_MODE');
    const plugin = this.find(request.pluginId);
    if (plugin === undefined || !this.isActive(plugin)) throw failure('INACTIVE');
    const text = TEMPLATES[`${request.pluginId}/${request.templateId}`];
    if (text === undefined) throw failure('NOT_FOUND');
    return { protocol: 1, text };
  }

  /** A runnable node type for the lab run scheduler, like `PluginsState::node_spec`. */
  node(pluginId: string, nodeType: string): { fields: NonNullable<NonNullable<PluginManifest['contributes']['nodeTypes']>[number]['config']>; run: (params: { config: Record<string, PluginValue>; inputs: Record<string, unknown>; dependencies: Record<string, { text: string | null; data: Record<string, unknown> | null }> }) => Record<string, unknown> | string } | undefined {
    const plugin = this.find(pluginId);
    if (plugin === undefined || !this.isActive(plugin) || !plugin.manifest.permissions.includes('node.run')) return undefined;
    const node = (plugin.manifest.contributes.nodeTypes ?? []).find((item) => item.id === nodeType);
    if (node === undefined) return undefined;
    return {
      fields: node.config ?? [],
      run: (params) => pluginId === 'example.pipeline-pack' && nodeType === 'json-transform'
        ? transformJson(params)
        : { node: nodeType, inputs: Object.keys(params.inputs), dependencies: Object.keys(params.dependencies) },
    };
  }
}

const hosts = new WeakMap<LabState, LabPluginHost>();

/** The lab plugin host of `state` (the run scheduler asks it for node types). */
export function labPluginHost(state: LabState): LabPluginHost | undefined {
  return hosts.get(state);
}

const pluginId = string;
const commandSchema: Schema = tagged('type', {
  list: {},
  pick: { source: enumOf(['folder', 'zip', 'development']) },
  install: { expectedRevision: u64, stagingId: string, codeHash: string },
  discard: { stagingId: string },
  setEnabled: { expectedRevision: u64, id: pluginId, enabled: boolean },
  remove: { expectedRevision: u64, id: pluginId },
  reload: { expectedRevision: u64, id: pluginId },
  restartBackend: { id: pluginId },
  setSettings: { expectedRevision: u64, id: pluginId, values: json, origin: option(enumOf(['settings', 'panel'])) },
  setTheme: { expectedRevision: u64, theme: option(object({ pluginId: string, themeId: string })) },
});
const commandRequestSchema = object({
  pluginId: string,
  commandId: string,
  sessionId: option(string),
  origin: enumOf(['palette', 'composer', 'panel', 'status', 'keybinding']),
});
const templateRequestSchema = object({ pluginId: string, templateId: string });

export function pluginHandlers(runtime: LabSessions, bus: LabEventBus): LabHandlers {
  const host = new LabPluginHost(runtime, bus, runtime.clock);
  hosts.set(runtime.state, host);
  return {
    plugins_v1: (args) => {
      const command = decodeArgument<PluginsCommandV1>(args, 'command', commandSchema);
      // serde maps an absent optional theme to null.
      if (command.type === 'setTheme' && command.theme === undefined) return host.run({ ...command, theme: null });
      return host.run(command);
    },
    plugin_command_v1: (args) => host.runCommand(decodeArgument<PluginCommandRequestV1>(args, 'request', commandRequestSchema)),
    plugin_template_v1: (args) => host.template(decodeArgument<PluginTemplateRequestV1>(args, 'request', templateRequestSchema)),
    list_piui_contributions: () => (runtime.state.safeMode || runtime.state.scenario === 'empty' ? { commands: [], composerActions: [] } : structuredClone(PI_CONTRIBUTIONS)),
  };
}
