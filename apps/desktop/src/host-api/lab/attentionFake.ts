import type { LabHandlers } from './labHandlers';

/** What the Lab's taskbar shows: the last report and every report, for the e2e specs. */
export interface LabAttentionRecord {
  count: number;
  flash: boolean;
  reports: { count: number; flash: boolean }[];
}

declare global {
  interface Window {
    /** Read by Playwright; the Lab is the only writer. */
    __piuiLabAttention?: LabAttentionRecord;
  }
}

const MAX_COUNT = 9999;
const refusal = (code: 'unavailable' | 'failed'): { readonly code: string } => ({ code });

/**
 * `attention_set_v1` in the UI Lab: the same checks as `attention.rs` (unknown
 * fields refused, the count capped), no taskbar. The last report is kept on
 * `window.__piuiLabAttention`, because the Lab runs in the page the spec reads.
 */
export function attentionHandlers(): LabHandlers {
  const record: LabAttentionRecord = { count: 0, flash: false, reports: [] };
  if (typeof window !== 'undefined') window.__piuiLabAttention = record;
  return {
    attention_set_v1: (args) => {
      const request = args.request;
      if (typeof request !== 'object' || request === null || Array.isArray(request)) throw refusal('failed');
      const { count, flash, ...rest } = request as Record<string, unknown>;
      if (Object.keys(rest).length > 0 || typeof flash !== 'boolean') throw refusal('failed');
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw refusal('failed');
      record.count = Math.min(count, MAX_COUNT);
      record.flash = flash;
      record.reports.push({ count: record.count, flash });
    },
  };
}
