import { describe, expect, it } from 'vitest';
import type { RuntimeCapabilities, RuntimeEventEnvelope, SessionTree } from './types';
import type {
  DesktopBootstrapSnapshotV2,
  DesktopLiveRuntimeStartV3,
  DesktopRuntimeEventEnvelopeV4,
  DesktopRuntimeEventEnvelopeV5,
  HostCommand as ProtocolV1Command,
  HostCommandV2 as ProtocolV2Command,
  HostCommandV4 as ProtocolV4Command,
  HostCommandV5 as ProtocolV5Command,
  HostCommandV6 as ProtocolV6Command,
  HostCommandV7 as ProtocolV7Command,
  HostCommandV8 as ProtocolV8Command,
  HostCommandV9 as ProtocolV9Command,
  DesktopBootstrapSnapshotV8,
  DesktopRuntimeEventEnvelopeV9,
  DesktopPiUiContributionCatalogV9,
  DesktopSessionCatalogSnapshotV7,
  DesktopSessionRootHintV7,
  CursorTimelinePage,
} from '../../../../contracts/runtime-protocol';

describe('host contract invariants', () => {
  it('makes unsupported tree navigation and headless auth unrepresentable as enabled', () => {
    const capabilities: RuntimeCapabilities = {
      rpc: true,
      'session.tree.read': true,
      'session.tree.navigate': false,
      'auth.headless': false,
      'ui.standardDialogs': true,
    };

    const tree: SessionTree = { nodes: [], diagnosticCount: 0, navigationSupported: false };

    expect(capabilities['session.tree.navigate']).toBe(false);
    expect(capabilities['auth.headless']).toBe(false);
    expect(tree.navigationSupported).toBe(false);
  });

  it('keeps additive search, cursor paging, and PiUI-only preferences out of the frozen v1 protocol', () => {
    const search: ProtocolV2Command = { protocol: 2, type: 'session.search', payload: { query: 'scanner' } };
    const page: ProtocolV2Command = { protocol: 2, type: 'session.pageByCursor', payload: { projectId: 'project', sessionId: 'session', cursor: 'opaque' } };
    const preferences: ProtocolV2Command = { protocol: 2, type: 'ui.preferences.set', payload: { theme: 'system', density: 'comfortable', reducedMotion: 'system' } };
    const bootstrap: DesktopBootstrapSnapshotV2 = {
      appVersion: '0.1.0',
      safeMode: true,
      preferences: preferences.payload,
      projects: [{ id: 'project', name: 'Project', displayPath: 'D:/redacted', trustState: 'restricted', missing: false, pinned: true }],
    };
    expect(search.protocol).toBe(2);
    expect(page.type).toBe('session.pageByCursor');
    expect(bootstrap.preferences.theme).toBe('system');

    // Keep the frozen protocol type in the compilation surface as well.
    type _ProtocolV1 = ProtocolV1Command;
    void (undefined as unknown as _ProtocolV1);
  });

  it('versions local runtime commands as v4 and scoped event payloads as v5', () => {
    const start: ProtocolV4Command = { protocol: 4, type: 'runtime.start', payload: { projectId: 'project', sessionId: 'session' } };
    const thinkingLevels: ProtocolV4Command = { protocol: 4, type: 'runtime.thinkingLevels.get', payload: { runtimeId: 'runtime' } };
    const legacyEvent: DesktopRuntimeEventEnvelopeV4 = {
      protocol: 4,
      runtimeId: 'runtime',
      projectId: 'project',
      sessionId: 'session',
      kind: 'stateSnapshot',
      revision: 1,
      state: {
        sessionId: 'session',
        messageCount: 0,
        pendingMessageCount: 0,
        isStreaming: false,
        isCompacting: false,
        autoCompactionEnabled: true,
        steeringMode: 'all',
        followUpMode: 'all',
        thinkingLevel: 'medium',
      },
    };
    const event: DesktopRuntimeEventEnvelopeV5 = {
      protocol: 5,
      runtimeId: 'runtime',
      scope: 'project',
      projectId: 'project',
      sessionId: 'session',
      kind: 'stateSnapshot',
      revision: 1,
      state: {
        sessionId: 'session',
        messageCount: 0,
        pendingMessageCount: 0,
        isStreaming: false,
        isCompacting: false,
        autoCompactionEnabled: true,
        steeringMode: 'all',
        followUpMode: 'all',
        thinkingLevel: 'medium',
      },
    };
    const started: DesktopLiveRuntimeStartV3 = {
      runtimeId: 'runtime',
      launchLabel: 'local Pi',
      sessionId: 'session',
      sessionState: event.state,
      runtime: {
        runtimeId: 'runtime',
        state: 'ready',
        revision: 1,
        capabilities: {
          rpc: true,
          'session.tree.read': true,
          'session.tree.navigate': false,
          'auth.headless': false,
          'ui.standardDialogs': false,
        },
      },
    };

    const { projectId: _hostProjectId, scope: _projectScope, ...personalBase } = event;
    const personalEvent: DesktopRuntimeEventEnvelopeV5 = {
      ...personalBase,
      scope: 'personal',
    };
    // @ts-expect-error A personal event cannot serialize a backing project id.
    personalEvent.projectId = 'host-personal-workspace';
    const uiEvent: RuntimeEventEnvelope = {
      protocol: 9,
      runtimeId: 'runtime',
      scope: 'project',
      projectId: 'project',
      sessionId: 'session',
      kind: 'stateSnapshot',
      revision: 1,
      state: event.state,
    };
    // @ts-expect-error Session file paths are host-private and absent from v5.
    event.state.sessionFile = 'C:/private/session.jsonl';
    expect(uiEvent.runtimeId).toBe('runtime');
    expect(legacyEvent.protocol).toBe(4);
    expect(personalEvent.scope).toBe('personal');
    expect(start.protocol).toBe(4);
    expect(thinkingLevels.type).toBe('runtime.thinkingLevels.get');
    expect(started.runtime.capabilities['ui.standardDialogs']).toBe(false);
  });

  it('versions the semantic transcript projection in protocol v6', () => {
    const pageCommand: ProtocolV6Command = { protocol: 6, type: 'session.pageByCursor', payload: { projectId: 'project', sessionId: 'session' } };
    const page: CursorTimelinePage = {
      projectionVersion: 2,
      sessionId: 'session',
      blocks: [{ id: 'tool', kind: 'tool', label: 'Tool activity', title: 'bash', toolName: 'bash', collapsible: true, status: 'complete' }],
      tree: { nodes: [], diagnosticCount: 0, navigationSupported: false },
      fileRevision: 'opaque',
      rangeStart: 0,
      totalBlocks: 1,
      staleCursor: false,
    };

    expect(pageCommand.protocol).toBe(6);
    expect(page.projectionVersion).toBe(2);
    expect(page.blocks[0]?.toolName).toBe('bash');
  });

  it('versions cache-first catalog commands and leaves mutation authority outside catalog freshness', () => {
    const get: ProtocolV7Command = { protocol: 7, type: 'session.catalog.get', payload: { projectId: 'project' } };
    const refresh: ProtocolV7Command = { protocol: 7, type: 'session.catalog.refresh', payload: { projectId: 'project' } };
    const snapshot: DesktopSessionCatalogSnapshotV7 = {
      protocol: 7,
      scope: 'project',
      projectId: 'project',
      sequence: 4,
      freshness: 'cached',
      sessions: [],
    };
    expect(get.protocol).toBe(7);
    expect(refresh.type).toBe('session.catalog.refresh');
    expect(snapshot.freshness).toBe('cached');
    // Neither a file path nor a Pi/JSONL content revision is admitted here.
    expect(Object.keys(snapshot)).not.toContain('fileRevision');
    const rootHint: DesktopSessionRootHintV7 = { protocol: 7, sequence: 5, kind: 'changed' };
    expect(rootHint.kind).toBe('changed');
    expect(Object.keys(rootHint)).not.toContain('path');
  });

  it('versions full appearance preferences without mutating the frozen v2 payload', () => {
    const preferences: ProtocolV8Command = {
      protocol: 8,
      type: 'ui.preferences.set.v8',
      payload: {
        theme: 'dark',
        density: 'comfortable',
        reducedMotion: 'reduce',
        fontSize: 'large',
        chatWidth: 'wide',
      },
    };
    const bootstrap: DesktopBootstrapSnapshotV8 = {
      appVersion: '0.1.0',
      safeMode: false,
      preferences: preferences.payload,
      projects: [],
    };

    expect(preferences.protocol).toBe(8);
    expect(bootstrap.preferences.fontSize).toBe('large');
    expect(bootstrap.preferences.chatWidth).toBe('wide');
  });

  it('versions interactive extension UI and runtime command discovery in protocol v9', () => {
    const commands: ProtocolV9Command = {
      protocol: 9,
      type: 'runtime.commands.get',
      payload: { runtimeId: 'runtime' },
    };
    const contributions: ProtocolV9Command = {
      protocol: 9,
      type: 'extension.contributions.get',
      payload: {},
    };
    const catalog: DesktopPiUiContributionCatalogV9 = {
      commands: [{
        extensionId: 'test.extension',
        extensionName: 'Test extension',
        id: 'test.extension.status',
        title: 'Status',
        commandName: 'status',
      }],
      composerActions: [{
        extensionId: 'test.extension',
        extensionName: 'Test extension',
        id: 'test.extension.statusAction',
        title: 'Status',
        commandId: 'test.extension.status',
        commandName: 'status',
        order: 100,
      }],
    };
    const response: ProtocolV9Command = {
      protocol: 9,
      type: 'runtime.extensionUi.respond',
      payload: {
        runtimeId: 'runtime',
        requestId: 'ui-request',
        response: { kind: 'selected', optionId: 'option-a' },
      },
    };
    const event: DesktopRuntimeEventEnvelopeV9 = {
      protocol: 9,
      runtimeId: 'runtime',
      scope: 'personal',
      kind: 'extensionUi',
      action: {
        action: 'dialog',
        request: {
          kind: 'select',
          id: 'ui-request',
          title: 'Choose a target',
          options: [{ id: 'option-a', label: 'Target A' }],
        },
      },
    };

    expect(commands.type).toBe('runtime.commands.get');
    expect(contributions.type).toBe('extension.contributions.get');
    expect(catalog.composerActions[0]?.commandName).toBe('status');
    expect(response.type).toBe('runtime.extensionUi.respond');
    expect(event.action.action).toBe('dialog');
    expect(event.scope).toBe('personal');
  });

  it('keeps projectless Chats commands in the additive v5 surface', () => {
    const start: ProtocolV5Command = { protocol: 5, type: 'runtime.personal.start', payload: {} };
    const page: ProtocolV5Command = { protocol: 5, type: 'session.personal.page', payload: { sessionId: 'session', cursor: 'opaque' } };
    const list: ProtocolV5Command = { protocol: 5, type: 'session.personal.list', payload: {} };

    expect(start.protocol).toBe(5);
    expect(page.type).toBe('session.personal.page');
    expect(list.type).toBe('session.personal.list');
    // The personal workspace path and backing project identity are not part
    // of the command payload.
    expect(Object.keys(start.payload)).toEqual([]);
  });
});
