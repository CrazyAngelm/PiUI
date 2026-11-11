import type { HarnessKind, WorkspaceModel } from './workspace-v15';
export interface HarnessCatalogModel extends WorkspaceModel { supportsFast?: boolean }
/** Absent: models and resources together. `models` answers without waiting for resource discovery; `resources` then collects it. */
export type HarnessCatalogPart = 'models' | 'resources';
export interface HarnessModelsRequest { workspaceId: string; harness: HarnessKind; part?: HarnessCatalogPart }
export interface HarnessResource { kind: 'tool' | 'skill' | 'mcp'; id: string; name: string; enabled: boolean; configurable: boolean }
export interface HarnessModelsResult { protocol: 18; harness: HarnessKind; models: HarnessCatalogModel[]; resources: { items: HarnessResource[]; warnings: string[] } }
