import type {
  AgentProfile,
  Harness,
  PermissionMode,
  PolicyEnforcement,
  ToolDecision,
  ToolRule,
} from '../../../../../contracts/orchestration-v2';

export interface ProfileDraft {
  id: string;
  name: string;
  harness: Harness;
  modelProvider: string;
  model: string;
  permissionMode: PermissionMode;
  instructions: string;
  replaceBasePrompt: boolean;
  baseInstructions: string;
  toolRules: ToolRule[];
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
      permissionMode: 'native',
      instructions: '',
      replaceBasePrompt: false,
      baseInstructions: '',
      toolRules: [],
      allowedSpawnProfileIds: [],
    };
  }

  return {
    id: profile.id,
    name: profile.name,
    harness: profile.harness,
    modelProvider: profile.modelProvider ?? '',
    model: profile.model,
    permissionMode: profile.permissionMode,
    instructions: profile.instructions,
    replaceBasePrompt: profile.baseInstructions !== undefined,
    baseInstructions: profile.baseInstructions ?? '',
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
    permissionMode: draft.permissionMode,
    instructions: draft.instructions,
    ...(draft.replaceBasePrompt && draft.harness === 'codex' ? { baseInstructions: draft.baseInstructions } : {}),
    toolPolicy: { rules: draft.toolRules.map((rule) => ({ ...rule, tool: rule.tool.trim() })) },
    allowedSpawnProfileIds: [...draft.allowedSpawnProfileIds],
  };
}

export function validateProfileDraft(draft: ProfileDraft): ProfileDraftValidation {
  const errors: string[] = [];
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
