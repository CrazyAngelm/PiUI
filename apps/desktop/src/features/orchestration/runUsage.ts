import type { UsageReceipt } from '../../../../../contracts/orchestration-host-v6';
export type UsageMetric = Exclude<keyof UsageReceipt, 'id'>;
export function usageTotal(receipts: readonly UsageReceipt[], metric: UsageMetric): number | undefined {
  if (!receipts.length || receipts.some(receipt => receipt[metric] === undefined)) return undefined;
  let total = 0;
  for (const receipt of receipts) {
    const value = receipt[metric];
    if (value === undefined || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) return undefined;
    total += value;
  }
  return total;
}
/** Missing agents make the run aggregate unknown, not a misleading partial total. */
export function runUsageTotal(sessionIds: readonly string[], usage: Record<string, UsageReceipt[]>, metric: UsageMetric): number | undefined {
  const ids = [...new Set(sessionIds)];
  if (!ids.length || ids.some(id => !usage[id]?.length)) return undefined;
  return usageTotal(ids.flatMap(id => usage[id]!), metric);
}
