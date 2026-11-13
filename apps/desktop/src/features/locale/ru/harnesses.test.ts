import { expect, it } from 'vitest';
import { SIGNED_OUT_COPY } from '../../../app/chat/claudeSignIn.svelte';
import { harnessConfigurations } from '../../../harness-adapters';
import { profileConfigurationErrors } from '../../../harness-adapters/validation';
import { failureText } from '../../../app/runs/runGraph';
import { APPROVAL_FIELD_ISSUES } from '../../../host-api/approvalForms';
import { HARNESS_CONNECT_ERRORS } from '../../../host-api/harnessConnect';
import { translate } from '../language';

it('translates the node inspector limitations of every harness', () => {
  expect(translate('Limitations of {0}', 'ru')).not.toBe('Limitations of {0}');
  for (const configuration of Object.values(harnessConfigurations)) {
    for (const limitation of configuration.limitations ?? []) {
      expect(translate(limitation, 'ru'), limitation).not.toBe(limitation);
    }
  }
});

it('translates the composer sign-in status and keeps both command placeholders', () => {
  for (const message of [
    SIGNED_OUT_COPY,
    'Checking the Claude Code sign-in…',
    'Could not check the Claude Code sign-in.',
    'Claude Code is signed in with your Claude subscription.',
    'Check again',
  ]) {
    expect(translate(message, 'ru'), message).not.toBe(message);
  }
  expect(translate(SIGNED_OUT_COPY, 'ru')).toMatch(/\{0\}[\s\S]*\{1\}/);
});

it('explains a refused Claude Code sign-in in the run panel, in both languages', () => {
  const text = failureText('harness-sign-in-required');
  expect(text).toContain('/login');
  expect(text).toContain('run this step again');
  expect(translate(text, 'ru')).not.toBe(text);
});

it('translates the MCP form request copy, including every field problem', () => {
  for (const message of [
    ...Object.values(APPROVAL_FIELD_ISSUES),
    'MCP server {0}',
    'Requested values',
    'Accept',
    'Decline',
    'No answer',
    '{0} or more.',
    '{0} or less.',
    'This request needs a value Nano Desktop cannot show, so it can only be declined.',
    'Some optional values cannot be entered here and are left empty.',
  ]) {
    expect(translate(message, 'ru'), message).not.toBe(message);
  }
});

it('translates every static Nano profile problem the editor can show', () => {
  // Each message the validator builds for a Nano profile, with the node's "<id>: " prefix the editor strips.
  const problems = profileConfigurationErrors('node', {
    name: 'Nano',
    harness: 'nano',
    modelProvider: 'anthropic',
    model: 'not-a-mode',
    permissionMode: 'workspace-write',
    instructions: '',
    reasoning: 'high',
    toolPolicy: { rules: [{ tool: 'shell', decision: 'allow', enforcement: 'native', mandatory: false }] },
  }).map((message) => message.replace(/^node: /, ''));
  expect(problems).toHaveLength(5);
  for (const message of problems) expect(translate(message, 'ru'), message).not.toBe(message);
});

it('translates the Connect dialog and every terminal failure, keeping the placeholders', () => {
  for (const message of [
    'Connect',
    'Connect {0}',
    '{0} signs in with its own tools. Nano Desktop never sees its credentials.',
    'Open terminal',
    'Copy command',
    'Then type {0} there.',
    'Finish signing in in the terminal, then check again.',
    'Sign in with {0}’s own tools in a terminal, then check again.',
    'Safe mode is on: Nano Desktop starts no agent program.',
    'Open Nano account',
    'Done',
    ...Object.values(HARNESS_CONNECT_ERRORS),
  ]) {
    expect(translate(message, 'ru'), message).not.toBe(message);
  }
  for (const message of ['Connect {0}', '{0} signs in with its own tools. Nano Desktop never sees its credentials.', 'Then type {0} there.', 'Sign in with {0}’s own tools in a terminal, then check again.']) {
    expect(translate(message, 'ru'), message).toContain('{0}');
  }
  expect(translate('Connect', 'ru')).toBe('Подключить');
});
