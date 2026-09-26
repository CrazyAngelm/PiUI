import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { WorkspaceApproval, WorkspaceSession } from '../../../../../contracts/workspace-v15';
import type { WorkspaceStore } from '../workspaceStore.svelte';
import ApprovalCard from './ApprovalCard.svelte';
import { WORKSPACE_CONTEXT } from './context';

const session: WorkspaceSession = {
  id: 'session-1', workspaceId: 'workspace-1', harness: 'codex', title: 'Chat', status: 'running', updatedAt: '2026-09-27T00:00:00Z',
};
const store = {
  approvalKey: (sessionId: string, requestId: string) => `${sessionId}:${requestId}`,
  approvalBusy: '',
  approvalErrors: {},
  respond: async () => true,
} as unknown as WorkspaceStore;

function html(approval: WorkspaceApproval): string {
  return render(ApprovalCard, { props: { approval, session }, context: new Map([[WORKSPACE_CONTEXT, store]]) }).body;
}

const form: WorkspaceApproval = {
  id: 'approval-7', sessionId: 'session-1', kind: 'input', title: 'MCP server request',
  description: 'Create an issue?', decisions: ['approve-once', 'deny', 'cancel'],
  form: {
    server: 'lab-issues',
    fields: [
      { type: 'text', id: 'field-1', label: 'Title', required: true, default: 'Broken link' },
      { type: 'choice', id: 'field-2', label: 'Priority', required: true, options: [{ id: 'choice-1', label: 'Urgent' }, { id: 'choice-2', label: 'Normal' }] },
      { type: 'number', id: 'field-3', label: 'Estimate', required: false, integer: true, minimum: 1, maximum: 40 },
      { type: 'boolean', id: 'field-4', label: 'Notify the team', required: false, default: true },
    ],
    limitation: 'optional-fields-omitted',
  },
};

describe('ApprovalCard MCP form requests', () => {
  it('names the MCP server and renders labelled, keyboard-reachable fields', () => {
    const body = html(form);
    expect(body).toContain('aria-label="MCP server lab-issues"');
    expect(body).toContain('Create an issue?');
    expect(body).toContain('role="group" aria-label="Requested values"');
    // Every input is bound to its visible label through a per-approval id.
    for (const id of ['field-1', 'field-2', 'field-3']) {
      expect(body).toContain(`for="approval-session-1-approval-7-${id}"`);
      expect(body).toContain(`id="approval-session-1-approval-7-${id}"`);
    }
    expect(body).toMatch(/<option value="choice-1"[^>]*>Urgent<\/option>/);
    expect(body).toContain('value="Broken link"');
    expect(body).toContain('From 1 to 40.');
    expect(body).toContain('Notify the team');
    expect(body).toContain('Some optional values cannot be entered here and are left empty.');
    expect(body).toMatch(/>\s*Accept\s*</);
    expect(body).toMatch(/>\s*Decline\s*</);
    expect(body).toMatch(/>\s*Dismiss\s*</);
    expect(body).not.toContain('Allow once');
    // The free-text answer box of ordinary questions is not shown for a form.
    expect(body).not.toContain('<textarea');
  });

  it('shows an MCP tool approval without fields and a request it cannot answer', () => {
    const tool = html({ ...form, kind: 'permission', title: 'Allow an MCP tool', form: { server: 'docs', fields: [] } });
    expect(tool).toContain('Allow an MCP tool');
    expect(tool).not.toContain('Requested values');
    expect(tool).toMatch(/>\s*Accept\s*</);
    const unsupported = html({ ...form, decisions: ['deny', 'cancel'], form: { server: 'docs', fields: [], limitation: 'input-unsupported' } });
    expect(unsupported).toContain('This request needs a value PiUI cannot show, so it can only be declined.');
    expect(unsupported).not.toMatch(/>\s*Accept\s*</);
  });

  it('keeps other approvals unchanged', () => {
    const body = html({ id: 'approval-1', sessionId: 'session-1', kind: 'command', title: 'Run command', description: 'Command: ls', decisions: ['approve-once', 'deny', 'cancel'] });
    expect(body).toContain('aria-label="Run a command"');
    expect(body).toMatch(/>\s*Allow once\s*</);
    expect(body).toMatch(/>\s*Deny\s*</);
    expect(body).not.toContain('Requested values');
  });
});
