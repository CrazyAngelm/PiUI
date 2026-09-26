import type {
  AgentProfile, HarnessSummary, LaunchCommandReference, OrchestrationHostErrorCode, PipelineDefinition, PipelineStep,
  ResultField, RouterPredicate, RunDefinitionSnapshot, TeamDefinition,
} from '../labContracts';
import type { LabOrchestrationWorkspace } from '../labState';
import { pipelineInputIssues, reviewLimitValid } from '../../runInputs';

/**
 * Definition rules from `piui-orchestration/validation.rs`, the per-kind
 * `valid_for_workspace` checks in `orchestration_api.rs` and the adapter
 * `launch_policy`. They return a reason (or undefined) instead of throwing so
 * callers can map to the exact host error code of their route.
 */
const blank = (value: string): boolean => value.trim() === '';
const REASONING = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/** `advisory` is not isolation: a mandatory rule must be enforced natively or by the coordinator. */
function unenforcedMandatory(rule: AgentProfile['toolPolicy']['rules'][number]): boolean {
  return rule.mandatory && (rule.enforcement === 'advisory' || rule.enforcement === 'unsupported');
}

function validPredicate(predicate: RouterPredicate, fields: readonly ResultField[]): boolean {
  switch (predicate.op) {
    case 'equals': {
      const field = fields.find((candidate) => candidate.name === predicate.field);
      if (field === undefined) return false;
      const value = predicate.value;
      return value === null
        || (field.kind === 'text' && typeof value === 'string')
        || (field.kind === 'number' && typeof value === 'number')
        || (field.kind === 'boolean' && typeof value === 'boolean');
    }
    case 'exists':
      return fields.some((field) => field.name === predicate.field);
    case 'all':
    case 'any':
      return predicate.predicates.length > 0 && predicate.predicates.every((item) => validPredicate(item, fields));
    case 'not':
      return validPredicate(predicate.predicate, fields);
    default: {
      const exhaustive: never = predicate;
      return exhaustive;
    }
  }
}

function ancestors(steps: readonly PipelineStep[], step: PipelineStep): Set<string> {
  const seen = new Set<string>();
  const pending = [...step.dependencyStepIds];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(steps.find((candidate) => candidate.id === id)?.dependencyStepIds ?? []));
  }
  return seen;
}

function stepIssue(steps: readonly PipelineStep[], step: PipelineStep, members: ReadonlySet<string>): string | undefined {
  const fieldsOf = (id: string): readonly ResultField[] => steps.find((candidate) => candidate.id === id)?.resultFields ?? [];
  const bindings = step.inputBindings ?? [];
  if (duplicates(bindings.map((binding) => binding.name)) || bindings.some((binding) => blank(binding.name)
    || !step.dependencyStepIds.includes(binding.sourceStepId)
    || !fieldsOf(binding.sourceStepId).some((field) => field.name === binding.field))) return 'input binding';
  const condition = step.condition;
  if (condition && (!step.dependencyStepIds.includes(condition.sourceStepId)
    || !fieldsOf(condition.sourceStepId).some((field) => field.name === condition.field)
    || !['string', 'number', 'boolean'].includes(typeof condition.equals))) return 'condition';
  const review = step.review;
  if (review && (!ancestors(steps, step).has(review.retryFromStepId)
    || !(step.resultFields ?? []).some((field) => field.name === review.field && field.kind === 'boolean'))) return 'review';
  const router = step.router;
  if (router) {
    if (step.dependencyStepIds.length !== 1 || step.dependencyStepIds[0] !== router.inputStepId) return 'router input';
    if (duplicates(router.branches.map((branch) => branch.id))
      || router.branches.some((branch) => blank(branch.id) || blank(branch.label))) return 'router branches';
    const inputFields = fieldsOf(router.inputStepId);
    const invalidBranch = (branch: (typeof router.branches)[number]): boolean =>
      branch.predicate === undefined || !validPredicate(branch.predicate, inputFields);
    if (router.mode === 'program' && router.branches.some(invalidBranch)) return 'router predicate';
    if (router.mode === 'agent') {
      if (router.branches.some((branch) => branch.predicate || !branch.description?.trim())) return 'agent router branches';
      const field = router.selectionField?.trim();
      if (!field || !(step.resultFields ?? []).some((candidate) => candidate.name === field && candidate.kind === 'text-list')) {
        return 'agent router selection';
      }
    }
    if ((step.routeGates ?? []).length > 0) return 'gated router';
  }
  for (const gate of step.routeGates ?? []) {
    const routerStep = steps.find((candidate) => candidate.id === gate.routerStepId);
    if (!routerStep?.router || !step.dependencyStepIds.includes(gate.routerStepId)
      || !routerStep.router.branches.some((branch) => branch.id === gate.branchId)) return 'route gate';
  }
  const fields = (step.resultFields ?? []).map((field) => field.name);
  if (fields.some(blank) || duplicates(fields)) return 'result fields';
  if (blank(step.name)) return 'step name';
  if (step.router?.mode !== 'program' && !members.has(step.assignedMemberId)) return 'assigned member';
  if (duplicates(step.dependencyStepIds) || step.dependencyStepIds.some((id) => !steps.some((candidate) => candidate.id === id))) {
    return 'dependencies';
  }
  return undefined;
}

function acyclic(steps: readonly PipelineStep[]): boolean {
  const indegree = new Map(steps.map((step) => [step.id, step.dependencyStepIds.length]));
  const ready = steps.filter((step) => step.dependencyStepIds.length === 0).map((step) => step.id);
  let visited = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    visited += 1;
    for (const child of steps.filter((step) => step.dependencyStepIds.includes(id))) {
      const degree = (indegree.get(child.id) ?? 0) - 1;
      indegree.set(child.id, degree);
      if (degree === 0) ready.push(child.id);
    }
  }
  return visited === steps.length;
}

/** `validate_pipeline_declarations`: run input declarations, then review loop bounds. */
export function pipelineDeclarationIssue(pipeline: PipelineDefinition): string | undefined {
  if (pipelineInputIssues(pipeline.inputs).length > 0) return 'run inputs';
  if (pipeline.steps.some((step) => !reviewLimitValid(step.review))) return 'review limit';
  return undefined;
}

/** `validate_definition`: the whole snapshot a run or graph save would capture. */
export function definitionIssue(snapshot: RunDefinitionSnapshot): string | undefined {
  const profileIds = snapshot.profiles.map((profile) => profile.id);
  if (profileIds.some(blank) || duplicates(profileIds)) return 'profile ids';
  for (const profile of snapshot.profiles) {
    if (blank(profile.name) || blank(profile.model)) return 'profile name or model';
    const tools = profile.toolPolicy.rules.map((rule) => rule.tool);
    if (tools.some(blank) || duplicates(tools)) return 'tool rules';
    if (profile.toolPolicy.rules.some(unenforcedMandatory)) return 'mandatory policy';
    if (duplicates([...profile.allowedSpawnProfileIds])
      || profile.allowedSpawnProfileIds.some((id) => !profileIds.includes(id))) return 'spawn profiles';
  }
  const team = snapshot.team;
  const memberIds = team.members.map((member) => member.id);
  if (blank(team.id) || blank(team.name) || memberIds.some(blank) || duplicates(memberIds)) return 'team';
  if (team.members.some((member) => !profileIds.includes(member.profileId))) return 'member profile';
  if (!memberIds.includes(team.orchestratorMemberId)) return 'orchestrator';
  for (const edges of [team.sendEdges, team.observeEdges]) {
    const keys = edges.map((edge) => `${edge.fromMemberId}\u0000${edge.toMemberId}`);
    if (duplicates(keys) || edges.some((edge) => !memberIds.includes(edge.fromMemberId) || !memberIds.includes(edge.toMemberId))) {
      return 'team edges';
    }
  }
  const pipeline = snapshot.pipeline;
  const steps = pipeline.steps;
  if (!steps.some((step) => step.executionMode !== 'callable')) return 'no scheduled step';
  const callable = new Set(steps.filter((step) => step.executionMode === 'callable').map((step) => step.id));
  if (steps.some((step) => (callable.has(step.id) && step.dependencyStepIds.length > 0)
    || step.dependencyStepIds.some((id) => callable.has(id)))) return 'callable dependency';
  if (blank(pipeline.id) || blank(pipeline.name)) return 'pipeline';
  const declarations = pipelineDeclarationIssue(pipeline);
  if (declarations !== undefined) return declarations;
  const stepIds = steps.map((step) => step.id);
  if (stepIds.some(blank) || duplicates(stepIds)) return 'step ids';
  const members = new Set(memberIds);
  for (const step of steps) {
    const issue = stepIssue(steps, step, members);
    if (issue !== undefined) return issue;
  }
  if (!acyclic(steps)) return 'dependency cycle';
  const command = snapshot.launchCommand;
  if (command && (blank(command.id) || blank(command.name) || command.teamId !== team.id || command.pipelineId !== pipeline.id)) {
    return 'launch command';
  }
  return undefined;
}

/** `spawn_permissions_subset`: a child never gains file, network, tool, resource or delegation authority. */
export function spawnSubset(parent: AgentProfile, child: AgentProfile): boolean {
  const files = parent.permissionMode === 'native' || child.permissionMode === 'native'
    ? parent.permissionMode === child.permissionMode && parent.harness === child.harness
    : (parent.permissionMode === 'full-access')
      || (parent.permissionMode === 'workspace-write' && child.permissionMode !== 'full-access')
      || (parent.permissionMode === 'read-only' && child.permissionMode === 'read-only');
  if (!files || (child.networkAccess === true && parent.networkAccess !== true)) return false;
  const deniesKept = parent.toolPolicy.rules.every((rule) => rule.decision !== 'deny'
    || child.toolPolicy.rules.some((candidate) => candidate.tool === rule.tool && candidate.decision === 'deny'
      && candidate.enforcement === rule.enforcement && (!rule.mandatory || candidate.mandatory)));
  if (!deniesKept) return false;
  const nativeParent = parent.toolPolicy.rules.filter((rule) => rule.enforcement === 'native');
  const nativeChild = child.toolPolicy.rules.filter((rule) => rule.enforcement === 'native');
  if (nativeParent.length > 0 && (nativeChild.length === 0 || nativeChild.some((rule) => rule.decision === 'allow'
    && !nativeParent.some((candidate) => candidate.tool === rule.tool && candidate.decision === 'allow')))) return false;
  const disabledKept = (parent.resourceRules ?? []).every((rule) => rule.enabled
    || (child.resourceRules ?? []).some((candidate) => candidate.kind === rule.kind && candidate.id === rule.id && !candidate.enabled));
  return disabledKept && child.allowedSpawnProfileIds.every((id) => parent.allowedSpawnProfileIds.includes(id));
}

/** Per-kind checks the host runs against the workspace's other definitions on save. */
export function profileValid(profile: AgentProfile, workspace: LabOrchestrationWorkspace): boolean {
  const tierOk = profile.serviceTier === undefined
    || ((profile.harness === 'codex' || profile.harness === 'prime-agent') && ['standard', 'fast'].includes(profile.serviceTier));
  return !blank(profile.id) && !blank(profile.name) && !blank(profile.model) && tierOk
    && (profile.reasoning === undefined || REASONING.includes(profile.reasoning))
    && profile.allowedSpawnProfileIds.every((id) => id === profile.id || workspace.profiles.some((stored) => stored.value.id === id))
    && profile.toolPolicy.rules.every((rule) => !blank(rule.tool) && !unenforcedMandatory(rule));
}

export function teamValid(team: TeamDefinition, workspace: LabOrchestrationWorkspace): boolean {
  return !blank(team.id) && !blank(team.name)
    && team.members.every((member) => workspace.profiles.some((profile) => profile.value.id === member.profileId));
}

export function pipelineValid(pipeline: PipelineDefinition): boolean {
  return !blank(pipeline.id) && !blank(pipeline.name) && pipelineDeclarationIssue(pipeline) === undefined;
}

export function launchCommandValid(command: LaunchCommandReference, workspace: LabOrchestrationWorkspace): boolean {
  return !blank(command.id) && !blank(command.name)
    && workspace.teams.some((team) => team.value.id === command.teamId)
    && workspace.pipelines.some((pipeline) => pipeline.value.id === command.pipelineId);
}

const NATIVE_TOOLS: Readonly<Record<AgentProfile['harness'], readonly string[]>> = {
  pi: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
  'prime-agent': ['ipython', 'workspace'],
  codex: [],
  hermes: [],
};

const PERMISSION_MODES: Readonly<Record<AgentProfile['harness'], readonly AgentProfile['permissionMode'][]>> = {
  pi: ['native', 'read-only', 'full-access'],
  'prime-agent': ['native'],
  codex: ['native', 'read-only', 'workspace-write', 'full-access'],
  hermes: ['native'],
};

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const MCP_NAME = /^[A-Za-z0-9_-]+$/;

function resourceRuleUnsupported(profile: AgentProfile, rule: NonNullable<AgentProfile['resourceRules']>[number]): boolean {
  if (blank(rule.id)) return true;
  switch (profile.harness) {
    case 'pi':
    case 'hermes':
      return true;
    case 'prime-agent':
      return rule.kind !== 'skill';
    case 'codex':
      return rule.kind === 'skill' ? !ABSOLUTE_PATH.test(rule.id) : !MCP_NAME.test(rule.id);
    default: {
      const exhaustive: never = profile.harness;
      return exhaustive;
    }
  }
}

/** `launch_policy`: adapter refusals recorded before any native process starts. */
export function launchPolicyIssue(profile: AgentProfile, summary: HarnessSummary | undefined): OrchestrationHostErrorCode | undefined {
  if (summary?.status !== 'available') return 'runtime-unavailable';
  const networkUnsupported = profile.networkAccess === true && (profile.harness !== 'codex'
    || (profile.permissionMode !== 'read-only' && profile.permissionMode !== 'workspace-write'));
  const unsupported = (profile.baseInstructions !== undefined && profile.harness !== 'codex')
    || (profile.serviceTier !== undefined && (profile.harness === 'pi' || profile.harness === 'hermes'))
    || networkUnsupported
    || (profile.resourceRules ?? []).some((rule) => resourceRuleUnsupported(profile, rule))
    || !PERMISSION_MODES[profile.harness].includes(profile.permissionMode)
    || profile.toolPolicy.rules.some((rule) => rule.enforcement === 'native' && !NATIVE_TOOLS[profile.harness].includes(rule.tool));
  return unsupported ? 'unsupported-policy' : undefined;
}

/** `Option<T>` fields decoded from `null` are stored as absent; JSON values keep their nulls. */
function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => dropNulls(item)) as T;
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value).filter(([key, item]) => item !== null || key === 'value' || key === 'equals');
  return Object.fromEntries(entries.map(([key, item]) => [key, key === 'value' || key === 'equals' ? item : dropNulls(item)])) as T;
}

/** Serde defaults the host drops when it stores a definition. */
export function normalizeProfile(profile: AgentProfile): AgentProfile {
  const { networkAccess, resourceRules, ...rest } = dropNulls(profile);
  return { ...rest, ...(networkAccess ? { networkAccess } : {}), ...(resourceRules?.length ? { resourceRules } : {}) };
}

export function normalizeTeam(team: TeamDefinition): TeamDefinition {
  const { spawnedAgentsJoinTeam, ...rest } = team;
  return { ...rest, ...(spawnedAgentsJoinTeam ? { spawnedAgentsJoinTeam } : {}) };
}

export function normalizePipeline(pipeline: PipelineDefinition): PipelineDefinition {
  const { inputs, ...definition } = pipeline;
  // Serde field order; `null` options are absent and empty defaults are skipped.
  const declared = dropNulls(inputs ?? []).map(({ name, label, kind, required, description, options, defaultValue }) => ({
    name,
    label,
    kind,
    ...(required ? { required } : {}),
    ...(description === undefined ? {} : { description }),
    ...(options?.length ? { options } : {}),
    ...(defaultValue === undefined ? {} : { defaultValue }),
  }));
  return {
    ...definition,
    steps: dropNulls(pipeline.steps).map((step) => {
      const { inputBindings, routeGates, resultFields, requireApproval, ...rest } = step;
      return {
        ...rest,
        ...(inputBindings?.length ? { inputBindings } : {}),
        ...(routeGates?.length ? { routeGates } : {}),
        ...(resultFields?.length ? { resultFields } : {}),
        ...(requireApproval ? { requireApproval } : {}),
      };
    }),
    ...(declared.length ? { inputs: declared } : {}),
  };
}
