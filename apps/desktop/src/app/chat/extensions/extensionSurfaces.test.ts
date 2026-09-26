import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { WorkspaceExtensionUiAction, WorkspaceExtensionUiEventV1 } from '../../../host-api/extensionUiClient';
import { createExtensionUiClient } from '../../../host-api/extensionUiClient';
import { EXTENSION_DEMO_COMMAND } from '../../../host-api/lab/extensionDemo';
import type { SessionSnapshot, WorkspaceEvent } from '../../../host-api/lab/labContracts';
import { labHost, record, snapshotOf } from '../../../host-api/lab/labTestKit';
import { demoSessionId } from '../../../host-api/lab/scenarios/demoChats';
import ExtensionSurface from './ExtensionSurface.svelte';
import { ExtensionSurfaces, type DraftAccess } from './extensionSurfaces.svelte';

function drafts(initial: Record<string, string> = {}): DraftAccess & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    draftFor: (sessionId) => values[sessionId] ?? '',
    updateDraft: (sessionId, text) => {
      values[sessionId] = text;
    },
  };
}

const event = (action: WorkspaceExtensionUiAction, sessionId = 's'): WorkspaceExtensionUiEventV1 => ({ protocol: 1, sessionId, action });

async function started(access: DraftAccess): Promise<ExtensionSurfaces> {
  const surfaces = new ExtensionSurfaces();
  await surfaces.start(access, createExtensionUiClient(async () => () => {}));
  return surfaces;
}

describe('extension surfaces of a chat', () => {
  it('keeps notices, statuses, widgets and the title per session', async () => {
    const surfaces = await started(drafts());
    surfaces.apply(event({ action: 'notify', id: 'n1', message: 'Built', level: 'info' }));
    surfaces.apply(event({ action: 'status', key: 'k', text: 'Checks: running' }));
    surfaces.apply(event({ action: 'widget', key: 'w', lines: ['a', 'b'], placement: 'belowEditor' }));
    surfaces.apply(event({ action: 'title', title: 'Reviewing' }));
    surfaces.apply(event({ action: 'status', key: 'other' }, 't'));
    const view = surfaces.stateFor('s');
    expect(view.notifications.map((notice) => notice.message)).toEqual(['Built']);
    expect(view.statuses).toEqual([{ key: 'k', text: 'Checks: running' }]);
    expect(view.widgets).toEqual([{ key: 'w', lines: ['a', 'b'], placement: 'belowEditor' }]);
    expect(view.title).toBe('Reviewing');
    surfaces.apply(event({ action: 'status', key: 'k' }));
    surfaces.apply(event({ action: 'widget', key: 'w', placement: 'belowEditor' }));
    expect(surfaces.stateFor('s').statuses).toEqual([]);
    expect(surfaces.stateFor('s').widgets).toEqual([]);
    surfaces.dismissNotice('s', 'n1');
    expect(surfaces.stateFor('s').notifications).toEqual([]);
    expect(surfaces.stateFor('t').statuses).toEqual([]);
  });

  it('fills an empty composer but never overwrites a typed draft', async () => {
    const access = drafts({ busy: 'my own words' });
    const surfaces = await started(access);
    surfaces.apply(event({ action: 'editorText', text: 'Prepared' }, 'empty'));
    expect(access.values.empty).toBe('Prepared');
    expect(surfaces.composerEpoch('empty')).toBe(1);
    surfaces.apply(event({ action: 'editorText', text: 'Prepared' }, 'busy'));
    expect(access.values.busy).toBe('my own words');
    expect(surfaces.stateFor('busy').editorSuggestion).toBe('Prepared');
    expect(surfaces.composerEpoch('busy')).toBe(0);
    surfaces.discardSuggestion('busy');
    expect(surfaces.stateFor('busy').editorSuggestion).toBeUndefined();
    surfaces.apply(event({ action: 'editorText', text: 'Second' }, 'busy'));
    surfaces.acceptSuggestion('busy');
    expect(access.values.busy).toBe('Second');
    expect(surfaces.composerEpoch('busy')).toBe(1);
  });

  it('turns an unsupported request into a warning notice and clears a stopped session', async () => {
    const surfaces = await started(drafts());
    surfaces.apply(event({ action: 'unsupported', id: 'u', method: 'unsupported', safeSummary: 'This extension UI request is not supported.' }));
    expect(surfaces.stateFor('s').notifications).toEqual([{ id: 'u', message: 'This extension UI request is not supported.', level: 'warning' }]);
    surfaces.clear('s');
    expect(surfaces.stateFor('s').notifications).toEqual([]);
  });

  it('renders every surface as plain text with labelled controls', async () => {
    const surfaces = await started(drafts({ s: 'typed' }));
    surfaces.apply(event({ action: 'notify', id: 'n', message: '<img src=x onerror=alert(1)>', level: 'error' }));
    surfaces.apply(event({ action: 'status', key: 'k', text: 'Checks: running' }));
    surfaces.apply(event({ action: 'widget', key: 'w', lines: ['<b>line</b>'], placement: 'aboveEditor' }));
    surfaces.apply(event({ action: 'editorText', text: 'Prepared' }));
    const above = render(ExtensionSurface, { props: { sessionId: 's', status: 'idle', placement: 'above', agentLabel: 'Pi', surfaces } }).body;
    expect(above).toContain('role="alert"');
    expect(above).not.toContain('<img src=x');
    expect(above).toContain('&lt;img');
    expect(above).not.toContain('<b>line</b>');
    expect(above).toContain('Checks: running');
    expect(above).toContain('aria-label="Dismiss notice"');
    expect(above).toContain('Replace draft');
    const below = render(ExtensionSurface, { props: { sessionId: 's', status: 'idle', placement: 'below', agentLabel: 'Pi', surfaces } }).body;
    expect(below).not.toContain('Checks: running');
    expect(below).not.toContain('line');
  });
});

describe('UI Lab extension demo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays every surface and all four dialog kinds in the Pi playground chat', async () => {
    const host = labHost();
    const sessionId = demoSessionId('extensions');
    const surfaces = await record<WorkspaceExtensionUiEventV1>(host, 'piui://workspace-extension-ui');
    const events = await record<WorkspaceEvent>(host, 'piui://workspace-event');
    await host.invoke('workspace_command_v15', { command: { type: 'send', sessionId, text: `${EXTENSION_DEMO_COMMAND} please`, mode: 'prompt' } });
    const approvals: SessionSnapshot['approvals'] = [];
    for (let step = 0; step < 120 && approvals.length < 4; step += 1) {
      await vi.advanceTimersByTimeAsync(500);
      const [pending] = (await snapshotOf(host, sessionId)).approvals;
      if (pending !== undefined && !approvals.some((item) => item.id === pending.id)) {
        approvals.push(pending);
        await host.invoke('workspace_command_v15', {
          command: { type: 'respond', sessionId, requestId: pending.id, decision: 'approve-once', ...(pending.options ? { text: pending.options[0]?.id } : pending.inputLabel ? { text: 'ok' } : {}) },
        });
      }
    }
    for (let step = 0; step < 40 && (await snapshotOf(host, sessionId)).session.status !== 'idle'; step += 1) {
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(approvals.map((approval) => approval.kind)).toEqual(['permission', 'input', 'input', 'input']);
    expect(approvals[1]?.options?.map((option) => option.label)).toEqual(['Staging', 'Preview', 'Nowhere yet']);
    expect(approvals[3]?.prefill).toContain('feat(history)');
    expect(approvals[3]?.timeoutMs).toBe(120_000);
    const kinds = new Set(surfaces.items.map((item) => item.action.action));
    expect(kinds).toEqual(new Set(['notify', 'status', 'widget', 'title', 'unsupported', 'editorText']));
    expect(surfaces.items.every((item) => item.sessionId === sessionId && item.protocol === 1)).toBe(true);
    // Surfaces never consume workspace revisions.
    const own = events.items.filter((item) => item.sessionId === sessionId);
    expect(own.every((item, index) => index === 0 || item.revision === (own[index - 1]?.revision ?? 0) + 1)).toBe(true);
    surfaces.stop();
    events.stop();
  });
});
