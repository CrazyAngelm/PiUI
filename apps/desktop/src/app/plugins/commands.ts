import type { PluginCommandRequestV1 } from '../../../../../contracts/plugins-v1';
import { pluginsError, pluginsHost, type PluginsClient } from '../../host-api/pluginsClient';
import { toasts } from '../../lib/ui';
import { commandSource, type RegistryCommand } from './pluginRegistry.svelte';

/**
 * Running registry commands (plugin commands and Pi extension
 * contributions). A result's text is prepared in the chat's message box for
 * the person to review: it never sends anything. A notice is shown once.
 */
export interface CommandOutcome {
  readonly text?: string;
  readonly notice?: string;
}

export async function executeCommand(
  command: RegistryCommand,
  origin: PluginCommandRequestV1['origin'],
  sessionId: string | undefined,
  client: PluginsClient = pluginsHost,
): Promise<CommandOutcome> {
  if (command.source === 'pi-extension') return { text: `/${command.commandName} ` };
  if (command.command.insertText !== undefined) return { text: command.command.insertText };
  const result = await client.runCommand({
    pluginId: command.pluginId,
    commandId: command.command.id,
    origin,
    ...(sessionId ? { sessionId } : {}),
  });
  return { ...(result.text !== undefined ? { text: result.text } : {}), ...(result.notice !== undefined ? { notice: result.notice } : {}) };
}

/** Prepares `text` in a chat's message box (an empty box takes it; a draft is kept and the text waits). */
export async function prepareInChat(sessionId: string, text: string): Promise<void> {
  const { extensionSurfaces } = await import('../chat/extensions/extensionSurfaces.svelte');
  extensionSurfaces.prepareText(sessionId, text);
}

type Translate = (value: string, parameters?: readonly unknown[]) => string;

/**
 * Runs `command` for the chat `sessionId` (if any) and shows what it
 * returned. Errors become one toast; nothing is thrown.
 */
export async function runRegistryCommand(
  command: RegistryCommand,
  origin: PluginCommandRequestV1['origin'],
  sessionId: string | undefined,
  t: Translate,
): Promise<CommandOutcome | undefined> {
  let outcome: CommandOutcome;
  try {
    outcome = await executeCommand(command, origin, sessionId);
  } catch (error) {
    const failure = pluginsError(error);
    toasts.error(t('{0} could not run the command', [commandSource(command)]), failure.detail ?? t(failure.message));
    return undefined;
  }
  if (outcome.notice) toasts.show({ title: commandSource(command), description: outcome.notice });
  if (outcome.text !== undefined) {
    if (sessionId) await prepareInChat(sessionId, outcome.text);
    else toasts.show({ tone: 'warning', title: t('Open a chat to use the prepared text'), description: t('{0} prepared text for a message box.', [commandSource(command)]) });
  }
  return outcome;
}
