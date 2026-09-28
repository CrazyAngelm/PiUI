import type { BoardPermissionsV1 } from '../../../../../contracts/board-v1';
import type {
  AgentProfile,
  LaunchCommandReference,
  PipelineDefinition,
  PipelineInput,
  TeamDefinition,
} from '../../../../../contracts/orchestration-v6';
import {
  MAX_TEAMMATE_ROLE_CHARS,
  MAX_TEAMMATES_PER_WORKSPACE,
  TEAMMATE_HANDLE_PATTERN,
  TEAMMATES_CHANGED_EVENT_V1,
  type TeammateCardInputV1,
  type TeammateDraftV1,
  type TeammateStatusV1,
  type TeammatesCommandV1,
  type TeammatesResultV1,
  type TeammateV1,
} from '../../../../../contracts/teammates-v1';
import type { LabEventBus } from './labBus';
import type { HostErrorPayload } from './labErrors';
import type { LabHandlers } from './labHandlers';
import { labUuid } from './labRandom';
import { boolean, decodeArgument, enumOf, object, option, string, tagged, u32, u64 } from './labSchema';
import { emptyOrchestration, type LabOrchestrationWorkspace, type LabState } from './labState';
import type { LabSessions } from './sessionRuntime';

/**
 * UI Lab fake of `teammates_command_v1` (ADR-041). Teammates live beside the
 * lab orchestration state; a `simple` teammate writes its managed profile,
 * team, pipeline and launch command into the project's definitions in the
 * same step, exactly like the host's atomic save. Nothing is executed.
 */
export interface LabLiveBoardRun {
  workspaceId: string;
  cardId: string;
  teammateId: string;
}

/** Teammate state shared with the board fake (availability, assignability). */
export interface LabTeam {
  teammates: Map<string, TeammateV1[]>;
  /** Live board-started runs by run id. */
  liveRuns: Map<string, LabLiveBoardRun>;
  /** Pending starts waiting for the person, counted by the board fake. */
  queuedFor: (workspaceId: string, teammateId: string) => number;
}

export function createLabTeam(): LabTeam {
  return { teammates: new Map(), liveRuns: new Map(), queuedFor: () => 0 };
}

function failure(code: string, message: string): HostErrorPayload {
  return { code, message, recoverable: true };
}

const SAFE_MODE = failure('SAFE_MODE', 'Safe mode is on: PiUI does not change teammates.');
const INVALID = failure('INVALID_ARGUMENT', 'Check the teammate details and try again.');
const NOT_FOUND = failure('NOT_FOUND', 'That teammate or launch command is no longer available.');
const HANDLE_TAKEN = failure('HANDLE_TAKEN', 'Another teammate already uses this handle.');
const CONFLICT = failure('REVISION_CONFLICT', 'The teammate changed meanwhile.');
const LIMIT = failure('LIMIT', 'This project has the most teammates allowed.');

const permissionsSchema = object({
  read: boolean,
  comment: boolean,
  create: boolean,
  move: boolean,
  claim: boolean,
  assign: boolean,
});

const draftSchema = object({
  id: option(string),
  expectedRevision: option(u64),
  handle: string,
  name: string,
  color: string,
  avatar: string,
  role: string,
  body: tagged('type', {
    simple: {
      agent: object({
        harness: string,
        modelProvider: option(string),
        model: string,
        permissionMode: enumOf(['native', 'read-only', 'workspace-write', 'full-access']),
        reasoning: option(string),
        serviceTier: option(enumOf(['standard', 'fast'])),
        networkAccess: option(boolean),
        instructions: string,
      }),
    },
    pipeline: { launchCommandId: string },
  }),
  cardInput: tagged('type', { auto: {}, named: { inputName: string } }),
  board: permissionsSchema,
  maxConcurrentRuns: u32,
  wake: object({ onAssign: enumOf(['ask', 'always', 'never']), onMention: boolean }),
  enabled: boolean,
});

const commandSchema = tagged('type', {
  list: { workspaceId: string },
  save: { workspaceId: string, teammate: draftSchema },
  delete: { workspaceId: string, teammateId: string, expectedRevision: u64 },
  setEnabled: { workspaceId: string, teammateId: string, enabled: boolean },
});

const TEXT_KINDS = new Set(['text', 'long-text']);

/** The pipeline input a card's text goes to, or why there is none (docs/BOARD.md). */
export function resolveCardInput(inputs: readonly PipelineInput[], rule: TeammateCardInputV1): { inputName: string } | { reason: string } {
  if (rule.type === 'named') {
    const input = inputs.find((item) => item.name === rule.inputName);
    if (input === undefined) return { reason: `The pipeline has no input named "${rule.inputName}".` };
    if (!TEXT_KINDS.has(input.kind)) return { reason: `The input "${rule.inputName}" does not take text.` };
    return { inputName: input.name };
  }
  for (const name of ['card', 'message']) {
    const input = inputs.find((item) => item.name === name && TEXT_KINDS.has(item.kind));
    if (input !== undefined) return { inputName: input.name };
  }
  const text = inputs.filter((item) => TEXT_KINDS.has(item.kind));
  if (text.length === 1 && text[0] !== undefined) return { inputName: text[0].name };
  return { reason: 'The pipeline needs a "card" text input, or exactly one text input.' };
}

function orchestrationOf(state: LabState, workspaceId: string): LabOrchestrationWorkspace {
  const existing = state.orchestration.get(workspaceId);
  if (existing !== undefined) return existing;
  const created = emptyOrchestration(workspaceId);
  state.orchestration.set(workspaceId, created);
  return created;
}

export function pipelineInputsOf(state: LabState, workspaceId: string, launchCommandId: string): readonly PipelineInput[] | undefined {
  const orchestration = state.orchestration.get(workspaceId);
  const command = orchestration?.launchCommands.find((item) => item.value.id === launchCommandId)?.value;
  if (command === undefined) return undefined;
  return orchestration?.pipelines.find((item) => item.value.id === command.pipelineId)?.value.inputs ?? [];
}

export function teammateStatus(state: LabState, team: LabTeam, workspaceId: string, teammate: TeammateV1): TeammateStatusV1 {
  const liveRunIds = [...team.liveRuns.entries()]
    .filter(([, run]) => run.workspaceId === workspaceId && run.teammateId === teammate.id)
    .map(([runId]) => runId);
  const queued = team.queuedFor(workspaceId, teammate.id);
  const inputs = pipelineInputsOf(state, workspaceId, teammate.launchCommandId);
  const resolved = inputs === undefined ? { reason: 'Its launch command was deleted.' } : resolveCardInput(inputs, teammate.cardInput);
  return {
    teammateId: teammate.id,
    availability: liveRunIds.length > 0 ? 'working' : queued > 0 ? 'queued' : 'idle',
    liveRunIds,
    queued,
    ...('reason' in resolved ? { notAssignableReason: resolved.reason } : {}),
  };
}

interface ManagedIds {
  profileId: string;
  teamId: string;
  pipelineId: string;
  commandId: string;
  memberId: string;
  stepId: string;
}

function managedIds(teammateId: string): ManagedIds {
  const id = (kind: string): string => labUuid(`teammate:${teammateId}:${kind}`);
  return {
    profileId: id('profile'),
    teamId: id('team'),
    pipelineId: id('pipeline'),
    commandId: id('command'),
    memberId: id('member'),
    stepId: id('step'),
  };
}

function removeManaged(orchestration: LabOrchestrationWorkspace, teammateId: string): void {
  const ids = managedIds(teammateId);
  orchestration.profiles = orchestration.profiles.filter((item) => item.value.id !== ids.profileId);
  orchestration.teams = orchestration.teams.filter((item) => item.value.id !== ids.teamId);
  orchestration.pipelines = orchestration.pipelines.filter((item) => item.value.id !== ids.pipelineId);
  orchestration.launchCommands = orchestration.launchCommands.filter((item) => item.value.id !== ids.commandId);
}

type SimpleAgent = Extract<TeammateDraftV1['body'], { type: 'simple' }>['agent'];

interface SystemShape {
  ids: ManagedIds;
  profileName: string;
  name: string;
  input: PipelineInput;
  instructions: string;
  managedBy?: string;
}

/** One agent, one-member team, one-step pipeline and its launch command (created or replaced). */
function writeSystem(orchestration: LabOrchestrationWorkspace, agent: SimpleAgent, shape: SystemShape): { profileId: string; commandId: string } {
  const { ids } = shape;
  const profile: AgentProfile = {
    id: ids.profileId,
    name: shape.profileName,
    harness: agent.harness,
    ...(agent.modelProvider ? { modelProvider: agent.modelProvider } : {}),
    model: agent.model,
    permissionMode: agent.permissionMode,
    ...(agent.reasoning ? { reasoning: agent.reasoning } : {}),
    ...(agent.serviceTier ? { serviceTier: agent.serviceTier } : {}),
    ...(agent.networkAccess ? { networkAccess: true } : {}),
    instructions: agent.instructions,
    toolPolicy: { rules: [] },
    allowedSpawnProfileIds: [],
  };
  const team: TeamDefinition = {
    id: ids.teamId,
    name: shape.name,
    members: [{ id: ids.memberId, profileId: ids.profileId }],
    sendEdges: [],
    observeEdges: [],
    orchestratorMemberId: ids.memberId,
  };
  const pipeline: PipelineDefinition = {
    id: ids.pipelineId,
    name: shape.name,
    steps: [{ id: ids.stepId, name: shape.profileName, assignedMemberId: ids.memberId, dependencyStepIds: [], instructions: shape.instructions }],
    inputs: [shape.input],
  };
  const command: LaunchCommandReference = {
    id: ids.commandId,
    name: shape.name,
    teamId: ids.teamId,
    pipelineId: ids.pipelineId,
    ...(shape.managedBy === undefined ? {} : { managedByTeammateId: shape.managedBy }),
  };
  const upsert = <T extends { id: string }>(list: { revision: number; value: T }[], value: T): { revision: number; value: T }[] => {
    const index = list.findIndex((item) => item.value.id === value.id);
    if (index < 0) return [...list, { revision: 0, value }];
    const next = [...list];
    next[index] = { revision: (list[index]?.revision ?? 0) + 1, value };
    return next;
  };
  orchestration.profiles = upsert(orchestration.profiles, profile);
  orchestration.teams = upsert(orchestration.teams, team);
  orchestration.pipelines = upsert(orchestration.pipelines, pipeline);
  orchestration.launchCommands = upsert(orchestration.launchCommands, command);
  return { profileId: ids.profileId, commandId: ids.commandId };
}

/** The managed definitions of a simple teammate, marked `managedByTeammateId`. */
function writeManaged(orchestration: LabOrchestrationWorkspace, teammateId: string, name: string, handle: string, agent: SimpleAgent): { profileId: string; commandId: string } {
  return writeSystem(orchestration, agent, {
    ids: managedIds(teammateId),
    profileName: name,
    name: `@${handle}`,
    input: { name: 'card', label: 'Card', kind: 'long-text', required: true },
    instructions: 'Work on this card: {{input.card}}',
    managedBy: teammateId,
  });
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const TOKEN_COLOR = /^[a-z][a-z0-9-]{0,40}$/;

function validBoard(board: BoardPermissionsV1): boolean {
  return Object.values(board).every((value) => typeof value === 'boolean');
}

function validDraft(draft: TeammateDraftV1): boolean {
  const name = draft.name.trim();
  const avatar = [...draft.avatar.trim()];
  return TEAMMATE_HANDLE_PATTERN.test(draft.handle)
    && name.length > 0
    && [...name].length <= 80
    && avatar.length >= 1
    && avatar.length <= 8
    && (HEX_COLOR.test(draft.color) || TOKEN_COLOR.test(draft.color))
    && [...draft.role].length <= MAX_TEAMMATE_ROLE_CHARS
    && Number.isInteger(draft.maxConcurrentRuns)
    && draft.maxConcurrentRuns >= 1
    && draft.maxConcurrentRuns <= 8
    && validBoard(draft.board)
    && (draft.body.type === 'pipeline' || (draft.body.agent.model.trim().length > 0 && draft.body.agent.harness.length > 0));
}

/** Seeds `@coder` (simple, Claude Code) and `@release-team` (wraps a saved release pipeline). */
export function seedLabTeam(runtime: LabSessions, team: LabTeam, workspaceId: string): void {
  const { state } = runtime;
  const orchestration = orchestrationOf(state, workspaceId);
  const now = runtime.clock.iso();
  const permissions: BoardPermissionsV1 = { read: true, comment: true, create: true, move: true, claim: true, assign: false };
  const coderId = labUuid(`teammate:${workspaceId}:coder`);
  const coder = writeManaged(orchestration, coderId, 'Coder', 'coder', {
    harness: 'claude-code',
    model: 'lab-sonnet',
    modelProvider: 'anthropic',
    permissionMode: 'workspace-write',
    reasoning: 'medium',
    instructions: 'Implement the card with the smallest change and run the focused tests.',
  });
  const list: TeammateV1[] = [{
    id: coderId,
    handle: 'coder',
    name: 'Coder',
    color: '#e0364a',
    avatar: 'C',
    role: 'Implements small, well-described code changes and fixes with tests.',
    kind: { type: 'simple', profileId: coder.profileId },
    launchCommandId: coder.commandId,
    cardInput: { type: 'auto' },
    board: permissions,
    maxConcurrentRuns: 2,
    wake: { onAssign: 'ask', onMention: true },
    enabled: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }];
  // `@release-team` wraps a user-authored "Release notes" pipeline (seeded here when the folder has none).
  const existing = orchestration.launchCommands.find((item) => item.value.managedByTeammateId === undefined && /release/i.test(item.value.name))?.value;
  const release = existing ?? {
    id: writeSystem(orchestration, {
      harness: 'codex',
      model: 'gpt-lab-5-codex',
      modelProvider: 'openai-lab',
      permissionMode: 'read-only',
      instructions: 'Summarize what changed and write a short release note.',
    }, {
      ids: managedIds(`${workspaceId}:release-notes`),
      profileName: 'Release notes writer',
      name: 'Release notes',
      input: { name: 'changes', label: 'What changed?', kind: 'long-text', required: true },
      instructions: 'Write a release note for: {{input.changes}}',
    }).commandId,
  };
  list.push({
    id: labUuid(`teammate:${workspaceId}:release-team`),
    handle: 'release-team',
    name: 'Release team',
    color: '#f0c050',
    avatar: '🚀',
    role: 'Checks what changed since the last release and writes the release note.',
    kind: { type: 'pipeline' },
    launchCommandId: release.id,
    cardInput: { type: 'auto' },
    board: { ...permissions, create: false, claim: true },
    maxConcurrentRuns: 1,
    wake: { onAssign: 'always', onMention: false },
    enabled: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  team.teammates.set(workspaceId, list);
}

export function teammatesHandlers(runtime: LabSessions, bus: LabEventBus, team: LabTeam): LabHandlers {
  const { state } = runtime;

  const listOf = (workspaceId: string): TeammateV1[] => team.teammates.get(workspaceId) ?? [];
  const copy = <T>(value: T): T => structuredClone(value);
  const changed = (workspaceId: string): void => bus.emit(TEAMMATES_CHANGED_EVENT_V1, { protocol: 1, workspaceId });

  function requireProject(workspaceId: string): void {
    if (!state.projects.some((project) => project.id === workspaceId)) throw NOT_FOUND;
  }

  function list(workspaceId: string): TeammatesResultV1 {
    requireProject(workspaceId);
    const teammates = listOf(workspaceId);
    return {
      protocol: 1,
      type: 'teammates',
      teammates: teammates.map(copy),
      status: teammates.map((teammate) => teammateStatus(state, team, workspaceId, teammate)),
    };
  }

  function save(workspaceId: string, decoded: TeammateDraftV1): TeammatesResultV1 {
    requireProject(workspaceId);
    const draft: TeammateDraftV1 = { ...decoded, id: decoded.id ?? undefined, expectedRevision: decoded.expectedRevision ?? undefined };
    if (!validDraft(draft)) throw INVALID;
    const teammates = listOf(workspaceId);
    const index = draft.id === undefined ? -1 : teammates.findIndex((item) => item.id === draft.id);
    const existing = index < 0 ? undefined : teammates[index];
    if (draft.id !== undefined && existing === undefined) throw NOT_FOUND;
    if (existing !== undefined && draft.expectedRevision !== existing.revision) throw CONFLICT;
    if (existing === undefined && teammates.length >= MAX_TEAMMATES_PER_WORKSPACE) throw LIMIT;
    if (teammates.some((item) => item.handle === draft.handle && item.id !== draft.id)) throw HANDLE_TAKEN;
    const orchestration = orchestrationOf(state, workspaceId);
    const id = existing?.id ?? state.ids.next('teammate');
    const name = draft.name.trim();
    let kind: TeammateV1['kind'];
    let launchCommandId: string;
    if (draft.body.type === 'simple') {
      const managed = writeManaged(orchestration, id, name, draft.handle, draft.body.agent);
      kind = { type: 'simple', profileId: managed.profileId };
      launchCommandId = managed.commandId;
    } else {
      const commandId = draft.body.launchCommandId;
      const command = orchestration.launchCommands.find((item) => item.value.id === commandId)?.value;
      if (command === undefined || (command.managedByTeammateId !== undefined && command.managedByTeammateId !== id)) throw NOT_FOUND;
      if (existing?.kind.type === 'simple') removeManaged(orchestration, id);
      kind = { type: 'pipeline' };
      launchCommandId = command.id;
    }
    const now = runtime.clock.iso();
    const teammate: TeammateV1 = {
      id,
      handle: draft.handle,
      name,
      color: draft.color,
      avatar: draft.avatar.trim(),
      role: draft.role.trim(),
      kind,
      launchCommandId,
      cardInput: copy(draft.cardInput),
      board: copy(draft.board),
      maxConcurrentRuns: draft.maxConcurrentRuns,
      wake: copy(draft.wake),
      enabled: draft.enabled,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = [...teammates];
    if (index < 0) next.push(teammate);
    else next[index] = teammate;
    team.teammates.set(workspaceId, next);
    changed(workspaceId);
    return { protocol: 1, type: 'teammate', teammate: copy(teammate), status: teammateStatus(state, team, workspaceId, teammate) };
  }

  function remove(workspaceId: string, teammateId: string, expectedRevision: number): TeammatesResultV1 {
    requireProject(workspaceId);
    const teammates = listOf(workspaceId);
    const existing = teammates.find((item) => item.id === teammateId);
    if (existing === undefined) throw NOT_FOUND;
    if (existing.revision !== expectedRevision) throw CONFLICT;
    if (existing.kind.type === 'simple') removeManaged(orchestrationOf(state, workspaceId), teammateId);
    team.teammates.set(workspaceId, teammates.filter((item) => item.id !== teammateId));
    changed(workspaceId);
    return { protocol: 1, type: 'deleted', teammateId };
  }

  function setEnabled(workspaceId: string, teammateId: string, enabled: boolean): TeammatesResultV1 {
    requireProject(workspaceId);
    const teammates = listOf(workspaceId);
    const index = teammates.findIndex((item) => item.id === teammateId);
    const existing = teammates[index];
    if (existing === undefined) throw NOT_FOUND;
    const teammate: TeammateV1 = { ...existing, enabled, revision: existing.revision + 1, updatedAt: runtime.clock.iso() };
    const next = [...teammates];
    next[index] = teammate;
    team.teammates.set(workspaceId, next);
    changed(workspaceId);
    return { protocol: 1, type: 'teammate', teammate: copy(teammate), status: teammateStatus(state, team, workspaceId, teammate) };
  }

  function dispatch(command: TeammatesCommandV1): TeammatesResultV1 {
    if (state.safeMode && command.type !== 'list') throw SAFE_MODE;
    switch (command.type) {
      case 'list':
        return list(command.workspaceId);
      case 'save':
        return save(command.workspaceId, command.teammate);
      case 'delete':
        return remove(command.workspaceId, command.teammateId, command.expectedRevision);
      case 'setEnabled':
        return setEnabled(command.workspaceId, command.teammateId, command.enabled);
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  return {
    teammates_command_v1: (args) => dispatch(decodeArgument<TeammatesCommandV1>(args, 'command', commandSchema)),
  };
}
