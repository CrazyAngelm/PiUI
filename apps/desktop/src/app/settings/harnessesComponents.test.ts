import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpAgentEntryV1, HarnessRegistryV1 } from '../../../../../contracts/harness-registry-v1';
import { createHarnessRegistryClient } from '../../host-api/harnessRegistry';
import { labHost } from '../../host-api/lab/labTestKit';
import AgentModePicker from '../shell/AgentModePicker.svelte';
import AcpDescriptorEditor from './AcpDescriptorEditor.svelte';
import AcpSecretChoices from './AcpSecretChoices.svelte';
import AcpTrustReview from './AcpTrustReview.svelte';
import HarnessesSettings from './HarnessesSettings.svelte';
import { emptyDescriptorForm } from './acpAgents';
import { HarnessesStore } from './harnessesStore.svelte';

async function registryOf(scenario: 'demo' | 'safe'): Promise<HarnessRegistryV1> {
  const pending = labHost(scenario).invoke<HarnessRegistryV1>('harness_registry_v1', { command: { type: 'list' } });
  await vi.runAllTimersAsync();
  return pending;
}

function storeWith(registry: HarnessRegistryV1): HarnessesStore {
  const store = new HarnessesStore(createHarnessRegistryClient(vi.fn() as never, vi.fn() as never));
  store.registry = registry;
  return store;
}

function agentOf(registry: HarnessRegistryV1, id: string): AcpAgentEntryV1 {
  const agent = registry.agents.find((entry) => entry.descriptor.id === id);
  if (agent === undefined) throw new Error(`No agent ${id}.`);
  return agent;
}

const noop = () => undefined;
/** The visible text of a Connect button (Svelte may add empty comment markers around snippet text). */
const CONNECT_LABEL = /Connect(?:<!---->)*<\/span>/;

describe('Settings → Harnesses components', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders every harness as a calm row with its status, and location and tested versions under Details', async () => {
    const { body } = render(HarnessesSettings, { props: { store: storeWith(await registryOf('demo')) } });
    expect(body).toContain('aria-label="Built-in harnesses"');
    for (const name of ['Pi', 'Prime Agent', 'Codex', 'Hermes', 'Claude Code', 'Gemini CLI', 'OpenCode', 'Qwen Code', 'Lab Agent']) expect(body).toContain(`>${name}</strong>`);
    expect(body).toContain('0.147.0 and newer');
    expect(body).toContain('C:/Users/example/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js');
    // Location and the tested range sit inside a native <details>; the sign-in guidance moved into the Connect dialog.
    expect(body).toMatch(/<details[^>]*>(?:(?!<\/details>)[\s\S])*Location<\/dt>(?:(?!<\/details>)[\s\S])*codex\.js(?:(?!<\/details>)[\s\S])*Tested with Nano Desktop/);
    expect(body).not.toContain('Claude Code runs only on your Claude subscription');
    // ACP agents: the exact command line, the identity, readiness and the next decision.
    expect(body).toContain('acp:gemini-cli');
    expect(body).toContain('"C:/Program Files/nodejs/node.exe" C:/Users/example/AppData/Roaming/npm/node_modules/@google/gemini-cli/dist/index.js --acp');
    expect(body).toContain('Ships with Nano Desktop');
    expect(body).toContain('Added by you');
    expect(body).toContain("The agent's program was not found on PATH.");
    expect(body).toContain('Needs review');
    expect(body).toContain('Review and trust…');
    expect(body).toContain('Secrets not passed: GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS');
    // Untested and newer versions are notices, not decisions: no confirmation is offered anywhere.
    expect(body).toContain('0.39.1, not verified by Nano Desktop');
    expect(body).toContain('1.19.4, not verified by Nano Desktop');
    expect(body).not.toContain('you confirmed this version');
    expect(body).not.toContain('Confirm version…');
    expect(body).toContain('Add ACP agent…');
    // Per-agent buttons keep their visible name and are described by the agent title.
    expect(body).toMatch(/<strong id="([^"]+)-title"[^>]*>Lab Agent<\/strong>[\s\S]*aria-describedby="\1-title"/);
    expect(body).not.toContain('Safe mode:');
    // No lead paragraphs and no bottom credential note: the sentence lives in the Connect dialog.
    expect(body).not.toContain('Nano Desktop drives the agent tools');
    expect(body).not.toContain('Agents that speak the Agent Client Protocol');
    expect(body).not.toContain('Nano Desktop never reads harness credentials');
    expect(body).toMatch(/<h2[^>]*>Harnesses<\/h2>/);
  });

  /** Start tags of the buttons whose accessible name is "Connect". */
  function connectButtons(body: string): string[] {
    return [...body.matchAll(/<button\b([^>]*)>(?:(?!<\/button>)[\s\S])*?Connect(?:<!---->)*<\/span>/g)].map((match) => match[1] ?? '');
  }

  it('offers Connect on every installed harness and agent that can sign in, and on nothing else', async () => {
    const registry = await registryOf('demo');
    // Six built-in harnesses and the two shipped agents; the missing and the untrusted agent have nothing to connect.
    expect(connectButtons(render(HarnessesSettings, { props: { store: storeWith(registry) } }).body)).toHaveLength(8);
    const missing: HarnessRegistryV1 = {
      ...registry,
      harnesses: registry.harnesses.map((harness) => (harness.harness === 'hermes' ? { ...harness, state: 'not-installed' as const } : harness)),
    };
    expect(connectButtons(render(HarnessesSettings, { props: { store: storeWith(missing) } }).body)).toHaveLength(7);
  });

  it('makes Connect the main action only for a harness that needs a sign-in', async () => {
    const registry = await registryOf('demo');
    const signedOut: HarnessRegistryV1 = {
      ...registry,
      harnesses: registry.harnesses.map((harness) => (harness.harness === 'claude-code' ? { ...harness, state: 'sign-in-required' as const } : harness)),
    };
    const buttons = connectButtons(render(HarnessesSettings, { props: { store: storeWith(signedOut) } }).body);
    const primary = buttons.filter((attributes) => attributes.includes('btn--primary'));
    expect(primary).toHaveLength(1);
    expect(primary[0]).toMatch(/aria-describedby="[^"]*-claude-code"/);
    expect(buttons.filter((attributes) => attributes.includes('btn--secondary'))).toHaveLength(7);
  });

  it('disables Connect in safe mode', async () => {
    const { body } = render(HarnessesSettings, { props: { store: storeWith(await registryOf('safe')) } });
    const buttons = connectButtons(body);
    expect(buttons.length).toBeGreaterThan(0);
    for (const attributes of buttons) expect(attributes).toContain('disabled');
  });

  it('keeps an agent row to its status and next decision, with identity and removal under Details', async () => {
    const { body } = render(HarnessesSettings, { props: { store: storeWith(await registryOf('demo')) } });
    // Signing in moved into the Connect dialog: no row carries sign-in text.
    expect(body).not.toContain('The agent offers:');
    const lab = body.slice(body.indexOf('>Lab Agent</strong>'));
    const labRow = lab.slice(0, lab.indexOf('</li>'));
    expect(labRow).toContain('Review and trust…');
    expect(labRow).not.toMatch(CONNECT_LABEL);
    // An agent that is not trusted yet has no secret grants to review.
    expect(labRow).not.toContain('Secret variables…');
    expect(labRow).toMatch(/<details[^>]*>[\s\S]*Identity[\s\S]*acp:lab-agent[\s\S]*Remove…/);
    const gemini = body.slice(body.indexOf('>Gemini CLI</strong>'));
    const geminiRow = gemini.slice(0, gemini.indexOf('</li>'));
    expect(geminiRow).toMatch(CONNECT_LABEL);
    expect(geminiRow).not.toContain('Remove…');
    expect(geminiRow).toContain('Check again');
    // Secret variables are reviewed under Details, never on the row line.
    expect(geminiRow).toMatch(/<details[^>]*>[\s\S]*Secret variables…/);
    expect(geminiRow.slice(0, geminiRow.indexOf('<details'))).not.toContain('Secret variables…');
  });

  it('keeps Secret variables… under Details for a shipped agent that is not installed', async () => {
    const registry = await registryOf('demo');
    const removed: HarnessRegistryV1 = {
      ...registry,
      agents: registry.agents.map((agent) => (agent.descriptor.id === 'gemini-cli' ? { ...agent, state: 'not-installed' as const } : agent)),
    };
    const { body } = render(HarnessesSettings, { props: { store: storeWith(removed) } });
    const gemini = body.slice(body.indexOf('>Gemini CLI</strong>'));
    const geminiRow = gemini.slice(0, gemini.indexOf('</li>'));
    expect(geminiRow).not.toMatch(CONNECT_LABEL);
    expect(geminiRow).toMatch(/<details[^>]*>[\s\S]*Secret variables…/);
  });

  it('marks versions Nano Desktop has not tested next to the readiness, never instead of it', async () => {
    const registry = await registryOf('demo');
    const { body } = render(HarnessesSettings, { props: { store: storeWith(registry) } });
    // Codex (native, newer) and the shipped agents without a tested range are ready and launchable.
    expect(body.match(/Newer than tested/g)).toHaveLength(1);
    expect(body.match(/Untested version/g)).toHaveLength(2);
    expect(registry.harnesses.find((harness) => harness.harness === 'codex')).toMatchObject({ state: 'ready', versionStatus: 'newer' });
    const newer: HarnessRegistryV1 = {
      ...registry,
      agents: registry.agents.map((agent) => (agent.descriptor.id === 'gemini-cli' ? { ...agent, version: '0.40.0', versionStatus: 'newer' as const } : agent)),
    };
    const agentNewer = render(HarnessesSettings, { props: { store: storeWith(newer) } }).body;
    expect(agentNewer.match(/Newer than tested/g)).toHaveLength(2);
    expect(agentNewer).toContain('0.40.0, newer than the versions tested with Nano Desktop');
    const unknown: HarnessRegistryV1 = {
      ...registry,
      agents: registry.agents.map((agent) => (agent.descriptor.id === 'gemini-cli' ? { ...agent, versionStatus: 'unrecognized' as const } : agent)),
    };
    const shown = render(HarnessesSettings, { props: { store: storeWith(unknown) } }).body;
    expect(shown).toContain('Version unknown');
    expect(shown).toContain('The version output was not recognized');
    expect(shown).not.toContain('Confirm version…');
    // An older version is the "Unsupported version" state, without a second notice.
    const older: HarnessRegistryV1 = {
      ...registry,
      agents: registry.agents.map((agent) => (agent.descriptor.id === 'gemini-cli' ? { ...agent, state: 'unsupported-version' as const, versionStatus: 'older' as const } : agent)),
    };
    const refused = render(HarnessesSettings, { props: { store: storeWith(older) } }).body;
    expect(refused).toContain('Unsupported version');
    expect(refused.match(/Newer than tested/g)).toHaveLength(1);
  });

  it('announces loading and a registry failure without blocking the rest of Settings', () => {
    const store = new HarnessesStore(createHarnessRegistryClient(vi.fn() as never, vi.fn() as never));
    store.loading = true;
    expect(render(HarnessesSettings, { props: { store } }).body).toMatch(/role="status"[^>]*><span class="visually-hidden[^"]*">Loading harnesses…<\/span>/);
    store.loading = false;
    store.error = 'Nano Desktop could not read the harness list.';
    const { body } = render(HarnessesSettings, { props: { store } });
    expect(body).toMatch(/role="alert"[^>]*>Nano Desktop could not read the harness list\.<\/p>/);
    expect(body).not.toContain('ACP agents');
  });

  it('shows safe mode as a notice with every change disabled and nothing reported as checking', async () => {
    const { body } = render(HarnessesSettings, { props: { store: storeWith(await registryOf('safe')) } });
    expect(body).toContain('Safe mode: Nano Desktop starts no agent program, so harness checks and changes are off.');
    expect(body).toContain('Not checked');
    expect(body).not.toContain('Checking this agent…');
    expect(body).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Add ACP agent…/);
  });

  it('reviews the exact command line and environment names in the trust dialog', async () => {
    const lab = agentOf(await registryOf('demo'), 'lab-agent');
    const { body } = render(AcpTrustReview, { props: { agent: lab, error: undefined, onReview: noop } });
    expect(body).toContain('Command line');
    expect(body).toContain('C:/Users/example/.local/bin/lab-agent.exe');
    // Each argument separately, exactly as PiUI passes it.
    expect(body).toMatch(/<li><code[^>]*>--acp<\/code><\/li>/);
    expect(body).toContain('LAB_AGENT_TOKEN, HTTPS_PROXY');
    expect(body).toContain('Secret-like names (LAB_AGENT_TOKEN) pass only after you allow them separately.');
    expect(body).toContain('Trust is not a sandbox.');
    expect(body).toContain('Trust covers this command line; newer versions start without asking again.');
    expect(body).not.toContain('role="alert"');
    const stale = render(AcpTrustReview, { props: { agent: lab, error: 'The agent or its command line changed since you reviewed it. Review it again.', onReview: noop } }).body;
    expect(stale).toContain('role="alert"');
    expect(stale).toContain('Review the current command');
  });

  it('lists secret-like names with labelled checkboxes and never a value', async () => {
    const gemini = agentOf(await registryOf('demo'), 'gemini-cli');
    const { body } = render(AcpSecretChoices, { props: { names: gemini.secretEnvironment, allowed: ['GOOGLE_API_KEY'] } });
    expect(body).toContain('Pass to the agent</legend>');
    for (const name of gemini.secretEnvironment) expect(body).toMatch(new RegExp(`<label[^>]*>[\\s\\S]*?${name}`));
    expect(body).toMatch(/data-state="checked"[\s\S]*?GOOGLE_API_KEY/);
    expect(body).not.toContain('HTTPS_PROXY');
  });

  it('labels every field of the add form', () => {
    const { body } = render(AcpDescriptorEditor, { props: { mode: 'form', form: emptyDescriptorForm(), json: '', onModeChange: noop } });
    for (const label of ['Agent ID', 'Name', 'Program', 'Arguments', 'Version arguments', 'Version pattern', 'Environment variables', 'Sign-in hint', 'Documentation link']) {
      expect(body, label).toMatch(new RegExp(`<label for="[^"]+"[^>]*>\\s*${label}`));
    }
    expect(body).toContain('aria-label="Descriptor input"');
    expect(body).toContain('Switch off agent features');
    const json = render(AcpDescriptorEditor, { props: { mode: 'json', form: emptyDescriptorForm(), json: '{}', onModeChange: noop } }).body;
    expect(json).toMatch(/<label for="[^"]+"[^>]*>\s*Descriptor JSON/);
    expect(json).not.toContain('Agent ID');
  });

  it('offers agent-advertised modes as a labelled native select', () => {
    const modes = { current: 'plan', available: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan', description: 'Read-only planning' }] };
    const { body } = render(AgentModePicker, { props: { sessionId: 'session', modes, disabled: false, onChanged: async () => undefined } });
    expect(body).toContain('aria-label="Agent mode"');
    expect(body).toMatch(/<option value="plan"[^>]*selected/);
    expect(body).toContain('Read-only planning');
    const unknown = render(AgentModePicker, { props: { sessionId: 'session', modes: { ...modes, current: 'gone' }, disabled: true, onChanged: async () => undefined } }).body;
    expect(unknown).toContain('Unknown mode');
    expect(unknown).toMatch(/<select[^>]*disabled/);
  });
});
