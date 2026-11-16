import type { SessionTaskStopRequestV1, SessionTaskStopResultV1, SessionTaskV1 } from '../../../../../contracts/workspace-session-tasks-v1';
import { labIso } from './labClock';
import { workspaceFailure } from './labErrors';
import { authorizeOrdinaryLive, requireLive, validToken } from './labGuards';
import type { LabHandlers } from './labHandlers';
import { decodeArgument, object, string } from './labSchema';
import type { LabSessions } from './sessionRuntime';

/**
 * UI Lab fake of `workspace_task_stop_v1` (ADR-072): stops one running task of a
 * live session, as the host's Claude Code `stop_task` control request does.
 * Nothing runs; the task is marked stopped and the whole new list is published
 * with the `tasks` event. Rules mirror `workspace_api::workspace_task_stop_v1`:
 * safe mode and Fusion sidekicks are refused like every runtime action, and a
 * task that is not running (unknown, already finished or already stopped) is
 * `NOT_FOUND`.
 */
const stopRequestSchema = object({ sessionId: string, taskId: string });

/** `workspace_task_stop_v1` */
function stopTask(runtime: LabSessions, request: SessionTaskStopRequestV1): SessionTaskStopResultV1 {
  const { state } = runtime;
  if (state.safeMode) throw workspaceFailure('SAFE_MODE');
  if (!validToken(request.taskId) || request.taskId.length > 128) throw workspaceFailure('INVALID_ARGUMENT');
  const record = authorizeOrdinaryLive(state, request.sessionId);
  const live = requireLive(record);
  const task = live.tasks.find((candidate) => candidate.id === request.taskId && candidate.status === 'running');
  if (task === undefined) throw workspaceFailure('NOT_FOUND');
  // Live tasks are on this computer's clock (createLabHost moves the seeded ones there), so the end comes from the timer seam, never before the start.
  const started = Date.parse(task.startedAt);
  const now = runtime.clock.timers.now();
  const stopped: SessionTaskV1 = { ...task, status: 'stopped', endedAt: labIso(Number.isFinite(started) ? Math.max(started, now) : now) };
  delete stopped.activity;
  runtime.replaceTasks(record, live.tasks.map((candidate) => (candidate === task ? stopped : candidate)));
  return { protocol: 1, sessionId: request.sessionId };
}

export function sessionTasksHandlers(runtime: LabSessions): LabHandlers {
  return {
    workspace_task_stop_v1: (args) =>
      stopTask(runtime, decodeArgument<SessionTaskStopRequestV1>(args, 'request', stopRequestSchema)),
  };
}
