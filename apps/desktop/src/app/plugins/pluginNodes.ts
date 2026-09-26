import type { PluginValue } from '../../../../../contracts/piui-plugin-v1';
import type { PluginEntryV1, PluginNodeTypeV1 } from '../../../../../contracts/plugins-v1';
import type { GraphNode } from '../../features/orchestration/agentGraph';
import { resolvePluginValues } from '../../host-api/pluginManifest';
import { EXECUTOR_ISSUES } from '../../host-api/stepExecutors';

/** One Add-menu entry for a plugin node type (orchestration v6.5). */
export interface PluginNodeMenuEntry {
  readonly label: string;
  readonly node: { pluginId: string; nodeType: string; title: string; config: Record<string, PluginValue> };
  readonly resultFields: GraphNode['resultFields'];
}

/** The declared defaults a new node starts with. */
export function defaultConfig(nodeType: PluginNodeTypeV1): Record<string, PluginValue> {
  return Object.fromEntries(nodeType.config.flatMap((field) => (field.default === undefined ? [] : [[field.key, field.default]])));
}

export function pluginNodeMenu(nodeTypes: readonly { plugin: PluginEntryV1; nodeType: PluginNodeTypeV1 }[]): PluginNodeMenuEntry[] {
  const titles = new Map<string, number>();
  for (const { nodeType } of nodeTypes) titles.set(nodeType.title, (titles.get(nodeType.title) ?? 0) + 1);
  return nodeTypes.map(({ plugin, nodeType }) => ({
    // Two plugins with the same node title are told apart by the plugin name.
    label: (titles.get(nodeType.title) ?? 0) > 1 ? `${nodeType.title} (${plugin.name})` : nodeType.title,
    node: { pluginId: plugin.id, nodeType: nodeType.id, title: nodeType.title, config: defaultConfig(nodeType) },
    resultFields: nodeType.resultFields.map((field) => ({ ...field })),
  }));
}

/**
 * Editor checks of plugin nodes against the plugins PiUI has now: the plugin
 * must be active with `node.run` and still declare the node type, and the
 * configuration must pass the node type's fields. The host checks again when
 * the run starts and when the step is admitted.
 */
export function pluginNodeIssues(
  graph: { nodes: readonly GraphNode[] },
  registry: { nodeType(pluginId: string, nodeType: string): { plugin: PluginEntryV1; nodeType: PluginNodeTypeV1 } | undefined },
): { nodeId: string; message: string }[] {
  return graph.nodes.flatMap((node): { nodeId: string; message: string }[] => {
    const executor = node.executor;
    if (executor?.type !== 'plugin') return [];
    const found = registry.nodeType(executor.pluginId, executor.nodeType);
    if (found === undefined || !found.plugin.active || !found.plugin.permissions.includes('node.run')) {
      return [{ nodeId: node.id, message: EXECUTOR_ISSUES.pluginUnavailable }];
    }
    return resolvePluginValues(found.nodeType.config, executor.config).ok ? [] : [{ nodeId: node.id, message: EXECUTOR_ISSUES.pluginConfig }];
  });
}
