import { describe, expect, it } from 'vitest';
import type { WorkspaceApprovalForm } from '../../../../contracts/workspace-v15';
import {
  APPROVAL_FIELD_ISSUES,
  answerMatchesForm,
  encodeFormAnswer,
  formIssues,
  initialDraft,
  valueIssue,
} from './approvalForms';

const form: WorkspaceApprovalForm = {
  server: 'issues',
  fields: [
    { type: 'text', id: 'field-1', label: 'Title', required: true, minLength: 3, maxLength: 10 },
    { type: 'choice', id: 'field-2', label: 'Priority', required: true, default: 'choice-2', options: [{ id: 'choice-1', label: 'Urgent' }, { id: 'choice-2', label: 'Normal' }] },
    { type: 'number', id: 'field-3', label: 'Copies', required: false, integer: true, minimum: 1, maximum: 5 },
    { type: 'boolean', id: 'field-4', label: 'Notify', required: false, default: true },
    { type: 'text', id: 'field-5', label: 'Contact', required: false, format: 'email' },
  ],
};

describe('MCP form drafts', () => {
  it('starts from the native defaults', () => {
    expect(initialDraft(form)).toEqual({ 'field-1': '', 'field-2': 'choice-2', 'field-3': '', 'field-4': true, 'field-5': '' });
  });

  it('reports every value that cannot be sent, by field', () => {
    const draft = { ...initialDraft(form), 'field-1': 'ab', 'field-3': '7', 'field-5': 'nobody' };
    expect(formIssues(form, draft)).toEqual({
      'field-1': { message: APPROVAL_FIELD_ISSUES.tooShort, args: [3] },
      'field-3': { message: APPROVAL_FIELD_ISSUES.maximum, args: [5] },
      'field-5': { message: APPROVAL_FIELD_ISSUES.email },
    });
    expect(formIssues(form, { ...draft, 'field-1': '   ' })['field-1']).toEqual({ message: APPROVAL_FIELD_ISSUES.required });
    expect(formIssues(form, { ...draft, 'field-3': '0x10' })['field-3']).toEqual({ message: APPROVAL_FIELD_ISSUES.number });
    expect(formIssues(form, { ...draft, 'field-3': '1.5' })['field-3']).toEqual({ message: APPROVAL_FIELD_ISSUES.integer });
    expect(formIssues(form, { ...draft, 'field-2': '' })['field-2']).toEqual({ message: APPROVAL_FIELD_ISSUES.required });
  });

  it('counts characters, not UTF-16 units', () => {
    expect(valueIssue(form.fields[0]!, '🙂🙂🙂')).toBeUndefined();
    expect(valueIssue(form.fields[0]!, '🙂'.repeat(11))).toEqual({ message: APPROVAL_FIELD_ISSUES.tooLong, args: [10] });
  });

  it('checks the native text formats', () => {
    const field = (format: 'uri' | 'date' | 'date-time') => ({ type: 'text' as const, id: 'x', label: 'x', required: true, format });
    expect(valueIssue(field('uri'), 'https://example.com/a')).toBeUndefined();
    expect(valueIssue(field('uri'), 'example.com')).toEqual({ message: APPROVAL_FIELD_ISSUES.uri });
    expect(valueIssue(field('date'), '2026-02-28')).toBeUndefined();
    expect(valueIssue(field('date'), '2026-02-30')).toEqual({ message: APPROVAL_FIELD_ISSUES.date });
    expect(valueIssue(field('date-time'), '2026-09-27T10:00:00Z')).toBeUndefined();
    expect(valueIssue(field('date-time'), '2026-09-27T10:00:00')).toEqual({ message: APPROVAL_FIELD_ISSUES.dateTime });
  });

  it('sends answered values only, typed, under their opaque ids', () => {
    const draft = { ...initialDraft(form), 'field-1': 'Broken', 'field-3': ' 2 ' };
    expect(formIssues(form, draft)).toEqual({});
    const text = encodeFormAnswer(form, draft);
    expect(JSON.parse(text ?? '')).toEqual({ 'field-1': 'Broken', 'field-2': 'choice-2', 'field-3': 2, 'field-4': true });
    expect(answerMatchesForm(form, text)).toBe(true);
    expect(encodeFormAnswer({ server: 'tools', fields: [] }, {})).toBeUndefined();
  });

  it('checks an answer like the adapter: known ids, typed values, required fields', () => {
    const answer = (value: Record<string, unknown>) => JSON.stringify(value);
    const valid = { 'field-1': 'Broken', 'field-2': 'choice-1' };
    expect(answerMatchesForm(form, answer(valid))).toBe(true);
    for (const text of [
      undefined,
      'not json',
      '[]',
      answer({ 'field-2': 'choice-1' }),
      answer({ ...valid, 'field-2': 'Urgent' }),
      answer({ ...valid, 'field-3': '2' }),
      answer({ ...valid, 'field-3': 9 }),
      answer({ ...valid, 'field-4': 'yes' }),
      answer({ ...valid, title: 'native name' }),
    ]) {
      expect(answerMatchesForm(form, text), text).toBe(false);
    }
    // A form without fields accepts no values at all.
    expect(answerMatchesForm({ server: 'tools', fields: [] }, undefined)).toBe(true);
    expect(answerMatchesForm({ server: 'tools', fields: [] }, answer({ 'field-1': 'x' }))).toBe(false);
  });
});
