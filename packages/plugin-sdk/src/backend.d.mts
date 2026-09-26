import type {
  CommandExecuteParamsV1,
  CommandExecuteResultV1,
  InitializeParamsV1,
  NodeRunParamsV1,
} from '../../../contracts/plugin-backend-v1';
import type { PluginValue } from '../../../contracts/piui-plugin-v1';

export type PluginSettings = Record<string, PluginValue>;

export interface CommandRequest {
  context: CommandExecuteParamsV1['context'];
  settings: PluginSettings;
  plugin: InitializeParamsV1['plugin'] | undefined;
}

export type NodeRequest = NodeRunParamsV1 & { settings: PluginSettings };

export interface PluginHandlers {
  /** By command id. */
  commands?: Record<string, (request: CommandRequest) => CommandExecuteResultV1 | void | Promise<CommandExecuteResultV1 | void>>;
  /** By node type id: a string or one JSON object becomes the step's result. */
  nodes?: Record<string, (request: NodeRequest) => string | Record<string, unknown> | Promise<string | Record<string, unknown>>>;
  onSettingsChanged?: (settings: PluginSettings) => void;
  onInitialize?: (init: InitializeParamsV1) => void | Promise<void>;
}

/** An error whose message PiUI shows as the command's or the node's failure. */
export declare class PluginError extends Error {
  constructor(message: string, code?: number);
  readonly code: number;
}

export declare function startPluginBackend(handlers?: PluginHandlers): void;
