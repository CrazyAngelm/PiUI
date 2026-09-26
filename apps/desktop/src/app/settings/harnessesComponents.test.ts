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

describe('Settings → Harnesses components', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders every harness with status, location, tested versions and sign-in guidance', async () => {
    const { body } = render(HarnessesSettings, { props: { store: storeWith(await registryOf('demo')) } });
    expect(body).toContain('aria-label="Built-in harnesses"');
    for (const name of ['Pi', 'Prime Agent', 'Codex', 'Hermes', 'Claude Code', 'Gemini CLI', 'Qwen Code', 'Lab Agent']) expect(body).toContain(`>${name}</strong>`);
    expect(body).toContain('0.147.0 – 0.157.x');
    expect(body).toContain('C:/Users/example/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js');
    expect(body).toContain('Claude Code runs only on your Claude subscription: run `claude` in a terminal and use /login.');
    // ACP agents: the exact command line, the identity, readiness and the next decision.
    expect(body).toContain('acp:gemini-cli');
    expect(body).toContain('"C:/Program Files/nodejs/node.exe" C:/Users/example/AppData/Roaming/npm/node_modules/@google/gemini-cli/dist/index.js --experimental-acp');
    expect(body).toContain('Ships with PiUI');
    expect(body).toContain('Added by you');
    expect(body).toContain("The agent's program was not found on PATH.");
    expect(body).toContain('Needs review');
    expect(body).toContain('Review and trust…');
    expect(body).toContain('Secrets not passed: GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS');
    expect(body).toContain('0.39.1, not verified by PiUI; you confirmed this version');
    expect(body).toContain('Add ACP agent…');
    // Per-agent buttons keep their visible name and are described by the agent title.
    expect(body).toMatch(/<strong id="([^"]+)-title">Lab Agent<\/strong>[\s\S]*aria-describedby="\1-title"/);
    expect(body).not.toContain('Safe mode:');
  });

  it('announces loading and a registry failure without blocking the rest of Settings', () => {
    const store = new HarnessesStore(createHarnessRegistryClient(vi.fn() as never, vi.fn() as never));
    store.loading = true;
    expect(render(HarnessesSettings, { props: { store } }).body).toMatch(/role="status"[^>]*><span class="visually-hidden[^"]*">Loading harnesses…<\/span>/);
    store.loading = false;
    store.error = 'PiUI could not read the harness list.';
    const { body } = render(HarnessesSettings, { props: { store } });
    expect(body).toMatch(/role="alert"[^>]*>PiUI could not read the harness list\.<\/p>/);
    expect(body).not.toContain('ACP agents');
  });

  it('shows safe mode as a notice with every change disabled and nothing reported as checking', async () => {
    const { body } = render(HarnessesSettings, { props: { store: storeWith(await registryOf('safe')) } });
    expect(body).toContain('Safe mode: PiUI starts no agent program, so harness checks and changes are off.');
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
