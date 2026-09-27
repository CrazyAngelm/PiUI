/**
 * Plugin backend protocol v1 (ADR-032): JSON-RPC 2.0 between the PiUI host
 * and a plugin's Node.js backend over stdio.
 *
 * The host starts `node <backend.entry>` on first use, from the package
 * folder, with a minimal allowlisted environment (no API keys, tokens or PiUI
 * operator variables) and contains the process tree (a Windows Job Object
 * assigned before the process resumes, or a Unix process group). Framing is
 * one JSON object per line, delimited only by LF; stdout carries nothing
 * else (log to stderr, which the host drains and discards). A frame larger
 * than `frameBytes`, a malformed frame or an unexpected message stops the
 * backend with a protocol error. The backend never sends requests in v1.
 *
 * Host → backend: `initialize` (first), `command/execute`, `node/run`,
 * `shutdown` (then the tree is terminated), and the notification
 * `settings/changed`. A request that times out stops the backend; the next
 * use starts it again. Crashes restart with a backoff; five crashes within
 * ten minutes stop it until the user restarts it. A backend is not a
 * sandbox: it runs with the user's file and network access.
 */
import type { PluginPermission, PluginValue } from './piui-plugin-v2';

export const PLUGIN_BACKEND_PROTOCOL = 1 as const;

export const PLUGIN_BACKEND_LIMITS = {
  /** Largest frame the host reads from a backend, without its LF. */
  frameBytes: 1024 * 1024,
  /** Largest command result text (UTF-8 bytes). */
  commandTextBytes: 16 * 1024,
  /** Longest command notice (characters). */
  noticeChars: 500,
  /** Largest node output kept (UTF-8 bytes of the text or the encoded object). */
  nodeOutputBytes: 256 * 1024,
  /** Longest error message kept (UTF-8 bytes). */
  errorMessageBytes: 2 * 1024,
} as const;

export const PLUGIN_BACKEND_TIMEOUTS_MS = {
  initialize: 15_000,
  command: 30_000,
  shutdown: 2_000,
} as const;

export interface JsonRpcRequest<M extends string, P> {
  jsonrpc: '2.0';
  id: number;
  method: M;
  params: P;
}

export interface JsonRpcNotification<M extends string, P> {
  jsonrpc: '2.0';
  method: M;
  params: P;
}

export type JsonRpcResponse<R> =
  | { jsonrpc: '2.0'; id: number; result: R }
  | { jsonrpc: '2.0'; id: number; error: { code: number; message: string; data?: unknown } };

export interface InitializeParamsV1 {
  protocol: 1;
  plugin: { id: string; version: string };
  host: { name: 'PiUI'; version: string };
  /** The permissions the user trusted. */
  permissions: PluginPermission[];
  /** Current settings values with defaults applied. */
  settings: Record<string, PluginValue>;
  /** A private folder for this plugin's own files under PiUI's application data. */
  dataDir: string;
}

export interface InitializeResultV1 {
  protocol: 1;
}

export interface CommandExecuteParamsV1 {
  commandId: string;
  context: {
    /** Only with `chat.read`. */
    chat?: { id: string; title: string };
    /** Only with `project.read` or `project.write`, for a chat in a project folder. */
    project?: { path: string };
  };
}

/** `text` is prepared in the message box for the person to review; `notice` is shown once. */
export interface CommandExecuteResultV1 {
  text?: string;
  notice?: string;
}

/** Like a script step's stdin document, plus the node configuration. */
export interface NodeRunParamsV1 {
  nodeType: string;
  config: Record<string, PluginValue>;
  inputs: Record<string, unknown>;
  dependencies: Record<string, { text: string | null; data: Record<string, unknown> | null }>;
  step: { id: string; name: string };
  run: { id: string };
  /** Only with `project.read` or `project.write`: the trusted project folder. */
  project?: { path: string };
}

/**
 * A JSON object becomes the step's result data (checked against its result
 * fields); a string is the step's text output (a string that is one JSON
 * object is read as data, exactly like a script's stdout).
 */
export interface NodeRunResultV1 {
  output: string | Record<string, unknown>;
}

export interface SettingsChangedParamsV1 {
  settings: Record<string, PluginValue>;
}

export type HostRequestV1 =
  | JsonRpcRequest<'initialize', InitializeParamsV1>
  | JsonRpcRequest<'command/execute', CommandExecuteParamsV1>
  | JsonRpcRequest<'node/run', NodeRunParamsV1>
  | JsonRpcRequest<'shutdown', Record<string, never>>;

export type HostNotificationV1 = JsonRpcNotification<'settings/changed', SettingsChangedParamsV1>;
