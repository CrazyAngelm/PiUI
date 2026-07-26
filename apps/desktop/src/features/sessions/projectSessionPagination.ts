export const PROJECT_SESSION_PAGE_SIZE = 5;

export function visibleProjectSessionCount(requestedCount: number, totalCount: number): number {
  return Math.min(Math.max(PROJECT_SESSION_PAGE_SIZE, requestedCount), totalCount);
}

export function nextProjectSessionCount(currentCount: number, totalCount: number): number {
  return visibleProjectSessionCount(currentCount + PROJECT_SESSION_PAGE_SIZE, totalCount);
}
