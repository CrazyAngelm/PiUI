import type {
  Capability, DesktopTimelineBlock, HarnessCapabilities, HarnessCatalogModel, HarnessKind, HarnessModelsResult,
  HarnessSummary, PermissionMode, WorkspaceModel,
} from './labContracts';
import { isAcpHarness } from '../../../../../contracts/harness-identity-v2';

/**
 * Native harness inventory for the lab. Model and resource names are clearly
 * fake ("lab") while keeping the shapes and per-adapter rules of the real
 * bridges: which harness reports reasoning levels, Fast, skills and MCP.
 */
export const HARNESS_ORDER: readonly HarnessKind[] = ['pi', 'prime-agent', 'codex', 'hermes', 'claude-code'];

export const HARNESS_NAMES: Readonly<Record<HarnessKind, string>> = {
  pi: 'Pi',
  'prime-agent': 'Prime Agent',
  codex: 'Codex',
  hermes: 'Hermes',
  'claude-code': 'Claude Code',
};

const VERSIONS: Readonly<Record<HarnessKind, string>> = {
  pi: '0.72.1',
  'prime-agent': '0.9.2',
  codex: '0.147.0',
  hermes: '0.21.0',
  'claude-code': '2.1.232',
};

/** The host's fixed status for a Claude Code login that is not a Claude subscription. */
export const CLAUDE_SIGN_IN_MESSAGE = 'Sign in to Claude Code with your Claude subscription: run `claude` in a terminal and use /login.';

/** Mirrors the host: the last start was refused for a missing subscription login. */
export function claudeSignInRequired(summaries: readonly HarnessSummary[]): boolean {
  return summaries.some((summary) => summary.kind === 'claude-code' && summary.reason === CLAUDE_SIGN_IN_MESSAGE);
}

/** Every adapter verified: the demo can create sessions on all five harnesses. */
export function readyHarnesses(): HarnessSummary[] {
  return HARNESS_ORDER.map((kind) => ({
    kind,
    name: HARNESS_NAMES[kind],
    installed: true,
    version: VERSIONS[kind],
    status: 'available',
  }));
}

/**
 * A fresh machine: two adapters ready, one needing verification, one missing,
 * and Claude Code installed but not signed in with a Claude subscription.
 */
export function firstRunHarnesses(): HarnessSummary[] {
  return readyHarnesses().map((summary): HarnessSummary => {
    if (summary.kind === 'prime-agent') {
      return {
        ...summary,
        version: '0.8.1',
        status: 'unverified',
        reason: 'The installed native harness version is not supported by this adapter.',
      };
    }
    if (summary.kind === 'hermes') {
      return { kind: 'hermes', name: 'Hermes', installed: false, status: 'unavailable', reason: 'The native harness is not installed.' };
    }
    // Still available: every start verifies the native login again.
    if (summary.kind === 'claude-code') return { ...summary, reason: CLAUDE_SIGN_IN_MESSAGE };
    return summary;
  });
}

const supported = (enforcement: Capability['enforcement'] = 'native'): Capability => ({ supported: true, enforcement });
const unsupported = (reason: string): Capability => ({ supported: false, enforcement: 'unsupported', reason });

/** Mirrors `offline_harness_capabilities`. */
export function harnessCapabilities(kind: HarnessKind, summary: HarnessSummary | undefined): HarnessCapabilities {
  const signInRequired = kind === 'claude-code' && summary?.reason === CLAUDE_SIGN_IN_MESSAGE;
  if (summary?.status !== 'available' || signInRequired) {
    const blocked = unsupported(signInRequired ? CLAUDE_SIGN_IN_MESSAGE : 'The installed native adapter is unavailable or unverified.');
    return {
      prompt: blocked, resume: blocked, models: blocked, approvals: blocked,
      instructions: blocked, toolPolicy: blocked, nativeSubagents: blocked,
    };
  }
  // Mirrors `acp_harness_capabilities`.
  if (isAcpHarness(kind)) {
    return {
      prompt: supported(),
      resume: { ...supported(), reason: 'Only when the agent advertises session/load.' },
      models: { ...supported(), reason: "Models, modes and reasoning come from the agent's own session options." },
      approvals: supported(),
      instructions: { ...supported('coordinator'), reason: 'Sent with the first prompt; the agent keeps its own system prompt.' },
      toolPolicy: unsupported('ACP does not expose per-session tool restrictions.'),
      nativeSubagents: unsupported('ACP does not expose native delegation restrictions.'),
    };
  }
  switch (kind) {
    case 'pi':
      return {
        prompt: supported(), resume: supported(), models: supported(), approvals: supported(), instructions: supported(),
        toolPolicy: {
          supported: true,
          enforcement: 'native',
          reason: 'Pi RPC supports a native read-only or explicit tool allowlist policy.',
        },
        nativeSubagents: unsupported('Native subagent policy is not exposed by Pi RPC.'),
      };
    case 'prime-agent':
      return {
        prompt: supported(), resume: supported(), models: supported(),
        approvals: unsupported('Prime headless approval mapping is not implemented.'),
        instructions: supported(), toolPolicy: supported(), nativeSubagents: supported(),
      };
    case 'hermes':
      return {
        prompt: supported(), resume: supported(), models: supported(), approvals: supported(),
        instructions: supported('coordinator'),
        toolPolicy: unsupported('Hermes ACP does not expose per-session tool restrictions.'),
        nativeSubagents: unsupported('Hermes ACP does not expose native delegation restrictions.'),
      };
    case 'codex':
      return {
        prompt: supported(), resume: supported(), models: supported(), approvals: supported(), instructions: supported(),
        toolPolicy: unsupported('Codex app-server has no restrictive tool allowlist contract.'),
        nativeSubagents: supported(),
      };
    case 'claude-code':
      return {
        prompt: supported(), resume: supported(),
        models: { ...supported(), reason: 'Models and effort levels come from the Claude Code initialize catalog.' },
        approvals: { ...supported(), reason: 'Claude Code permission prompts; read-only and workspace-write sessions can only deny them.' },
        instructions: { ...supported(), reason: "Appended to Claude Code's own system prompt; the base prompt is kept." },
        toolPolicy: { ...supported(), reason: 'Claude Code built-in tool allowlist; user MCP servers are excluded under a policy.' },
        nativeSubagents: {
          ...supported('coordinator'),
          reason: 'Managed runs disable the native Agent tool and delegate through the PiUI coordinator.',
        },
      };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function model(
  provider: string,
  id: string,
  name: string,
  thinkingLevels: readonly string[] | undefined,
  supportsFast: boolean,
): HarnessCatalogModel {
  return { id, provider, name, ...(thinkingLevels ? { thinkingLevels: [...thinkingLevels] } : {}), supportsFast };
}

const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const CODEX_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const CLAUDE_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

export const HARNESS_MODELS: Readonly<Record<HarnessKind, readonly HarnessCatalogModel[]>> = {
  pi: [
    model('anthropic-lab', 'claude-lab-sonnet', 'Claude Lab Sonnet', PI_LEVELS, false),
    model('anthropic-lab', 'claude-lab-haiku', 'Claude Lab Haiku', ['off', 'low', 'medium', 'high'], false),
    model('openai-lab', 'gpt-lab-5', 'GPT Lab 5', ['minimal', 'low', 'medium', 'high'], false),
    model('local-lab', 'qwen-lab-coder', 'Qwen Lab Coder (local)', undefined, false),
  ],
  'prime-agent': [
    model('prime-lab', 'prime-lab-large', 'Prime Lab Large', ['off', 'low', 'medium', 'high', 'xhigh'], true),
    model('prime-lab', 'prime-lab-small', 'Prime Lab Small', ['off', 'low', 'medium'], false),
  ],
  codex: [
    model('openai-lab', 'gpt-lab-5-codex', 'GPT Lab 5 Codex', CODEX_LEVELS, true),
    model('openai-lab', 'gpt-lab-5-mini', 'GPT Lab 5 Mini', ['minimal', 'low', 'medium', 'high'], true),
    model('openai-lab', 'o-lab-deep', 'O Lab Deep Research', ['medium', 'high', 'xhigh'], true),
  ],
  hermes: [
    model('nous-lab', 'hermes-lab-70b', 'Hermes Lab 70B', undefined, false),
    model('nous-lab', 'hermes-lab-8b', 'Hermes Lab 8B', undefined, false),
  ],
  // The bridge reports provider `anthropic` and never offers fast mode.
  'claude-code': [
    model('anthropic', 'lab-sonnet', 'Claude Lab Sonnet', CLAUDE_EFFORT.slice(0, 3), false),
    model('anthropic', 'lab-opus', 'Claude Lab Opus', CLAUDE_EFFORT, false),
    model('anthropic', 'lab-haiku', 'Claude Lab Haiku', [], false),
  ],
};

/** The live runtime's `models()` projection: catalog models without Fast metadata. */
export function runtimeModels(kind: HarnessKind): WorkspaceModel[] {
  return HARNESS_MODELS[kind].map(({ supportsFast: _fast, ...model }) => ({ ...model }));
}

export function defaultModel(kind: HarnessKind): WorkspaceModel {
  const [first] = runtimeModels(kind);
  if (first === undefined) throw new Error(`No lab model for ${kind}.`);
  return first;
}

export function catalogModel(kind: HarnessKind, id: string, provider: string | undefined): HarnessCatalogModel | undefined {
  return HARNESS_MODELS[kind].find((model) => model.id === id && model.provider === provider);
}

type Resource = HarnessModelsResult['resources']['items'][number];

function resource(kind: Resource['kind'], id: string, name: string, enabled: boolean, configurable: boolean): Resource {
  return { kind, id, name, enabled, configurable };
}

export const HARNESS_RESOURCES: Readonly<Record<HarnessKind, HarnessModelsResult['resources']>> = {
  pi: {
    items: [
      ...['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'].map((id) => resource('tool', id, id, true, true)),
      resource('skill', 'skill:release-notes', 'release-notes', true, false),
      resource('skill', 'skill:lab-changelog', 'lab-changelog', true, false),
    ],
    warnings: [],
  },
  'prime-agent': {
    items: [
      resource('skill', 'code-review', 'code-review', true, true),
      resource('skill', 'storyboard', 'storyboard', true, true),
      resource('skill', 'data-analysis', 'data-analysis', false, true),
      resource('tool', 'ipython', 'ipython', true, true),
      resource('tool', 'workspace', 'workspace', true, true),
      resource('tool', 'web_search', 'web_search', true, false),
    ],
    warnings: [],
  },
  codex: {
    items: [
      resource('skill', '/lab/codex/skills/test-runner/SKILL.md', 'test-runner', true, true),
      resource('skill', '/lab/codex/skills/pr-describer/SKILL.md', 'pr-describer', false, true),
      resource('mcp', 'lab-issues', 'lab-issues', true, true),
      resource('mcp', 'lab-docs', 'lab-docs', true, true),
      resource('mcp', 'lab-figma-mock', 'lab-figma-mock', false, true),
      resource('tool', 'lab-issues.search', 'search', true, false),
      resource('tool', 'lab-issues.create', 'create', true, false),
      resource('tool', 'lab-docs.lookup', 'lookup', true, false),
    ],
    warnings: ['MCP server lab-figma-mock is disabled; its tools are not listed.'],
  },
  hermes: {
    items: [],
    warnings: ['Hermes tool inventory is unavailable.'],
  },
  // Claude Code slash commands and skills; they come from the user's own
  // configuration and cannot be switched per session.
  'claude-code': {
    items: [
      resource('skill', 'review', 'review', true, false),
      resource('skill', 'lab-release-notes', 'lab-release-notes', true, false),
      resource('skill', 'security-review', 'security-review', true, false),
    ],
    warnings: [],
  },
};

/** Native adapters that implement each permission preset (see the bridge factories). */
export const NATIVE_PERMISSION_MODES: Readonly<Record<HarnessKind, readonly PermissionMode[]>> = {
  pi: ['native', 'read-only', 'full-access'],
  'prime-agent': ['native'],
  codex: ['native', 'read-only', 'workspace-write', 'full-access'],
  hermes: ['native'],
  'claude-code': ['native', 'read-only', 'workspace-write', 'full-access'],
};

/** Claude Code steers natively; compaction is only a literal `/compact` prompt headlessly. */
export function composerCapabilities(kind: HarnessKind): { steer: boolean; compact: boolean } {
  if (kind === 'hermes') return { steer: false, compact: false };
  return kind === 'claude-code' ? { steer: true, compact: false } : { steer: true, compact: true };
}

/** Service tiers are Codex/Prime only; Prime reports one only for Fast-capable models. */
export function reportsServiceTier(kind: HarnessKind, model: WorkspaceModel | undefined): boolean {
  if (kind === 'codex') return true;
  if (kind !== 'prime-agent' || model === undefined) return false;
  return catalogModel(kind, model.id, model.provider)?.supportsFast === true;
}

type BlockKind = DesktopTimelineBlock['kind'];

/** Labels the live bridges put on blocks (Hermes uses the raw ACP kind). */
export function liveLabel(harness: HarnessKind, kind: BlockKind): string {
  const labels: Readonly<Record<HarnessKind, Partial<Record<BlockKind, string>>>> = {
    pi: { user: 'You', assistant: 'Pi', thinking: 'Thinking', compaction: 'Compaction', error: 'Error' },
    'prime-agent': {
      user: 'You', assistant: 'Prime', thinking: 'Thinking', compaction: 'Compaction', custom: 'Prime subagent', error: 'Error',
    },
    codex: { user: 'You', assistant: 'Codex', thinking: 'Reasoning', compaction: 'Compaction', unknown: 'Codex event', error: 'Error' },
    hermes: { user: 'user', assistant: 'assistant', thinking: 'thinking', custom: 'Hermes event', error: 'Error' },
    'claude-code': {
      user: 'You', assistant: 'Claude', thinking: 'Thinking', compaction: 'Compaction', custom: 'Claude Code',
      unknown: 'Claude Code event', error: 'Error',
    },
  };
  return labels[harness][kind] ?? kind;
}

/** `history_block_label`: closed sessions are re-projected with generic labels. */
export function historyLabel(kind: BlockKind): string {
  switch (kind) {
    case 'user': return 'You';
    case 'assistant': return 'Assistant';
    case 'thinking': return 'Reasoning';
    case 'tool': return 'Tool activity';
    case 'custom': return 'Extension message';
    case 'error': return 'Error';
    case 'compaction': return 'Context compacted';
    case 'unknown': return 'Unrecognized history entry';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function defaultSessionTitle(kind: HarnessKind): string {
  return `New ${HARNESS_NAMES[kind]} session`;
}
