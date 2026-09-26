import type { DesktopTimelineBlock } from './runtime-protocol';

/** Read-only projection of host-registered native history. Never starts a runtime. */
export interface WorkspaceHistoryRequestV1 { sessionId: string }
export interface WorkspaceHistoryResultV1 {
  protocol: 1;
  sessionId: string;
  blocks: DesktopTimelineBlock[];
}
