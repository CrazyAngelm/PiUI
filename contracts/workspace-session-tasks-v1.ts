/**
 * Session tasks contract v1 (ADR-072): the work a live session's agent runs
 * beside its turn. These are its own subagents and shell commands, including
 * the ones that keep running after the tool call that started them returned.
 *
 * `SessionSnapshot.tasks` (additive v15 field, omitted when empty) lists them
 * and the additive v15 `tasks` workspace event replaces the whole list. A
 * harness that reports nothing sends neither; the interface then shows only
 * what the timeline's running tool calls say. Tasks belong to the live native
 * process: a closed, failed or reopened session has none.
 *
 * The list is bounded: at most 32 tasks, running ones first, every text one
 * line of at most 200 characters. It carries no native task, process or agent
 * id, no output and no file path.
 *
 * `workspace_task_stop_v1` asks the harness to stop one running task. It is a
 * trusted action of this computer's window: a remote viewer cannot call it.
 */

export type SessionTaskKind = 'agent' | 'command' | 'task';
export type SessionTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface SessionTaskV1 {
  /** Opaque adapter id, stable for the life of the native process. */
  id: string;
  /** `task` is the generic fallback for native work of an unknown kind. */
  kind: SessionTaskKind;
  /** One line: the command, or what the agent was asked to do. */
  title: string;
  status: SessionTaskStatus;
  /** The work continues after the tool call that started it returned. */
  background: boolean;
  /** ISO 8601 instant on this computer's clock. */
  startedAt: string;
  endedAt?: string;
  /** One line: the agent type, or what a command is for. */
  detail?: string;
  /** One line: what a running task is doing now, or how a finished one ended. */
  activity?: string;
  toolUses?: number;
  totalTokens?: number;
  /** The timeline block of the tool call that started the task, when known. */
  blockId?: string;
}

export interface SessionTaskStopRequestV1 {
  sessionId: string;
  taskId: string;
}

export interface SessionTaskStopResultV1 {
  protocol: 1;
  sessionId: string;
}

export interface SessionTasksHostCommandsV1 {
  workspace_task_stop_v1(args: { request: SessionTaskStopRequestV1 }): Promise<SessionTaskStopResultV1>;
}
