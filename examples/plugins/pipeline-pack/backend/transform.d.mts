/** Types of the pure JSON transform (transform.mjs). */
export interface TransformRequest {
  config?: {
    source?: string;
    pick?: string;
    rename?: string;
    wrap?: string;
    [key: string]: string | number | boolean | undefined;
  };
  inputs?: Record<string, unknown>;
  dependencies?: Record<string, { text: string | null; data: Record<string, unknown> | null } | undefined>;
}

export declare function transformJson(request: TransformRequest): Record<string, unknown>;
