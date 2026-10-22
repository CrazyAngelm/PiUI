import {
  FUSION_CHANGED_EVENT_V1,
  FUSION_PROTOCOL,
  type FusionBriefV1,
  type FusionChangedEventV1,
  type FusionCommandV1,
  type FusionPairV1,
  type FusionRefusalV1,
  type FusionResultV1,
  type FusionRoleNameV1,
  type FusionRoundV1,
  type FusionStateV1,
  type RoundStateV1,
  type SidekickStateV1,
} from '../../../../../contracts/fusion-v1';
import type { LabEventBus } from './labBus';
import { SECOND } from './labClock';
import { workspaceFailure } from './labErrors';
import type { PermissionMode, WorkspaceModel, WorkspaceResult } from './labContracts';
import type { LabHandlers } from './labHandlers';
import { boolean, decodeArgument, enumOf, object, option, string, tagged } from './labSchema';
import { harnessIdentitySchema, workspaceModelSchema } from './labSchemas';
import { sha256Hex } from './sha256';
import type { LabSessions } from './sessionRuntime';
import { workspaceHandlers } from './workspaceFake';

/**
 * UI Lab fake of `fusion_command_v1` (ADR-043, docs/FUSION.md): the pair
 * admission matrix of the host (`fusion/logic.rs` `check_pair`), a Fusion
 * state document per lead chat and the person's commands. The lead is an
 * ordinary lab chat of the lead's harness. No agent runs: a scripted demo
 * brief (`simulateBrief`) walks one round through queued, running and
 * finished on the lab clock so the Fusion panel has something to show.
 */

/** Lead chat created -> the demo brief starts. */
export const LAB_FUSION_BRIEF_DELAY_MS = 2 * SECOND;
/** Brief admitted -> the round runs. */
export const LAB_FUSION_QUEUE_MS = 1_500;
/** Round runs -> the report arrives. */
export const LAB_FUSION_ROUND_MS = 20 * SECOND;

// ---------------------------------------------------------------------------
// Pair admission (mirror of Rust `check_pair`)
// ---------------------------------------------------------------------------

export interface FusionRefusalAnswer {
  refusal: FusionRefusalV1;
  role: FusionRoleNameV1;
}

/** Native modes of different harnesses are incomparable (`undefined`). */
function rank(mode: PermissionMode): number | undefined {
  switch (mode) {
    case 'native':
      return undefined;
    case 'read-only':
      return 0;
    case 'workspace-write':
      return 1;
    case 'full-access':
      return 2;
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

const SIDEKICK_HARNESSES: readonly string[] = ['claude-code', 'codex', 'pi'];
const LEAD_HARNESSES: readonly string[] = ['claude-code', 'codex'];

function sidekickRoleSupported(pair: FusionPairV1, codexSandbox: boolean): FusionRefusalAnswer | undefined {
  const { lead, sidekick } = pair;
  const refuse = (refusal: FusionRefusalV1): FusionRefusalAnswer => ({ refusal, role: 'sidekick' });
  switch (sidekick.harness) {
    // A workspace-write Claude Code sidekick cannot answer shell approvals (spike S5).
    case 'claude-code':
      return sidekick.permissionMode === 'full-access' || sidekick.permissionMode === 'native' ? undefined : refuse('sidekick-needs-full-access');
    case 'codex':
      return sidekick.permissionMode === 'workspace-write' && !codexSandbox ? refuse('codex-sandbox-unverified') : undefined;
    // Pi has no workspace-write mode; both roles must allow full access.
    case 'pi':
      return sidekick.permissionMode !== 'full-access' || lead.permissionMode !== 'full-access' ? refuse('sidekick-needs-full-access') : undefined;
    default:
      return undefined;
  }
}

/**
 * Whether the pair may start. `undefined` means admitted. `codexSandbox` says
 * Codex's Windows sandbox is configured (the lab toggles it to simulate
 * `codex-sandbox-unverified`).
 */
export function checkPair(pair: FusionPairV1, codexSandbox: boolean): FusionRefusalAnswer | undefined {
  const { lead, sidekick } = pair;
  if (!LEAD_HARNESSES.includes(lead.harness)) return { refusal: 'lead-harness-unsupported', role: 'lead' };
  if (!SIDEKICK_HARNESSES.includes(sidekick.harness)) return { refusal: 'sidekick-harness-unsupported', role: 'sidekick' };
  if (lead.permissionMode === 'read-only') return { refusal: 'read-only-lead', role: 'lead' };
  const leadRank = rank(lead.permissionMode);
  const sidekickRank = rank(sidekick.permissionMode);
  if (leadRank === undefined && sidekickRank === undefined) {
    // The same harness's native mode is the same policy on both roles.
    if (lead.harness !== sidekick.harness) return { refusal: 'explicit-modes-required', role: 'sidekick' };
  } else if (leadRank !== undefined && sidekickRank !== undefined) {
    if (sidekickRank > leadRank) return { refusal: 'sidekick-exceeds-lead', role: 'sidekick' };
  } else {
    return { refusal: 'explicit-modes-required', role: 'sidekick' };
  }
  return sidekickRoleSupported(pair, codexSandbox);
}

// ---------------------------------------------------------------------------
// Command schema
// ---------------------------------------------------------------------------

const permissionModeSchema = enumOf(['native', 'read-only', 'workspace-write', 'full-access']);
const roleSchema = object({
  harness: harnessIdentitySchema,
  model: option(workspaceModelSchema),
  thinkingLevel: option(string),
  serviceTier: option(enumOf(['fast'])),
  permissionMode: permissionModeSchema,
});
const pairSchema = object({
  lead: roleSchema,
  sidekick: roleSchema,
  options: object({
    briefPolicy: enumOf(['prescriptive', 'outline']),
    pushback: boolean,
    autoDeliver: boolean,
    leadNativeSubagents: boolean,
  }),
});

const commandSchema = tagged('type', {
  createChat: { workspaceId: string, pair: pairSchema, title: option(string) },
  checkPair: { workspaceId: string, pair: pairSchema },
  state: { leadSessionId: string },
  find: { sessionId: string },
  stopPair: { leadSessionId: string },
  stopSidekick: { leadSessionId: string },
  resetSidekick: { leadSessionId: string },
  reconcileRound: { leadSessionId: string, roundId: string },
  abandonRound: { leadSessionId: string, roundId: string },
});

/** Mirror of the host's `validate_id`. */
function validId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface LabFusionOptions {
  /** Codex's Windows sandbox is configured. `false` simulates `codex-sandbox-unverified`. Default `true`. */
  codexSandbox?: boolean;
  /** Start a demo brief 2 s after a lead chat is created. Default `true`. */
  autoDemo?: boolean;
}

export interface SimulateBriefOptions {
  /** `done` (default): the report arrives. `uncertain`: the round ends uncertain for the person to reconcile or abandon. */
  ending?: 'done' | 'uncertain';
}

export interface LabFusion {
  /** Mutable lab toggles. */
  codexSandbox: boolean;
  autoDemo: boolean;
  /** One state document per lead session id. */
  readonly states: Map<string, FusionStateV1>;
  readonly handlers: LabHandlers;
  /**
   * Adds the demo brief b1 with round r1 (queued, then running, then finished
   * with a `done` report delivered through the tool) to a lead chat, creating
   * the sidekick session first. `undefined` when the lead is unknown or a
   * round is still open.
   */
  simulateBrief(leadSessionId: string, options?: SimulateBriefOptions): { briefId: string; roundId: string } | undefined;
}

/** `?codexSandbox=off` simulates an unverified Codex sandbox. */
export function codexSandboxFromSearch(search: string): boolean {
  return new URLSearchParams(search).get('codexSandbox') !== 'off';
}

const OPEN_ROUND_STATES: ReadonlySet<RoundStateV1> = new Set<RoundStateV1>(['queued', 'running', 'waitingApproval', 'stopping']);

interface Located {
  brief: FusionBriefV1;
  round: FusionRoundV1;
}

function openRound(doc: FusionStateV1): Located | undefined {
  for (const brief of doc.briefs) {
    const round = brief.rounds.find((item) => OPEN_ROUND_STATES.has(item.state));
    if (round !== undefined) return { brief, round };
  }
  return undefined;
}

function findRound(doc: FusionStateV1, roundId: string): Located | undefined {
  for (const brief of doc.briefs) {
    const round = brief.rounds.find((item) => item.roundId === roundId);
    if (round !== undefined) return { brief, round };
  }
  return undefined;
}

/** A round is open, or uncertain and waiting for the person (docs/FUSION.md: such a lead cannot be deleted). */
function hasUnsettledRound(doc: FusionStateV1): boolean {
  return openRound(doc) !== undefined || doc.briefs.some((brief) => brief.rounds.some((round) => round.state === 'uncertain'));
}

function sidekickStateOf(doc: FusionStateV1): SidekickStateV1 {
  const open = openRound(doc)?.round;
  if (open !== undefined) {
    switch (open.state) {
      case 'waitingApproval':
        return 'waitingApproval';
      case 'stopping':
        return 'stopping';
      default:
        return 'working';
    }
  }
  // Like the host: an uncertain round blocks new work until it is settled.
  if (hasUnsettledRound(doc)) return 'unavailable';
  return doc.sessions.some((session) => !session.retired) ? 'idle' : 'none';
}

export function createLabFusion(runtime: LabSessions, bus: LabEventBus, options: LabFusionOptions = {}): LabFusion {
  const { state } = runtime;
  const workspace = workspaceHandlers(runtime);
  const states = new Map<string, FusionStateV1>();
  /** Pending scripted steps of a lead's open round. */
  const roundTimers = new Map<string, (() => void)[]>();
  /** The not yet started demo brief of a lead. */
  const demoTimers = new Map<string, () => void>();
  const now = (): string => runtime.clock.iso();
  // Connects membership to the ordinary workspace guards (`labGuards`).
  // Retired sidekicks keep their membership: they stay read-only like the host's registry.
  state.isFusionSidekick = (sessionId) => [...states.values()].some((doc) => doc.sessions.some((session) => session.sessionId === sessionId));
  state.fusionLifecycle = {
    isCurrentSidekick: (sessionId) => [...states.values()].some((doc) => doc.sessions.some((session) => session.sessionId === sessionId && !session.retired)),
    guardLeadDelete: (leadSessionId) => {
      const doc = states.get(leadSessionId);
      if (doc !== undefined && hasUnsettledRound(doc)) throw workspaceFailure('CONFLICT');
    },
    forgetLead,
    closeSidekick: (sessionId) => {
      const doc = [...states.values()].find((item) => item.sessions.some((session) => session.sessionId === sessionId && !session.retired));
      if (doc !== undefined && stopOpenRound(doc)) commit(doc);
    },
  };

  const fusion: LabFusion = {
    codexSandbox: options.codexSandbox ?? true,
    autoDemo: options.autoDemo ?? true,
    states,
    handlers: {
      fusion_command_v1: (args) => dispatch(decodeArgument<FusionCommandV1>(args, 'command', commandSchema)),
    },
    simulateBrief,
  };

  function assertNotSafe(): void {
    if (state.safeMode) throw workspaceFailure('SAFE_MODE');
  }

  function docOf(leadSessionId: string): FusionStateV1 {
    const doc = states.get(leadSessionId);
    if (doc === undefined) throw workspaceFailure('NOT_FOUND');
    return doc;
  }

  /** The host answers `NOT_SUPPORTED` when the lead has no broker slot (sidekick unavailable). */
  function slotOf(leadSessionId: string): FusionStateV1 {
    const doc = states.get(leadSessionId);
    if (doc === undefined) throw workspaceFailure('NOT_SUPPORTED');
    return doc;
  }

  function view(doc: FusionStateV1): FusionStateV1 {
    doc.sidekick = sidekickStateOf(doc);
    return structuredClone(doc);
  }

  /** One state generation: bump the revision and tell every listener. */
  function commit(doc: FusionStateV1): void {
    doc.revision += 1;
    doc.sidekick = sidekickStateOf(doc);
    const event: FusionChangedEventV1 = { protocol: FUSION_PROTOCOL, leadSessionId: doc.leadSessionId, revision: doc.revision };
    bus.emit(FUSION_CHANGED_EVENT_V1, event);
  }

  function schedule(leadSessionId: string, ms: number, action: () => void): void {
    const cancel = runtime.clock.after(ms, action);
    roundTimers.set(leadSessionId, [...(roundTimers.get(leadSessionId) ?? []), cancel]);
  }

  function cancelRoundTimers(leadSessionId: string): void {
    for (const cancel of roundTimers.get(leadSessionId) ?? []) cancel();
    roundTimers.delete(leadSessionId);
  }

  function created(result: WorkspaceResult): string {
    if (result.type !== 'session') throw workspaceFailure('IO_ERROR');
    return result.snapshot.session.id;
  }

  /** The sidekick's ordinary lab chat; a lab that cannot start one still gets a record id. */
  function ensureSidekickSession(doc: FusionStateV1): string {
    const existing = doc.sessions.find((session) => !session.retired);
    if (existing !== undefined) return existing.sessionId;
    const { sidekick } = doc.pair;
    const leadTitle = state.sessions.get(doc.leadSessionId)?.title ?? 'Fusion';
    let sessionId: string;
    try {
      const model: WorkspaceModel | undefined = sidekick.model;
      sessionId = created(workspace.workspace_command_v15?.({
        command: {
          type: 'createSession',
          workspaceId: doc.workspaceId,
          harness: sidekick.harness,
          permissionMode: sidekick.permissionMode,
          title: `Sidekick: ${[...leadTitle].slice(0, 60).join('')}`,
          ...(model === undefined ? {} : { model }),
        },
      }) as WorkspaceResult);
    } catch {
      sessionId = state.ids.next('session');
    }
    doc.sessions.push({ sessionId, harness: sidekick.harness, retired: false, createdAt: now() });
    return sessionId;
  }

  function finishRound(doc: FusionStateV1, brief: FusionBriefV1, round: FusionRoundV1, ending: 'done' | 'uncertain', via: 'tool' | 'followUp' = 'tool'): void {
    if (ending === 'uncertain') {
      round.state = 'uncertain';
    } else {
      const at = now();
      const answerBlockId = state.ids.next('fusion-answer');
      round.state = 'finished';
      round.outcome = 'completed';
      round.status = 'done';
      round.finishedAt = at;
      round.answerBlockId = answerBlockId;
      round.answerHash = sha256Hex(answerBlockId);
      round.delivery = { via, state: 'sent', updatedAt: at };
      brief.state = 'reported';
    }
    commit(doc);
  }

  function simulateBrief(leadSessionId: string, simulate: SimulateBriefOptions = {}): { briefId: string; roundId: string } | undefined {
    const doc = states.get(leadSessionId);
    if (doc === undefined || state.safeMode || openRound(doc) !== undefined) return undefined;
    const ending = simulate.ending ?? 'done';
    const sidekickSessionId = ensureSidekickSession(doc);
    const at = now();
    const round: FusionRoundV1 = {
      roundId: state.ids.next('fusion-round'),
      kind: 'brief',
      state: 'queued',
      startedAt: at,
      preview: 'Add a retry limit to the uploader and cover the give-up path with a test.',
    };
    const brief: FusionBriefV1 = {
      briefId: state.ids.next('fusion-brief'),
      title: 'Add a retry limit to the uploader',
      goal: 'Retry a failed upload at most three times, then report the failure to the caller.',
      doneWhen: ['A fourth failure surfaces the error', 'The new test passes'],
      state: 'active',
      sidekickSessionId,
      rounds: [round],
      createdAt: at,
    };
    doc.briefs.push(brief);
    doc.stats.briefs += 1;
    doc.stats.rounds += 1;
    commit(doc);
    schedule(leadSessionId, LAB_FUSION_QUEUE_MS, () => {
      round.state = 'running';
      commit(doc);
    });
    schedule(leadSessionId, LAB_FUSION_QUEUE_MS + LAB_FUSION_ROUND_MS, () => finishRound(doc, brief, round, ending));
    return { briefId: brief.briefId, roundId: round.roundId };
  }

  /** Stops the open round without delivering its report. Returns whether anything changed. */
  function stopOpenRound(doc: FusionStateV1): boolean {
    cancelRoundTimers(doc.leadSessionId);
    const open = openRound(doc);
    if (open === undefined) return false;
    const at = now();
    open.round.state = 'finished';
    open.round.outcome = 'interrupted';
    open.round.finishedAt = at;
    open.round.delivery = { via: 'followUp', state: 'withdrawn', updatedAt: at };
    return true;
  }

  /**
   * The lead chat was deleted: its pair is forgotten (journal, membership,
   * scheduled steps and the pending demo brief) and an idle sidekick process
   * is closed. The sidekick's chat stays.
   */
  function forgetLead(leadSessionId: string): void {
    const doc = states.get(leadSessionId);
    cancelRoundTimers(leadSessionId);
    demoTimers.get(leadSessionId)?.();
    demoTimers.delete(leadSessionId);
    if (doc === undefined) return;
    states.delete(leadSessionId);
    for (const session of doc.sessions) {
      const record = runtime.record(session.sessionId);
      if (record?.live !== undefined) runtime.close(record);
    }
  }

  function stopSidekick(leadSessionId: string): FusionStateV1 {
    const doc = slotOf(leadSessionId);
    if (stopOpenRound(doc)) commit(doc);
    return doc;
  }

  // ---- dispatch --------------------------------------------------------------

  function pairCheck(pair: FusionPairV1): FusionResultV1 {
    const refused = checkPair(pair, fusion.codexSandbox);
    return refused === undefined ? { type: 'pairCheck', ok: true } : { type: 'pairCheck', ok: false, ...refused };
  }

  function dispatch(command: FusionCommandV1): FusionResultV1 {
    switch (command.type) {
      case 'checkPair':
        if (!validId(command.workspaceId)) throw workspaceFailure('INVALID_ARGUMENT');
        return pairCheck(command.pair);
      case 'createChat': {
        assertNotSafe();
        if (!validId(command.workspaceId)) throw workspaceFailure('INVALID_ARGUMENT');
        const refused = checkPair(command.pair, fusion.codexSandbox);
        if (refused !== undefined) return { type: 'pairCheck', ok: false, ...refused };
        const { lead } = command.pair;
        const title = command.title ?? undefined;
        const model = lead.model ?? undefined;
        const leadSessionId = created(workspace.workspace_command_v15?.({
          command: {
            type: 'createSession',
            workspaceId: command.workspaceId,
            harness: lead.harness,
            permissionMode: lead.permissionMode,
            ...(title === undefined ? {} : { title }),
            ...(model === undefined ? {} : { model }),
          },
        }) as WorkspaceResult);
        const doc: FusionStateV1 = {
          protocol: FUSION_PROTOCOL,
          leadSessionId,
          workspaceId: command.workspaceId,
          pair: structuredClone(command.pair),
          sidekick: 'none',
          sessions: [],
          briefs: [],
          stats: { briefs: 0, accepted: 0, rejected: 0, takenOver: 0, rounds: 0 },
          revision: 0,
        };
        states.set(leadSessionId, doc);
        commit(doc);
        if (fusion.autoDemo) {
          demoTimers.set(leadSessionId, runtime.clock.after(LAB_FUSION_BRIEF_DELAY_MS, () => {
            demoTimers.delete(leadSessionId);
            simulateBrief(leadSessionId);
          }));
        }
        return { type: 'created', leadSessionId, state: view(doc) };
      }
      case 'state':
        return { type: 'state', state: view(docOf(command.leadSessionId)) };
      case 'find': {
        const lead = states.get(command.sessionId);
        if (lead !== undefined) return { type: 'membership', role: 'lead', leadSessionId: lead.leadSessionId };
        for (const doc of states.values()) {
          if (doc.sessions.some((session) => session.sessionId === command.sessionId)) {
            return { type: 'membership', role: 'sidekick', leadSessionId: doc.leadSessionId };
          }
        }
        return { type: 'membership', role: null };
      }
      case 'stopPair': {
        assertNotSafe();
        stopSidekick(command.leadSessionId);
        demoTimers.get(command.leadSessionId)?.();
        demoTimers.delete(command.leadSessionId);
        const record = runtime.record(command.leadSessionId);
        if (record !== undefined && runtime.isBusy(record)) {
          try {
            workspace.workspace_command_v15?.({ command: { type: 'interrupt', sessionId: command.leadSessionId } });
          } catch {
            // The lead finished its turn meanwhile: nothing to interrupt.
          }
        }
        return { type: 'accepted' };
      }
      case 'stopSidekick':
        assertNotSafe();
        stopSidekick(command.leadSessionId);
        return { type: 'accepted' };
      case 'resetSidekick': {
        assertNotSafe();
        const doc = slotOf(command.leadSessionId);
        let changed = stopOpenRound(doc);
        if (doc.briefs.some((brief) => brief.rounds.some((round) => round.state === 'uncertain'))) {
          // The person reconciles first; a stop above is still kept.
          if (changed) commit(doc);
          throw workspaceFailure('CONFLICT');
        }
        const active = [...doc.sessions].reverse().find((session) => !session.retired);
        if (active !== undefined) {
          active.retired = true;
          active.retiredReason = 'reset by the person';
          const record = runtime.record(active.sessionId);
          if (record?.live !== undefined) runtime.close(record);
          changed = true;
        }
        if (changed) commit(doc);
        return { type: 'accepted' };
      }
      case 'reconcileRound': {
        assertNotSafe();
        const doc = slotOf(command.leadSessionId);
        const found = findRound(doc, command.roundId);
        if (found === undefined) throw workspaceFailure('NOT_FOUND');
        if (found.round.state !== 'uncertain') throw workspaceFailure('CONFLICT');
        // The lab sidekick always has its answer in its history: the round settles as recovered.
        finishRound(doc, found.brief, found.round, 'done', 'followUp');
        return { type: 'state', state: view(doc) };
      }
      case 'abandonRound': {
        assertNotSafe();
        const doc = slotOf(command.leadSessionId);
        const found = findRound(doc, command.roundId);
        if (found === undefined) throw workspaceFailure('NOT_FOUND');
        if (found.round.state !== 'uncertain') throw workspaceFailure('CONFLICT');
        found.round.state = 'finished';
        found.round.outcome = 'uncertain';
        found.round.finishedAt = now();
        if (found.round.delivery?.state === 'uncertain') found.round.delivery = { ...found.round.delivery, state: 'withdrawn', updatedAt: now() };
        found.brief.state = 'stopped';
        commit(doc);
        return { type: 'state', state: view(doc) };
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  return fusion;
}

export function fusionHandlers(fusion: LabFusion): LabHandlers {
  return fusion.handlers;
}

/** Adds the scripted demo brief to a lead chat (see `LabFusion.simulateBrief`). */
export function simulateFusionBrief(fusion: LabFusion, leadSessionId: string, options?: SimulateBriefOptions): { briefId: string; roundId: string } | undefined {
  return fusion.simulateBrief(leadSessionId, options);
}
