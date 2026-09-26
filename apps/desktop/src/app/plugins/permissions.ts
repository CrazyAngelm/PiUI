import type { PluginPermission } from '../../../../../contracts/piui-plugin-v1';
import type { PluginBackendState, PluginLogEvent } from '../../../../../contracts/plugins-v1';

/**
 * Plain words for every plugin permission, shown in the trust review and in
 * Settings → Plugins (English source strings of the locale catalog). The
 * details say honestly what PiUI enforces and what it only reports.
 */
export const PERMISSION_TEXT: Readonly<Record<PluginPermission, { label: string; detail: string }>> = {
  commands: {
    label: 'Add commands to the command palette and the message box',
    detail: 'Commands run only when you choose them. Text they prepare waits for you to send it.',
  },
  'ui.panel': {
    label: 'Show panels in chat details',
    detail: 'Panels run in an isolated frame without access to PiUI, your files or the network.',
  },
  'ui.settings': {
    label: 'Keep its own settings in PiUI',
    detail: 'PiUI shows the settings form and stores the values.',
  },
  'node.run': {
    label: 'Run its own pipeline nodes',
    detail: "Nodes run in the plugin's backend when a pipeline in a trusted project reaches them.",
  },
  'acp.agents': {
    label: 'Add ACP agents to Settings → Harnesses',
    detail: 'Each agent runs only after you trust its exact command line there.',
  },
  'chat.read': {
    label: 'See the title of the open chat',
    detail: 'Never the messages.',
  },
  notifications: {
    label: 'Show notices',
    detail: 'Short messages in PiUI.',
  },
  'project.read': {
    label: 'Read files in your project folder',
    detail: 'The backend receives the project path. PiUI does not limit what it reads.',
  },
  'project.write': {
    label: 'Change files in your project folder',
    detail: 'The backend receives the project path and can change files.',
  },
  network: {
    label: 'Use the network',
    detail: "Declared by the plugin; PiUI does not block its backend's network access.",
  },
};

export const BACKEND_STATE_TEXT: Readonly<Record<PluginBackendState, string>> = {
  stopped: 'Starts when needed',
  starting: 'Starting…',
  running: 'Running',
  crashed: 'Stopped unexpectedly; restarts on next use',
  'crash-loop': 'Keeps stopping; restart it to try again',
  unavailable: 'Node.js was not found',
};

export const LOG_TEXT: Readonly<Record<PluginLogEvent, string>> = {
  installed: 'Installed',
  updated: 'Updated',
  enabled: 'Enabled',
  disabled: 'Disabled',
  reloaded: 'Reloaded from its folder',
  'verification-failed': 'Did not pass the start-up check',
  'backend-started': 'Backend started',
  'backend-stopped': 'Backend stopped',
  'backend-crashed': 'Backend stopped unexpectedly',
  'backend-timeout': 'Backend did not answer in time and was stopped',
  'backend-protocol': 'Backend sent something PiUI does not accept and was stopped',
  'backend-start-failed': 'Backend could not start',
  'crash-loop': 'Backend kept stopping; automatic restarts paused',
};

/** A short, readable size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The command line as one readable string (display only; never run). */
export function commandLineText(line: { program: string; args: readonly string[] }): string {
  const quote = (value: string) => (/[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);
  return [line.program, ...line.args].map(quote).join(' ');
}
