import { expect, it } from 'vitest';
import { SIGNED_OUT_COPY } from '../../../app/chat/claudeSignIn.svelte';
import { failureText } from '../../../app/runs/runGraph';
import { APPROVAL_FIELD_ISSUES } from '../../../host-api/approvalForms';
import { translate } from '../language';

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
    'This request needs a value PiUI cannot show, so it can only be declined.',
    'Some optional values cannot be entered here and are left empty.',
  ]) {
    expect(translate(message, 'ru'), message).not.toBe(message);
  }
});
