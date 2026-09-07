import type { HarnessKind, WorkspaceModel } from './workspace-v11';
export interface HarnessCatalogModel extends WorkspaceModel { supportsFast?: boolean }
export interface HarnessModelsRequest { workspaceId: string; harness: HarnessKind }
export interface HarnessResource { kind: 'tool' | 'skill' | 'mcp'; id: string; name: string; enabled: boolean; configurable: boolean }
export interface HarnessModelsResult { protocol: 14; harness: HarnessKind; models: HarnessCatalogModel[]; resources: { items: HarnessResource[]; warnings: string[] } }
