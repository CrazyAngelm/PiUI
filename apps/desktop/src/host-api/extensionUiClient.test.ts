import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/fixtures/workspace-extension-ui-v1.json';
import type { WorkspaceExtensionUiEventV1 } from '../../../../contracts/workspace-extension-ui-v1';
import type { WorkspaceApproval } from '../../../../contracts/workspace-v15';
import { createExtensionUiClient, isExtensionUiEvent } from './extensionUiClient';

describe('workspace extension UI v1 contract', () => {
  it('accepts every golden fixture event shared with the Rust projection', () => {
    for (const item of fixture.cases) {
      const event: unknown = item.event;
      expect(isExtensionUiEvent(event), JSON.stringify(item.request)).toBe(true);
    }
    const typed: WorkspaceExtensionUiEventV1[] = fixture.cases.map((item) => item.event as WorkspaceExtensionUiEventV1);
    expect(new Set(typed.map((event) => event.action.action))).toEqual(
      new Set(['notify', 'status', 'widget', 'title', 'editorText', 'unsupported']),
    );
  });

  it('never carries raw request ids, native values or paths across the boundary', () => {
    const events = JSON.stringify(fixture.cases.map((item) => item.event));
    expect(events).not.toMatch(/rpc-notify-1|rpc-custom-1|\/home\/user|"statusKey"|"widgetKey"/);
  });

  it('drops malformed and unknown shapes instead of rendering them', () => {
    const valid = fixture.cases[0]?.event as WorkspaceExtensionUiEventV1;
    for (const bad of [
      { ...valid, protocol: 2 },
      { ...valid, sessionId: '' },
      { ...valid, action: { ...valid.action, level: 'loud' } },
      { ...valid, action: { action: 'dialog', request: {} } },
      { ...valid, action: { action: 'widget', key: 'k', placement: 'side' } },
      { ...valid, action: { action: 'widget', key: 'k', placement: 'aboveEditor', lines: [1] } },
      { ...valid, action: { action: 'status', key: 'k', text: 3 } },
      null,
      'string',
    ]) {
      expect(isExtensionUiEvent(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('delivers only valid events from the channel', async () => {
    const delivered: WorkspaceExtensionUiEventV1[] = [];
    let emit: (payload: unknown) => void = () => {};
    const client = createExtensionUiClient(async (channel, handler) => {
      expect(channel).toBe('piui://workspace-extension-ui');
      emit = handler as (payload: unknown) => void;
      return () => {};
    });
    await client.listen((event) => delivered.push(event));
    emit({ protocol: 1 });
    emit(fixture.cases[1]?.event);
    expect(delivered).toHaveLength(1);
  });

  it('keeps the additive approval fields optional in workspace v15', () => {
    const plain: WorkspaceApproval = { id: 'a', sessionId: 's', kind: 'permission', title: 't', description: 'd', decisions: ['deny'] };
    const editor: WorkspaceApproval = { ...plain, kind: 'input', inputLabel: 'Response', prefill: 'draft', timeoutMs: 40 };
    expect(Object.keys(plain)).not.toContain('prefill');
    expect(editor.prefill).toBe('draft');
  });
});
