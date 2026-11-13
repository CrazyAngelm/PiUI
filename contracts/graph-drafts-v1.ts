/** Browser presentation contract. Authentication and ownership belong to the embedding host. */
export const GRAPH_DRAFT_CONTRACT_VERSION = 1;

export interface GraphDraftSummary {
  id: string;
  name: string;
  revision: number;
}

export interface GraphDraftSnapshot {
  contractVersion: 1;
  id: string;
  revision: number;
  /** Complete piui-system document; the current portable parser owns its semantics. */
  document: string;
}

export interface GraphDraftSaveRequest {
  contractVersion: 1;
  id: string;
  expectedRevision: number | null;
  document: string;
}

export type GraphDraftSaveResult =
  | { kind: 'saved'; snapshot: GraphDraftSnapshot }
  | { kind: 'conflict' }
  | { kind: 'rejected'; message: string };

export interface GraphDraftPersistence {
  list(): Promise<GraphDraftSummary[]>;
  load(id: string): Promise<GraphDraftSnapshot | null>;
  save(request: GraphDraftSaveRequest): Promise<GraphDraftSaveResult>;
}

export interface GraphEditorOptions extends GraphDraftPersistence {
  contractVersion: 1;
  language: 'en' | 'ru';
  appearance?: 'light' | 'dark' | 'system';
  /** Optional host capability data. Only future new nodes use this profile. */
  creationProfile?: GraphCreationProfile | null;
  onDraftState?: (state: GraphEditorDraftState) => void;
}

export interface GraphCreationProfile {
  harness: 'hermes';
  permissionMode: 'native';
  model: string;
  /** The host's current entitlement result, not a bundled model catalog. */
  models: readonly string[];
}

export interface GraphEditorDraftState { id: string; revision: number | null; dirty: boolean }

export interface GraphEditorHandle {
  hasUnsavedChanges(): boolean;
  /** Optional in pre-execution bundles; hosts must check availability at runtime. */
  getDraftState(): GraphEditorDraftState;
  setCreationProfile(profile: GraphCreationProfile | null): void;
  setAppearance(value: 'light' | 'dark' | 'system'): void;
  dispose(): Promise<void>;
}
