/** Additive runtime settings API. Workspace v11 remains frozen. */
import type { WorkspaceModel } from './workspace-v11';
export type RuntimeSettingsCommand =
  | { type: 'get'; sessionId: string }
  | { type: 'set'; sessionId: string; model: WorkspaceModel; thinkingLevel?: string; serviceTier?: 'standard' | 'fast' };
export interface RuntimeSettings {
  protocol: 12;
  sessionId: string;
  model: WorkspaceModel | null;
  models: WorkspaceModel[];
  thinkingLevel: string | null;
  serviceTier: 'standard' | 'fast' | null;
}
