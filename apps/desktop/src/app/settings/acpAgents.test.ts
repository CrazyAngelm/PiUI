import { describe, expect, it } from 'vitest';
import type { AcpAgentEntryV1, HarnessState } from '../../../../../contracts/harness-registry-v1';
import { harnessRegistryFixture } from '../../../../../contracts/fixtures/harness-registry-v1';
import {
  canChooseSecrets, canConfirmVersion, canRemove, canTrust, commandLineText, descriptorFromForm, draftDescriptor,
  emptyDescriptorForm, environmentGroups, formFromDescriptor, formFromJson, formJson, stateBadge, versionNote,
} from './acpAgents';

const gemini = harnessRegistryFixture.agents[0] as AcpAgentEntryV1;
const user: AcpAgentEntryV1 = {
  ...gemini,
  source: 'user',
  state: 'untrusted',
  trusted: false,
  descriptor: { ...gemini.descriptor, id: 'lab-agent', displayName: 'Lab Agent', environment: ['LAB_TOKEN', 'HTTPS_PROXY'] },
  commandLine: { program: 'C:/Program Files/lab/agent.exe', args: ['--acp', 'two words', ''] },
  secretEnvironment: ['LAB_TOKEN'],
};

describe('Settings → Harnesses presentation', () => {
  it('names every readiness state, with "not checked" in safe mode', () => {
    const states: HarnessState[] = ['ready', 'checking', 'not-installed', 'unsupported-version', 'unverified-version', 'sign-in-required', 'untrusted', 'unavailable'];
    expect(states.map((state) => stateBadge(state, false).label)).toEqual([
      'Ready', 'Checking…', 'Not installed', 'Unsupported version', 'Unverified version', 'Sign-in required', 'Needs review', 'Unavailable',
    ]);
    expect(stateBadge('ready', false).tone).toBe('success');
    expect(stateBadge('unavailable', false).tone).toBe('danger');
    expect(stateBadge('checking', true)).toEqual({ label: 'Not checked', tone: 'neutral' });
  });

  it('shows the exact command line, quoting only for display', () => {
    expect(commandLineText({ program: 'C:/Program Files/lab/agent.exe', args: ['--acp', 'two words', '', 'say "hi"'] }))
      .toBe('"C:/Program Files/lab/agent.exe" --acp "two words" "" "say \\"hi\\""');
    expect(commandLineText({ program: 'gemini', args: [] })).toBe('gemini');
  });

  it('explains the version against the tested range and the confirmation', () => {
    expect(versionNote({ ...gemini, version: '1.2.3', versionStatus: 'verified' })).toEqual(['{0}, tested with PiUI', ['1.2.3']]);
    expect(versionNote({ ...gemini, version: '0.39.1', versionStatus: 'no-verified-range' })?.[0]).toBe('{0}, not verified by PiUI');
    expect(versionNote({ ...gemini, version: '0.39.1', versionStatus: 'no-verified-range', confirmedVersion: '0.39.1' })?.[0])
      .toBe('{0}, not verified by PiUI; you confirmed this version');
    expect(versionNote({ ...gemini, version: '3.0.0', versionStatus: 'newer', confirmedVersion: '2.9.0' })?.[0]).toBe('{0}, newer than the versions tested with PiUI');
    expect(versionNote({ ...gemini, version: '0.1.0', versionStatus: 'older' })?.[0]).toBe('{0}, older than the versions tested with PiUI');
    expect(versionNote({ ...gemini, versionStatus: 'probe-failed' })).toEqual(['The version check did not finish', []]);
    expect(versionNote({ ...gemini, versionStatus: 'unrecognized' })?.[0]).toBe('The version output was not recognized');
    expect(versionNote(gemini)).toBeUndefined();
  });

  it('offers only the decisions the host accepts', () => {
    expect([canTrust(user), canRemove(user), canConfirmVersion(user), canChooseSecrets(user)]).toEqual([true, true, false, false]);
    expect(canTrust({ ...user, commandLine: undefined })).toBe(false);
    // Shipped agents are trusted by PiUI and cannot be removed.
    expect([canTrust(gemini), canRemove(gemini), canChooseSecrets(gemini)]).toEqual([false, false, true]);
    expect(canConfirmVersion({ ...gemini, state: 'unverified-version', version: '0.39.1' })).toBe(true);
    expect(environmentGroups({ ...gemini, allowedSecrets: ['GOOGLE_API_KEY'] })).toEqual({
      plain: ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'],
      allowed: ['GOOGLE_API_KEY'],
      withheld: ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
    });
  });
});

describe('Add ACP agent form', () => {
  it('builds the descriptor the host validates and round-trips it', () => {
    const form = {
      ...emptyDescriptorForm(), id: 'qwen-code', displayName: ' Qwen Code ', program: 'qwen', args: '--experimental-acp\n\n',
      versionPattern: 'qwen v?(\\d+\\.\\d+\\.\\d+)', verifiedMinimum: '0.1.0', verifiedCeiling: '0.2.0',
      environment: 'DASHSCOPE_API_KEY, HTTPS_PROXY', authHint: 'Run `qwen` and sign in.', noLoadSession: true, noMcpHttp: true,
    };
    const descriptor = descriptorFromForm(form);
    expect(descriptor).toEqual({
      schemaVersion: 1, id: 'qwen-code', displayName: 'Qwen Code',
      command: { program: 'qwen', args: ['--experimental-acp'] },
      version: { args: ['--version'], pattern: 'qwen v?(\\d+\\.\\d+\\.\\d+)', verified: { minimum: '0.1.0', ceiling: '0.2.0' } },
      environment: ['DASHSCOPE_API_KEY', 'HTTPS_PROXY'], authHint: 'Run `qwen` and sign in.',
      capabilities: { loadSession: false, mcpHttp: false },
    });
    const draft = draftDescriptor('form', form, '');
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(formFromDescriptor(draft.descriptor)).toMatchObject({ id: 'qwen-code', args: '--experimental-acp', noLoadSession: true, noModels: false });
    const fromJson = formFromJson(formJson(form));
    expect('form' in fromJson && fromJson.form.environment).toBe('DASHSCOPE_API_KEY\nHTTPS_PROXY');
  });

  it('keeps problems local and never rewrites JSON it cannot show', () => {
    expect(draftDescriptor('form', { ...emptyDescriptorForm(), id: 'Bad_Id', displayName: 'x', program: 'x' }, ''))
      .toMatchObject({ ok: false, message: 'The ID must be 1-32 lowercase letters, digits and single inner hyphens.' });
    expect(draftDescriptor('form', { ...emptyDescriptorForm(), id: 'lab', displayName: 'Lab', program: 'lab --acp' }, ''))
      .toMatchObject({ ok: false, problem: 'program' });
    expect(draftDescriptor('form', { ...emptyDescriptorForm(), id: 'lab', displayName: 'Lab', program: 'lab', verifiedMinimum: '1.0.0' }, ''))
      .toMatchObject({ ok: false, problem: 'verified-range' });
    expect(draftDescriptor('json', emptyDescriptorForm(), '{"schemaVersion":1,"id":"lab","env":{}}')).toMatchObject({ ok: false, problem: 'malformed' });
    // A leading space in an argument is valid but the line-based form cannot keep it.
    const exact = '{"schemaVersion":1,"id":"lab","displayName":"Lab","command":{"program":"lab","args":[" --acp"]},"version":{"args":["--version"]}}';
    expect(draftDescriptor('json', emptyDescriptorForm(), exact).ok).toBe(true);
    expect(formFromJson(exact)).toEqual({ error: 'This descriptor has values the form cannot show. Keep editing it as JSON.' });
    expect(formFromJson('{')).toEqual({ error: 'The descriptor is not valid JSON or contains unknown fields.' });
  });
});
