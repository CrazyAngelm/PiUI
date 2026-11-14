import type { PluginStyleSnapshotV1 } from '../../../../contracts/plugin-style-v1';
import type { PluginVisualStyleV1 } from '../../../../contracts/piui-plugin-v3';
import { hostInvoke, type HostInvoke } from './transport';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Enumerated host-owned presets only; never interpret plugin strings as CSS. */
export function isPluginVisualStyle(value: unknown): value is PluginVisualStyleV1 {
  if (!record(value) || Object.keys(value).length === 0) return false;
  return Object.entries(value).every(([key, item]) => {
    switch (key) {
      case 'corners': return item === 'square' || item === 'soft' || item === 'round';
      case 'ornaments': return item === 'plain' || item === 'slanted';
      case 'font': return item === 'system' || item === 'mono';
      default: return false;
    }
  });
}

export function isPluginStyleSnapshot(value: unknown): value is PluginStyleSnapshotV1 {
  if (!record(value) || value.protocol !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || Object.keys(value).some((key) => !['protocol', 'revision', 'theme', 'style'].includes(key))) return false;
  if (value.theme !== undefined && (!record(value.theme) || typeof value.theme.pluginId !== 'string' || typeof value.theme.themeId !== 'string'
    || Object.keys(value.theme).some((key) => key !== 'pluginId' && key !== 'themeId'))) return false;
  return value.style === undefined || (value.theme !== undefined && isPluginVisualStyle(value.style));
}

export async function readPluginStyle(invoke: HostInvoke = hostInvoke): Promise<PluginStyleSnapshotV1> {
  const result: unknown = await invoke('plugin_style_v1', { request: {} });
  if (!isPluginStyleSnapshot(result)) throw new Error('Invalid plugin style snapshot.');
  return result;
}
