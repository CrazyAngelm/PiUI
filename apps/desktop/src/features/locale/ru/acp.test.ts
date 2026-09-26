import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HarnessState } from '../../../../../../contracts/harness-registry-v1';
import { ACP_DESCRIPTOR_PROBLEMS } from '../../../host-api/acpDescriptor';
import { workspaceError } from '../../../host-api/workspaceClient';
import { stateBadge, versionNote } from '../../../app/settings/acpAgents';
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
    const labels = [...states.map((state) => stateBadge(state, false).label), stateBadge('checking', true).label];
    const base = { descriptor: { schemaVersion: 1 as const, id: 'a', displayName: 'A', command: { program: 'a' }, version: { args: ['-v'] } }, source: 'user' as const, fingerprint: 'f', state: 'ready' as const, trusted: true, secretEnvironment: [], allowedSecrets: [], authMethods: [] };
    const notes = (['verified', 'no-verified-range', 'newer', 'older', 'unrecognized', 'probe-failed'] as const)
      .flatMap((versionStatus) => [versionNote({ ...base, version: '1.0.0', versionStatus }), versionNote({ ...base, version: '1.0.0', confirmedVersion: '1.0.0', versionStatus })])
      .map((note) => note?.[0] ?? '');
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
      'PiUI has not verified this version. Confirm it in Settings → Harnesses to use it.',
      "Sign in with the agent's own app, then try again. Settings → Harnesses shows how.",
      'This agent is no longer registered in Settings → Harnesses.',
      'Claude Code runs only on your Claude subscription: run `claude` in a terminal and use /login.',
      "Sign in with Codex's own flow: run `codex login` in a terminal.",
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
