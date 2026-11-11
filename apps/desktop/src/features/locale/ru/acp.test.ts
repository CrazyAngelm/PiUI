import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HarnessState } from '../../../../../../contracts/harness-registry-v1';
import { ACP_DESCRIPTOR_PROBLEMS } from '../../../host-api/acpDescriptor';
import { workspaceError } from '../../../host-api/workspaceClient';
import { stateBadge, versionBadge, versionNote } from '../../../app/settings/acpAgents';
import { translate } from '../language';
import { acpRu } from './acp';

/** Every `$t('…')` literal in the ACP settings screens and the mode picker. */
function sourceKeys(): string[] {
  const settings = new URL('../../../app/settings/', import.meta.url);
  const files = [
    ...readdirSync(settings).filter((name) => name.endsWith('.svelte')).map((name) => new URL(name, settings)),
    new URL('../../../app/shell/AgentModePicker.svelte', import.meta.url),
  ];
  const keys = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\$t\('((?:[^'\\]|\\.)+)'/g)) keys.add(match[1] ?? '');
  }
  return [...keys];
}

const translated = (key: string): boolean => translate(key, 'ru') !== key || acpRu[key] === key;

describe('Russian copy for ACP agents and Settings → Harnesses', () => {
  it('translates every visible string of the new screens', () => {
    const keys = sourceKeys();
    expect(keys.length).toBeGreaterThan(60);
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates readiness, version notes, descriptor problems and start refusals', () => {
    const states: HarnessState[] = ['ready', 'checking', 'not-installed', 'unsupported-version', 'unverified-version', 'sign-in-required', 'untrusted', 'unavailable'];
    const advisory = (['newer', 'no-verified-range', 'unrecognized', 'probe-failed'] as const).map((status) => versionBadge(status)?.label ?? '');
    const labels = [...states.map((state) => stateBadge(state, false).label), stateBadge('checking', true).label, ...advisory];
    const base = { descriptor: { schemaVersion: 1 as const, id: 'a', displayName: 'A', command: { program: 'a' }, version: { args: ['-v'] } }, source: 'user' as const, fingerprint: 'f', state: 'ready' as const, trusted: true, secretEnvironment: [], allowedSecrets: [], authMethods: [] };
    const notes = (['verified', 'no-verified-range', 'newer', 'older', 'unrecognized', 'probe-failed'] as const)
      .map((versionStatus) => versionNote({ ...base, version: '1.0.0', versionStatus })?.[0] ?? '');
    const refusals = ['ACP_TRUST_REQUIRED', 'ACP_VERSION_UNCONFIRMED', 'ACP_SIGN_IN_REQUIRED'].map((code) => workspaceError({ code, message: 'native text' }).message);
    for (const key of [...labels, ...notes, ...Object.values(ACP_DESCRIPTOR_PROBLEMS), ...refusals]) {
      expect(translated(key), key).toBe(true);
    }
    expect(translate('The agent offers: {0}.', 'ru')).toContain('{0}');
  });

  it('translates the host readiness reasons, sign-in hints and registry errors', () => {
    // Fixed English texts of `acp_agents.rs` and `harness_registry_api.rs`.
    const hostTexts = [
      'Checking this agent…',
      "The agent's program was not found on PATH.",
      "The agent's program path does not exist.",
      'This launcher needs a shell, which PiUI never uses. Point the descriptor at the executable or the Node script.',
      'Node.js is needed to start this agent but was not found.',
      "Review and trust this agent's command line in Settings → Harnesses.",
      'The installed version is older than the versions tested with PiUI.',
      'The agent did not report a version PiUI can recognize.',
      'The installed harness speaks a protocol this PiUI version does not support. Update PiUI or the harness.',
      // Native harness discovery reasons (`version_refusal_reason`, `probe_native_harnesses`).
      'Older than the oldest version supported by PiUI.',
      'The installed version could not be recognized.',
      'Claude Code could not be verified with `claude --version`.',
      'The installed native harness version is not supported by this adapter.',
      'Native lifecycle containment is not yet verified on this platform.',
      "Sign in with the agent's own app, then try again. Settings → Harnesses shows how.",
      'This agent is no longer registered in Settings → Harnesses.',
      'Claude Code runs only on your Claude subscription: run `claude` in a terminal and use /login.',
      "Sign in with Codex's own flow: run `codex login` in a terminal.",
      // Authentication hints of the built-in descriptors (`builtin_acp_descriptors`).
      "Sign in with Gemini CLI's own flow: run `gemini` in a terminal and choose a sign-in method. To use an API key instead, allow PiUI to pass GEMINI_API_KEY below.",
      "Sign in with OpenCode's own flow: run `opencode auth login` in a terminal. To use a provider API key instead, allow PiUI to pass it below.",
      "Sign in with Qwen Code's own flow: run `qwen` in a terminal and use /auth. To use an API key instead, allow PiUI to pass DASHSCOPE_API_KEY or OPENAI_API_KEY below.",
      "Sign in with Copilot's own flow: run `copilot` in a terminal and use /login. To use a token instead, allow PiUI to pass COPILOT_GITHUB_TOKEN below.",
      "Set up Goose's own provider: run `goose configure` in a terminal and choose a provider and model.",
      "Sign in with Kimi Code's own flow: run `kimi` in a terminal and use /login.",
      "Sign in with Cursor's own flow: run `cursor-agent login` in a terminal. To use an API key instead, allow PiUI to pass CURSOR_API_KEY below.",
      'Harness checks and changes are disabled in safe mode.',
      'The harness list changed. Review it and try again.',
      'An agent with this ID already exists.',
      'This agent is no longer registered.',
      'Agents that ship with PiUI cannot be removed or re-trusted.',
      'The agent or its command line changed since you reviewed it. Review it again.',
      'The program was not found, so there is nothing to trust yet.',
      'There is nothing to confirm for this agent right now. Check it again.',
      'Remove an agent before adding another (32 at most).',
      'PiUI could not save the harness list.',
      'PiUI could not read the harness list.',
    ];
    expect(hostTexts.filter((key) => !translated(key))).toEqual([]);
  });
});
