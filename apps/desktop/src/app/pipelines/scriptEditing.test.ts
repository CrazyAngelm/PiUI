import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { WorkspaceCatalog } from '../../../../../contracts/workspace-v15';
import { newGraphNode, newRouterNode, newScriptNode, type AgentGraph, type GraphNode } from '../../features/orchestration/agentGraph';
import type { OrchestrationClient } from '../../host-api/orchestrationClient';
import WithWorkspace from './testing/WithWorkspace.svelte';
import NodeInspector from './NodeInspector.svelte';
import NodeTypeMenu from './NodeTypeMenu.svelte';
import ScriptTestPanel from './ScriptTestPanel.svelte';
import ScriptEditor from './code/ScriptEditor.svelte';
import { PipelineEditorStore } from './editorStore.svelte';

/**
 * Server-rendered markup of the new editor pieces: labels, keyboard-reachable
 * controls, the plain-text fallback before CodeMirror loads, and the reasons
 * a script test cannot start. Behaviour is covered by the store tests.
 */
function catalog(trust: 'trusted' | 'restricted', safeMode = false): WorkspaceCatalog {
  return {
    protocol: 15,
    safeMode,
    workspaces: [{ id: 'workspace', name: 'Project', trust, missing: false, personal: false }],
    sessions: [],
    harnesses: [{ kind: 'codex', name: 'Codex', installed: true, version: '0.157.1', status: 'available' }],
  };
}

function scriptNode(source: string): GraphNode {
  const node = newScriptNode(0);
  return { ...node, profile: { ...node.profile, name: 'Metrics' }, executor: { type: 'script', runtime: 'python', source, timeoutSeconds: 30 } };
}

function editorWith(node: GraphNode, safeMode = false): PipelineEditorStore {
  const editor = new PipelineEditorStore('workspace', safeMode, {} as OrchestrationClient);
  const plan = newGraphNode(1);
  const graph: AgentGraph = {
    id: 'g', name: 'G', teamId: 't', pipelineId: 'p',
    nodes: [plan, node],
    edges: [{ from: plan.id, to: node.id, kind: 'result' }],
  };
  editor.startFrom(graph);
  editor.selectedId = node.id;
  return editor;
}

function renderWith(component: unknown, props: Record<string, unknown>, workspace: WorkspaceCatalog): string {
  return render(WithWorkspace, {
    props: { workspace: { catalog: workspace }, component: component as Component<Record<string, unknown>>, props },
  }).body;
}

describe('script editing markup', () => {
  it('shows the code in a labelled plain field until the highlighting editor loads', () => {
    const { body } = render(ScriptEditor, {
      props: { id: 'code', value: 'print("<b>hi</b>")', runtime: 'python', label: 'Code', keyboardHint: 'Tab indents.' },
    });
    expect(body).toMatch(/<textarea[^>]*id="code"[^>]*aria-label="Code"/);
    expect(body).toContain('print("&lt;b>hi&lt;/b>")');
    expect(body).toMatch(/<div class="host[^"]*"[^>]*hidden/);
    // The keyboard hint belongs to CodeMirror's Tab handling, not the plain field.
    expect(body).not.toContain('Tab indents.');
    const view = render(ScriptEditor, { props: { id: 'run-code', value: 'console.log(1)', runtime: 'node', label: 'Code', size: 'viewer', readOnly: true } }).body;
    expect(view).toContain('<pre class="plain');
    expect(view).not.toContain('<textarea');
  });

  it('labels the node type control and hides it for routers', () => {
    const script = scriptNode('print(1)');
    const markup = renderWith(NodeTypeMenu, { editor: editorWith(script), node: script }, catalog('trusted'));
    expect(markup).toMatch(/<button[^>]*aria-label="Node type: Script"/);
    expect(markup).toContain('aria-haspopup="menu"');
    const router = newRouterNode(0);
    expect(renderWith(NodeTypeMenu, { editor: editorWith(router), node: router }, catalog('trusted'))).not.toContain('Node type');
  });

  it('offers a labelled sample input and a Test button for a runnable script', () => {
    const script = scriptNode('import json\nprint(json.dumps({}))\n');
    const editor = editorWith(script);
    const markup = renderWith(ScriptTestPanel, { editor, node: script }, catalog('trusted'));
    expect(markup).toContain('Test script');
    expect(markup).toMatch(/<label[^>]*for="script-test-sample"[^>]*>\s*Sample input \(stdin\)/);
    expect(markup).toMatch(/<textarea[^>]*id="script-test-sample"/);
    expect(markup).toContain(`"id": "${script.id}"`);
    const test = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Test<\/span><\/button>/.exec(markup)?.[0] ?? '';
    expect(test).not.toContain('disabled');
  });

  it('explains why a script cannot be tested', () => {
    const script = scriptNode('print(1)');
    expect(renderWith(ScriptTestPanel, { editor: editorWith(script), node: script }, catalog('restricted'))).toContain('Trust this project folder to test scripts.');
    expect(renderWith(ScriptTestPanel, { editor: editorWith(script, true), node: script }, catalog('trusted', true))).toContain('Scripts do not run in safe mode.');
    const empty = scriptNode('  ');
    expect(renderWith(ScriptTestPanel, { editor: editorWith(empty), node: empty }, catalog('trusted'))).toContain('Add code of at most 64 KiB to test it.');
  });

  it('puts the type control in the inspector header of every agent, model call and script', () => {
    for (const [node, label] of [
      [scriptNode('print(1)'), 'Script'],
      [newGraphNode(0), 'Agent'],
    ] as const) {
      const markup = renderWith(NodeInspector, { editor: editorWith(node), node, onClose: () => undefined, onFocusNode: () => undefined }, catalog('trusted'));
      expect(markup).toMatch(new RegExp(`<header[\\s\\S]*aria-label="Node type: ${label}"[\\s\\S]*</header>`));
    }
  });

  it('keeps the byte counter, the limit and the example next to the code editor', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./NodeInspector.svelte', import.meta.url), 'utf8');
    expect(source).toContain("$t('{0} of {1} KiB', [(scriptBytes / 1024).toFixed(1), MAX_SCRIPT_SOURCE_BYTES / 1024])");
    expect(source).toContain("$t('Insert example')");
    expect(source).toMatch(/<ScriptEditor[\s\S]*label=\{\$t\('Code'\)\}[\s\S]*keyboardHint=\{\$t\('Tab indents\. Press Esc, then Tab, to move focus out of the code\.'\)\}/);
    expect(source).toContain('<ScriptTestPanel {editor} {node} />');
  });
});
