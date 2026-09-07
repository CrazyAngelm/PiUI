import type {
  AgentProfile,
  Harness,
  PermissionMode,
  PolicyEnforcement,
  ToolDecision,
  ToolRule,
} from '../../../../../contracts/orchestration-v5';

export interface ProfileDraft {
  id: string;
  name: string;
  harness: Harness;
  modelProvider: string;
  model: string;
  reasoning: string;
  serviceTier: 'standard' | 'fast';
  permissionMode: PermissionMode;
  instructions: string;
  whenToCall: string;
  inputInstructions: string;
  expectedResult: string;
  replaceBasePrompt: boolean;
  baseInstructions: string;
  toolRules: ToolRule[];
  resourceRules: NonNullable<AgentProfile['resourceRules']>;
  allowedSpawnProfileIds: string[];
}

export interface ProfileDraftValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function createProfileDraft(
  profile: AgentProfile | undefined,
  createId: () => string = () => crypto.randomUUID(),
): ProfileDraft {
  if (profile === undefined) {
    return {
      id: createId(),
      name: '',
      harness: 'pi',
      modelProvider: '',
      model: '',
      reasoning: '',
      serviceTier: 'standard',
      permissionMode: 'native',
      instructions: '', whenToCall: '', inputInstructions: '', expectedResult: '',
      replaceBasePrompt: false,
      baseInstructions: '',
      toolRules: [],
      resourceRules: [],
      allowedSpawnProfileIds: [],
    };
  }

  return {
    id: profile.id,
    name: profile.name,
    harness: profile.harness,
    modelProvider: profile.modelProvider ?? '',
    model: profile.model,
    reasoning: profile.reasoning ?? '',
    serviceTier: profile.serviceTier ?? 'standard',
    permissionMode: profile.permissionMode,
    instructions: profile.instructions,
    whenToCall: profile.whenToCall ?? '', inputInstructions: profile.inputInstructions ?? '', expectedResult: profile.expectedResult ?? '',
    replaceBasePrompt: profile.baseInstructions !== undefined,
    baseInstructions: profile.baseInstructions ?? '',
    resourceRules: profile.resourceRules ?? [],
    toolRules: profile.toolPolicy.rules.map((rule) => ({ ...rule })),
    allowedSpawnProfileIds: [...profile.allowedSpawnProfileIds],
  };
}

export function profileFromDraft(draft: ProfileDraft): AgentProfile {
  const provider = draft.modelProvider.trim();
  return {
    id: draft.id,
    name: draft.name.trim(),
    harness: draft.harness,
    ...(provider === '' ? {} : { modelProvider: provider }),
    model: draft.model.trim(),
    ...(draft.reasoning ? { reasoning: draft.reasoning } : {}),
    ...(!['pi', 'hermes'].includes(draft.harness) ? { serviceTier: draft.serviceTier } : {}),
    permissionMode: draft.permissionMode,
    instructions: draft.instructions,
    ...(draft.whenToCall ? { whenToCall: draft.whenToCall } : {}),
    ...(draft.inputInstructions ? { inputInstructions: draft.inputInstructions } : {}),
    ...(draft.expectedResult ? { expectedResult: draft.expectedResult } : {}),
    ...(draft.replaceBasePrompt && draft.harness === 'codex' ? { baseInstructions: draft.baseInstructions } : {}),
    ...(draft.resourceRules.length ? { resourceRules: draft.resourceRules } : {}),
    toolPolicy: { rules: draft.toolRules.map((rule) => ({ ...rule, tool: rule.tool.trim() })) },
    allowedSpawnProfileIds: [...draft.allowedSpawnProfileIds],
  };
}

export function validateProfileDraft(draft: ProfileDraft): ProfileDraftValidation {
  const errors: string[] = [];
  if (draft.resourceRules.some(rule => !rule.id.trim())) errors.push('Name every resource rule or remove it.');
  if (new Set(draft.resourceRules.map(rule => `${rule.kind}:${rule.id}`)).size !== draft.resourceRules.length) errors.push('Remove duplicate resource rules.');
  if (draft.name.trim() === '') errors.push('Enter a profile name.');
  if (draft.model.trim() === '') errors.push('Enter a model.');
  if (draft.toolRules.some((rule) => rule.tool.trim() === '')) errors.push('Name every declared tool rule or remove it.');
  return { valid: errors.length === 0, errors };
}

export function newToolRule(): ToolRule {
  return { tool: '', decision: 'deny', enforcement: 'advisory', mandatory: false };
}

export function spawnProfileOptions(
  profiles: readonly AgentProfile[],
  currentProfileId: string,
): readonly AgentProfile[] {
  void currentProfileId;
  return profiles;
}

export function enforcementLabel(enforcement: PolicyEnforcement): string {
  switch (enforcement) {
    case 'native': return 'Native-enforced';
    case 'coordinator': return 'Coordinator-enforced';
    case 'advisory': return 'Advisory';
    case 'unsupported': return 'Unsupported';
  }
}

export function toolDecisionLabel(decision: ToolDecision): string {
  return decision === 'allow' ? 'Allow' : 'Deny';
}
