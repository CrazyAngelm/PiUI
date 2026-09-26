import type {
  PluginCommandV1,
  PluginEntryV1,
  PluginNodeTypeV1,
  PluginPanelV1,
  PluginsCommandV1,
  PluginsRegistryV1,
  PluginsResponseV1,
  PluginTemplateV1,
  PluginThemeV1,
} from '../../../../../contracts/plugins-v1';
import { pluginsError, pluginsHost, type PluginsClient } from '../../host-api/pluginsClient';
import { hostInvoke } from '../../host-api/transport';
import type { PiUiContributionCatalog } from '../../host-api/types';

/**
 * Plugins as the UI sees them (ADR-032): the host registry, the
 * contributions of active plugins, and the Pi extension "Tier 1A" commands
 * and composer actions (`piui.manifest.json`) projected through the same
 * command registry. Loaded on first use, never on the first-paint path.
 */

/** One command the palette or the composer can run. */
export type RegistryCommand =
  | {
      readonly key: string;
      readonly source: 'plugin';
      readonly pluginId: string;
      readonly pluginName: string;
      readonly command: PluginCommandV1;
    }
  | {
      readonly key: string;
      /** A Pi extension's declarative contribution; prepares `/<commandName> ` in a Pi chat. */
      readonly source: 'pi-extension';
      readonly extensionId: string;
      readonly extensionName: string;
      readonly id: string;
      readonly title: string;
      readonly description?: string;
      readonly commandName: string;
      readonly surfaces: readonly ('palette' | 'composer')[];
    };

export function commandTitle(command: RegistryCommand): string {
  return command.source === 'plugin' ? command.command.title : command.title;
}

export function commandSource(command: RegistryCommand): string {
  return command.source === 'plugin' ? command.pluginName : command.extensionName;
}

const EMPTY_CATALOG: PiUiContributionCatalog = { commands: [], composerActions: [] };

export class PluginRegistry {
  registry = $state.raw<PluginsRegistryV1 | undefined>();
  error = $state<string | undefined>();
  loading = $state(false);
  piContributions = $state.raw<PiUiContributionCatalog>(EMPTY_CATALOG);
  private starting: Promise<void> | undefined;
  private unlisten: (() => void) | undefined;
  private request = 0;

  constructor(
    private readonly client: PluginsClient = pluginsHost,
    private readonly listContributions: () => Promise<PiUiContributionCatalog> = () =>
      hostInvoke<PiUiContributionCatalog>('list_piui_contributions'),
  ) {}

  private contributionsLoading: Promise<void> | undefined;

  /** Loads once and follows host changes. */
  start(): Promise<void> {
    this.starting ??= (async () => {
      this.unlisten = await this.client.listen(() => void this.refresh()).catch(() => undefined);
      await this.refresh();
    })();
    return this.starting;
  }

  /**
   * The Pi extension contributions, loaded only when a Pi chat or the
   * palette needs them (listing reads the Pi package inventory).
   */
  loadContributions(): Promise<void> {
    this.contributionsLoading ??= this.refreshContributions();
    return this.contributionsLoading;
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = undefined;
    this.starting = undefined;
  }

  async refresh(): Promise<void> {
    const request = ++this.request;
    this.loading = this.registry === undefined;
    try {
      const response = await this.client.run({ type: 'list' });
      if (request === this.request) {
        this.registry = response.registry;
        this.error = undefined;
      }
    } catch (error) {
      if (request === this.request) this.error = pluginsError(error).message;
    } finally {
      if (request === this.request) this.loading = false;
    }
  }

  async refreshContributions(): Promise<void> {
    try {
      const catalog = await this.listContributions();
      this.piContributions = {
        commands: Array.isArray(catalog?.commands) ? catalog.commands : [],
        composerActions: Array.isArray(catalog?.composerActions) ? catalog.composerActions : [],
      };
    } catch {
      // Tier 1A contributions are optional; a failure only hides them.
      this.piContributions = EMPTY_CATALOG;
    }
  }

  /** Runs a registry command and keeps the returned registry. */
  async run(command: PluginsCommandV1): Promise<PluginsResponseV1> {
    const response = await this.client.run(command);
    this.request += 1;
    this.registry = response.registry;
    this.error = undefined;
    return response;
  }

  get revision(): number {
    return this.registry?.revision ?? 0;
  }

  get safeMode(): boolean {
    return this.registry?.safeMode ?? false;
  }

  get plugins(): readonly PluginEntryV1[] {
    return this.registry?.plugins ?? [];
  }

  get active(): readonly PluginEntryV1[] {
    return this.plugins.filter((plugin) => plugin.active);
  }

  plugin(id: string): PluginEntryV1 | undefined {
    return this.plugins.find((plugin) => plugin.id === id);
  }

  /**
   * Commands for `surface`. Pi extension contributions apply only to a Pi
   * chat (`harness === 'pi'`), where Pi runs the slash command.
   */
  commands(surface: 'palette' | 'composer', harness: string | undefined = undefined): RegistryCommand[] {
    const fromPlugins = this.active.flatMap((plugin) =>
      plugin.contributes.commands
        .filter((command) => command.surfaces.includes(surface))
        .map((command): RegistryCommand => ({
          key: `plugin:${plugin.id}:${command.id}`,
          source: 'plugin',
          pluginId: plugin.id,
          pluginName: plugin.name,
          command,
        })),
    );
    if (harness !== 'pi' || this.safeMode) return fromPlugins;
    const catalog = this.piContributions;
    const fromPi: RegistryCommand[] = surface === 'palette'
      ? catalog.commands.map((command) => ({
          key: `pi:${command.extensionId}:${command.id}`,
          source: 'pi-extension',
          extensionId: command.extensionId,
          extensionName: command.extensionName,
          id: command.id,
          title: command.title,
          ...(command.description ? { description: command.description } : {}),
          commandName: command.commandName,
          surfaces: ['palette'],
        }))
      : [...catalog.composerActions]
          .sort((left, right) => left.order - right.order || left.extensionId.localeCompare(right.extensionId))
          .map((action) => ({
            key: `pi:${action.extensionId}:${action.id}`,
            source: 'pi-extension',
            extensionId: action.extensionId,
            extensionName: action.extensionName,
            id: action.id,
            title: action.title,
            ...(action.description ? { description: action.description } : {}),
            commandName: action.commandName,
            surfaces: ['composer'],
          }));
    return [...fromPlugins, ...fromPi];
  }

  panels(location: PluginPanelV1['location']): { plugin: PluginEntryV1; panel: PluginPanelV1 }[] {
    return this.active.flatMap((plugin) =>
      plugin.contributes.panels
        .filter((panel) => panel.location === location && panel.url !== undefined)
        .map((panel) => ({ plugin, panel })),
    );
  }

  themes(): { plugin: PluginEntryV1; theme: PluginThemeV1 }[] {
    return this.active.flatMap((plugin) => plugin.contributes.themes.map((theme) => ({ plugin, theme })));
  }

  /** The active plugin theme, when its plugin is active. */
  activeTheme(): PluginThemeV1 | undefined {
    const selected = this.registry?.activeTheme;
    if (!selected) return undefined;
    return this.plugin(selected.pluginId)?.active
      ? this.plugin(selected.pluginId)?.contributes.themes.find((theme) => theme.id === selected.themeId)
      : undefined;
  }

  templates(): { plugin: PluginEntryV1; template: PluginTemplateV1 }[] {
    return this.active.flatMap((plugin) => plugin.contributes.templates.map((template) => ({ plugin, template })));
  }

  nodeTypes(): { plugin: PluginEntryV1; nodeType: PluginNodeTypeV1 }[] {
    return this.active
      .filter((plugin) => plugin.permissions.includes('node.run'))
      .flatMap((plugin) => plugin.contributes.nodeTypes.map((nodeType) => ({ plugin, nodeType })));
  }

  /** A node type of any listed plugin (active or not), for the inspector. */
  nodeType(pluginId: string, nodeTypeId: string): { plugin: PluginEntryV1; nodeType: PluginNodeTypeV1 } | undefined {
    const plugin = this.plugin(pluginId);
    const nodeType = plugin?.contributes.nodeTypes.find((item) => item.id === nodeTypeId);
    return plugin && nodeType ? { plugin, nodeType } : undefined;
  }
}

export const pluginRegistry = new PluginRegistry();
