import type { HarnessCatalogPart, HarnessModelsRequest, HarnessModelsResult } from './harness-models-v18';

/** A split discovery uses the same UUID for its models and resources requests. */
export type HarnessModelsRequestV19 = Omit<HarnessModelsRequest, 'part'> & (
  | { part?: never; discoveryId?: never }
  | { part: HarnessCatalogPart; discoveryId: string }
);

export interface HarnessModelsResultV19 {
  protocol: 19;
  catalog: HarnessModelsResult;
}
