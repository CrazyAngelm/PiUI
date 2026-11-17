import {
  FUSION_CHANGED_EVENT_V1,
  FUSION_PROTOCOL,
  type FusionBriefV1,
  type FusionChangedEventV1,
  type FusionCommandV1,
  type FusionCapabilitiesV1,
  type FusionCapabilityDimensionV1,
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
  dimension?: FusionCapabilityDimensionV1;
}

export interface FusionAdmission {
  sidekickMode: PermissionMode;
  capabilities?: FusionCapabilitiesV1;
}

type Caps = FusionCapabilitiesV1;
const FULL: Caps = { writes: 'anywhere', reads: 'anywhere', shell: 'unrestricted', network: 'full', mcp: 'configured' };
const NONE_BUT: (writes: Caps['writes'], reads: Caps['reads'], shell: Caps['shell'], mcp: Caps['mcp']) => Caps = (writes, reads, shell, mcp) => ({
  writes,
  reads,
  shell,
  network: 'none',
  mcp,
});

/** Mirror of Rust `capability::capabilities`. */
function capabilitiesOf(harness: string, mode: PermissionMode): Caps | undefined {
  if (mode === 'full-access') return FULL;
  const key = `${harness}:${mode}`;
  switch (key) {
    case 'claude-code:read-only':
      return NONE_BUT('none', 'workspace', 'none', 'none');
    case 'claude-code:workspace-write':
      return NONE_BUT('workspace', 'workspace', 'none', 'none');
    case 'codex:read-only':
      return NONE_BUT('none', 'anywhere', 'read-only-sandbox', 'none');
    case 'codex:workspace-write':
      return NONE_BUT('workspace', 'anywhere', 'workspace-sandbox', 'none');
    case 'nano:read-only':
      return NONE_BUT('none', 'anywhere', 'none', 'none');
    case 'nano:native':
      return { writes: 'approved', reads: 'anywhere', shell: 'approved', network: 'approved', mcp: 'none' };
    default:
      return undefined;
  }
}

function writesLe(a: Caps['writes'], b: Caps['writes']): boolean {
  return a === 'none' || b === 'anywhere' || a === b;
}
/** A sandboxed command is covered by a lead that may make the sandbox's writes (reads are exempt). */
function shellLe(a: Caps['shell'], b: Caps['shell'], leadWrites: Caps['writes']): boolean {
  if (a === 'none' || b === 'unrestricted' || a === b) return true;
  if (a === 'read-only-sandbox') return true;
  if (a === 'workspace-sandbox') return writesLe('workspace', leadWrites);
  return false;
}
const NETWORK_ORDER: readonly Caps['network'][] = ['none', 'approved', 'full'];

/** Mirror of Rust `capability::exceeds`. */
export function exceedsLead(sidekick: Caps, sidekickHarness: string, lead: Caps, leadHarness: string): FusionCapabilityDimensionV1 | undefined {
  if (!writesLe(sidekick.writes, lead.writes)) return 'writes';
  // Reads are shown, not compared (ADR-076, the person's decision).
  if (!shellLe(sidekick.shell, lead.shell, lead.writes)) return 'shell';
  if (NETWORK_ORDER.indexOf(sidekick.network) > NETWORK_ORDER.indexOf(lead.network)) return 'network';
  if (sidekick.mcp === 'configured') {
    const covered = lead.mcp === 'configured' && (sidekickHarness === leadHarness || lead.shell === 'unrestricted');
    if (!covered) return 'mcp';
  }
  return undefined;
}

const LEAD_HARNESSES: readonly string[] = ['claude-code', 'codex'];

function sidekickPresets(harness: string): readonly PermissionMode[] {
  switch (harness) {
    case 'claude-code':
    case 'codex':
      return ['full-access', 'workspace-write', 'read-only'];
    case 'pi':
      return ['full-access'];
    case 'nano':
      return ['full-access', 'native', 'read-only'];
    default:
      return [];
  }
}

/**
 * Mirror of Rust `capability::admit`: the launched sidekick preset, narrowed
 * to fit the lead, or the refusal (with the dimension no preset can narrow).
 * `codexSandbox` says Codex's Windows sandbox is configured (the lab toggles
 * it to simulate `codex-sandbox-unverified`).
 */
export function admitPair(pair: FusionPairV1, codexSandbox: boolean): FusionAdmission | FusionRefusalAnswer {
  const { lead, sidekick } = pair;
  if (!LEAD_HARNESSES.includes(lead.harness)) return { refusal: 'lead-harness-unsupported', role: 'lead' };
  const presets = sidekickPresets(sidekick.harness);
  if (presets.length === 0) return { refusal: 'sidekick-harness-unsupported', role: 'sidekick' };
  const requested = sidekick.permissionMode;
  if (lead.permissionMode === 'native') {
    return requested === 'native' && lead.harness === sidekick.harness ? { sidekickMode: 'native' } : { refusal: 'explicit-modes-required', role: 'lead' };
  }
  if (!presets.includes(requested) && requested !== 'native') return { refusal: 'sidekick-needs-full-access', role: 'sidekick' };
  if (sidekick.harness === 'codex' && requested === 'workspace-write' && !codexSandbox) return { refusal: 'codex-sandbox-unverified', role: 'sidekick' };
  const leadCaps = capabilitiesOf(lead.harness, lead.permissionMode);
  if (leadCaps === undefined) return { refusal: 'explicit-modes-required', role: 'lead' };
  const found = presets.indexOf(requested);
  const start = found >= 0 ? found : presets[0] === 'full-access' ? 1 : 0;
  let last: FusionCapabilityDimensionV1 | undefined;
  for (const mode of presets.slice(start)) {
    if (sidekick.harness === 'codex' && mode === 'workspace-write' && !codexSandbox) continue;
    const candidate = capabilitiesOf(sidekick.harness, mode);
    if (candidate === undefined) continue;
    const dimension = exceedsLead(candidate, sidekick.harness, leadCaps, lead.harness);
    if (dimension === undefined) return { sidekickMode: mode, capabilities: candidate };
    last = dimension;
  }
  return last === undefined ? { refusal: 'sidekick-exceeds-lead', role: 'sidekick' } : { refusal: 'sidekick-exceeds-lead', role: 'sidekick', dimension: last };
}

/** Whether the pair may start. `undefined` means admitted. */
export function checkPair(pair: FusionPairV1, codexSandbox: boolean): FusionRefusalAnswer | undefined {
  const admission = admitPair(pair, codexSandbox);
  return 'refusal' in admission ? admission : undefined;
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
  resumePair: { leadSessionId: string },
  checkDelivery: { leadSessionId: string, roundId: string },
  deliverAgain: { leadSessionId: string, roundId: string },
  dismissReport: { leadSessionId: string, roundId: string },
  steerSidekick: { leadSessionId: string, text: string },
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
          title: `Sidekick · ${[...leadTitle].slice(0, 80).join('')}`,
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
    const admission = admitPair(pair, fusion.codexSandbox);
    return 'refusal' in admission ? { type: 'pairCheck', ok: false, ...admission } : { type: 'pairCheck', ok: true, ...admission };
  }

  function dispatch(command: FusionCommandV1): FusionResultV1 {
    switch (command.type) {
      case 'checkPair':
        if (!validId(command.workspaceId)) throw workspaceFailure('INVALID_ARGUMENT');
        return pairCheck(command.pair);
      case 'createChat': {
        assertNotSafe();
        if (!validId(command.workspaceId)) throw workspaceFailure('INVALID_ARGUMENT');
        const admission = admitPair(command.pair, fusion.codexSandbox);
        if ('refusal' in admission) return { type: 'pairCheck', ok: false, ...admission };
        // The frozen pair records the narrowed preset the sidekick launches with.
        const pair: FusionPairV1 = { ...command.pair, sidekick: { ...command.pair.sidekick, permissionMode: admission.sidekickMode } };
        const { lead } = pair;
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
          pair: structuredClone(pair),
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
        const paused = slotOf(command.leadSessionId);
        if (paused.paused !== true) {
          paused.paused = true;
          commit(paused);
        }
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
      case 'resumePair': {
        assertNotSafe();
        const doc = slotOf(command.leadSessionId);
        delete doc.paused;
        commit(doc);
        return { type: 'state', state: view(doc) };
      }
      case 'checkDelivery':
      case 'deliverAgain':
      case 'dismissReport': {
        assertNotSafe();
        const doc = slotOf(command.leadSessionId);
        const found = findRound(doc, command.roundId);
        if (found === undefined) throw workspaceFailure('NOT_FOUND');
        if (found.round.state !== 'finished' || found.round.delivery?.state !== 'uncertain') throw workspaceFailure('CONFLICT');
        // The lab lead history never holds the report: a check leaves it unknown.
        if (command.type === 'deliverAgain') found.round.delivery = { via: 'followUp', state: 'sent', updatedAt: now() };
        if (command.type === 'dismissReport') found.round.delivery = { via: 'followUp', state: 'withdrawn', updatedAt: now() };
        commit(doc);
        return { type: 'state', state: view(doc) };
      }
      case 'steerSidekick': {
        assertNotSafe();
        const doc = slotOf(command.leadSessionId);
        const open = openRound(doc);
        if (open === undefined || command.text.trim() === '') throw workspaceFailure('CONFLICT');
        open.round.personSteers = (open.round.personSteers ?? 0) + 1;
        commit(doc);
        return { type: 'accepted' };
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
