import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphDraftPersistence, GraphDraftSaveRequest, GraphDraftSnapshot } from '../../../../../contracts/graph-drafts-v1';
import { parseSystemFile } from '../../features/orchestration/systemFile';
import { PortableGraphDraft } from './portableGraphDraft.svelte';

const fixture = readFileSync(new URL('../../../../../examples/systems/structured-review.piui.json', import.meta.url), 'utf8');

function storage(): GraphDraftPersistence & { values: Map<string, GraphDraftSnapshot>; requests: GraphDraftSaveRequest[] } {
  const values = new Map<string, GraphDraftSnapshot>();
  const requests: GraphDraftSaveRequest[] = [];
  return {
    values, requests,
    async list() { return [...values.values()].map(value => ({ id: value.id, name: parseSystemFile(value.document).name, revision: value.revision })); },
    async load(id) { return values.get(id) ?? null; },
    async save(request) {
      requests.push(request);
      const existing = values.get(request.id);
      if (existing?.document === request.document && existing.revision === (request.expectedRevision ?? 0) + 1) return { kind: 'saved', snapshot: existing };
      if ((existing?.revision ?? null) !== request.expectedRevision) return { kind: 'conflict' };
      const snapshot: GraphDraftSnapshot = { contractVersion: 1, id: request.id, revision: (existing?.revision ?? 0) + 1, document: request.document };
      values.set(request.id, snapshot);
      return { kind: 'saved', snapshot };
    },
  };
}

describe('portable graph draft integration boundary', () => {
  it('uses current host defaults only for future nodes and exposes exact saved/dirty identity', async () => {
    const editor = new PortableGraphDraft(storage());
    const initial = editor.draftState();
    expect(initial).toEqual({ id: editor.graph.id, revision: null, dirty: false });
    editor.setCreationProfile({ harness: 'hermes', permissionMode: 'native', model: 'smart', models: ['free', 'smart'] });
    expect(editor.draftState()).toEqual(initial);
    editor.addAgent({ x: 0, y: 0 });
    expect(editor.selected?.profile).toMatchObject({ harness: 'hermes', model: 'smart', permissionMode: 'native' });
    editor.rename('Cloud draft');
    editor.updateNode(editor.selectedId, { task: 'A synthetic task' });
    expect(editor.draftState().dirty).toBe(true);
    expect(await editor.save()).toBe(true);
    expect(editor.draftState()).toEqual({ id: initial.id, revision: 1, dirty: false });
    editor.pendingDocument = '{';
    expect(editor.draftState().dirty).toBe(true);
    editor.discardDocument();
    expect(editor.importText(fixture)).toBe(true);
    expect(editor.graph.nodes[0].profile.harness).toBe(parseSystemFile(fixture).agents[0].profile.harness);
    const imported = editor.exportText();
    editor.setCreationProfile({ harness: 'hermes', permissionMode: 'native', model: 'free', models: ['free'] });
    expect(editor.exportText()).toBe(imported);
    editor.addAgent({ x: 0, y: 0 });
    expect(editor.selected?.profile.model).toBe('free');
    editor.setCreationProfile(null);
    const before = editor.exportText();
    expect(() => editor.setCreationProfile({ harness: 'hermes', permissionMode: 'native', model: 'smart', models: ['free'] })).toThrow();
    expect(editor.exportText()).toBe(before);
  });
  it('gives pending JSON exclusive editing authority until apply or discard', () => {
    const editor = new PortableGraphDraft(storage());
    editor.importText(fixture);
    editor.updateNode(editor.graph.nodes[0].id, { task: 'Earlier canvas edit' });
    const before = editor.graph;
    const pending = JSON.parse(editor.documentText());
    pending.name = 'Pending JSON';
    editor.pendingDocument = JSON.stringify(pending);
    expect(editor.readOnly).toBe(true);
    editor.rename('Must not replace JSON');
    editor.updateNode(editor.graph.nodes[0].id, { task: 'Blocked canvas edit' });
    editor.addAgent({ x: 50, y: 50 });
    editor.movedNodes([{ id: editor.graph.nodes[0].id, x: 999, y: 999 }]);
    editor.removeSelection([editor.graph.nodes[0].id], []);
    editor.undo();
    expect(editor.graph).toBe(before);
    expect(editor.applyDocument(editor.pendingDocument)).toBe(true);
    expect(editor.graph.name).toBe('Pending JSON');
    expect(editor.graph.nodes[0].task).toBe('Earlier canvas edit');
    expect(editor.readOnly).toBe(false);
    editor.pendingDocument = '{';
    editor.discardDocument();
    editor.rename('Canvas active');
    expect(editor.graph.name).toBe('Canvas active');
  });

  it('recovers a lost create acknowledgement by reloading the current storage identity', async () => {
    const host = storage();
    const save = host.save;
    let loseAcknowledgement = true;
    host.save = async request => {
      const answer = await save(request);
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Lost acknowledgement'); }
      return answer;
    };
    const editor = new PortableGraphDraft(host);
    editor.importText(fixture);
    const id = editor.graph.id;
    expect(await editor.save()).toBe(false);
    expect(editor.revision).toBeNull();
    expect(editor.canReload).toBe(true);
    editor.rename('Edited after unconfirmed create');
    expect(await editor.save()).toBe(false);
    expect(editor.conflict).toBe(true);
    expect(editor.applyDocument(editor.documentText())).toBe(true);
    expect(editor.errors).toEqual([]);
    expect(editor.conflict).toBe(true);
    expect(await editor.open(id)).toBe(true);
    expect(editor.revision).toBe(1);
    expect(editor.conflict).toBe(false);
    expect(editor.dirty).toBe(false);
  });
  it('imports as a new unsaved identity and atomically round-trips the whole portable graph', async () => {
    const host = storage();
    const editor = new PortableGraphDraft(host);
    expect(editor.importText(fixture)).toBe(true);
    expect(host.requests).toHaveLength(0);
    expect(editor.revision).toBeNull();
    expect(editor.dirty).toBe(true);
    const exported = editor.exportText();
    const original = parseSystemFile(fixture);
    const document = parseSystemFile(exported);
    expect(document.inputs).toEqual(original.inputs);
    expect(document.agents[1].review).toEqual(original.agents[1].review);
    expect(document.agents[1].requireApproval).toBe(true);
    expect(document.connections).toEqual(original.connections);
    expect(await editor.save()).toBe(true);
    expect(host.requests[0]).toEqual({ contractVersion: 1, id: editor.graph.id, expectedRevision: null, document: exported });
    const savedId = editor.graph.id;
    expect(editor.dirty).toBe(false);
    expect(editor.revision).toBe(1);
    editor.newDraft();
    expect(await editor.open(savedId)).toBe(true);
    expect(editor.exportText()).toBe(exported);
    expect(editor.importText(exported)).toBe(true);
    expect(editor.graph.id).not.toBe(savedId);
    expect(editor.revision).toBeNull();
    expect(host.requests).toHaveLength(1);
  });

  it('rejects invalid and unsupported imports without changing the current graph or its revision', async () => {
    const editor = new PortableGraphDraft(storage());
    editor.importText(fixture);
    await editor.save();
    const graph = editor.graph;
    const unsupported = { ...JSON.parse(fixture), unsupportedCapability: 'never silently discard' };
    expect(editor.importText(JSON.stringify(unsupported))).toBe(false);
    expect(editor.graph).toBe(graph);
    expect(editor.revision).toBe(1);
    expect(editor.importText('{')).toBe(false);
    expect(editor.graph).toBe(graph);
    expect(editor.applyDocument(JSON.stringify(unsupported))).toBe(false);
    expect(editor.graph).toBe(graph);
    editor.pendingDocument = JSON.stringify(unsupported);
    expect(editor.dirty).toBe(true);
    expect(await editor.save()).toBe(false);
    expect(editor.graph).toBe(graph);
    expect(editor.pendingDocument).toBe(JSON.stringify(unsupported));
  });

  it('preserves the losing draft and revision on a concurrent save conflict, then explicitly forks or reloads', async () => {
    const host = storage();
    const first = new PortableGraphDraft(host), second = new PortableGraphDraft(host);
    first.importText(fixture);
    await first.save();
    const id = first.graph.id;
    await second.open(id);
    first.rename('First editor');
    await first.save();
    second.rename('Second editor');
    expect(await second.save()).toBe(false);
    expect(second.conflict).toBe(true);
    expect(second.graph.name).toBe('Second editor');
    expect(second.revision).toBe(1);
    expect(second.dirty).toBe(true);
    second.saveAsNew();
    expect(second.graph.id).not.toBe(id);
    expect(second.graph.name).toBe('Second editor');
    expect(await second.save()).toBe(true);
    expect(host.values.size).toBe(2);
    expect(await second.open(id)).toBe(true);
    expect(second.graph.name).toBe('First editor');
    expect(second.revision).toBe(2);
  });

  it('ignores a response after disposal and preserves local edits when a loaded document is unsupported', async () => {
    const host = storage();
    const editor = new PortableGraphDraft(host);
    editor.importText(fixture);
    const before = editor.graph;
    let resolve: (value: GraphDraftSnapshot | null) => void = () => {};
    const deferred = new Promise<GraphDraftSnapshot | null>(done => { resolve = done; });
    host.load = () => deferred;
    const loading = editor.open('saved-id');
    editor.dispose();
    resolve({ contractVersion: 1, id: 'saved-id', revision: 1, document: fixture });
    expect(await loading).toBe(false);
    expect(editor.graph).toBe(before);
    const next = new PortableGraphDraft({ ...host, load: async () => ({ contractVersion: 1, id: 'saved-id', revision: 1, document: '{"format":"future"}' }) });
    next.importText(fixture);
    const current = next.graph;
    expect(await next.open('saved-id')).toBe(false);
    expect(next.graph).toBe(current);
  });

  it('preserves pending document edits through conflict forks and exports, and refuses invalid text without clearing it', async () => {
    const host = storage();
    const editor = new PortableGraphDraft(host);
    editor.importText(fixture);
    await editor.save();
    const originalId = editor.graph.id;
    host.save = async () => ({ kind: 'conflict' });
    editor.rename('Canvas edit');
    expect(await editor.save()).toBe(false);
    editor.pendingDocument = '{';
    const graph = editor.graph;
    expect(editor.saveAsNew()).toBe(false);
    expect(editor.graph).toBe(graph);
    expect(editor.graph.id).toBe(originalId);
    expect(editor.revision).toBe(1);
    expect(editor.pendingDocument).toBe('{');
    expect(() => editor.exportText()).toThrow('Invalid JSON');
    expect(editor.pendingDocument).toBe('{');

    const pending = parseSystemFile(fixture);
    pending.name = 'Unapplied document edit';
    pending.agents[0].task = 'Task changed in JSON';
    editor.pendingDocument = JSON.stringify(pending);
    expect(editor.saveAsNew()).toBe(true);
    expect(editor.graph.id).not.toBe(originalId);
    expect(editor.revision).toBeNull();
    expect(editor.graph.name).toBe(pending.name);
    expect(editor.graph.nodes[0].task).toBe(pending.agents[0].task);
    expect(editor.pendingDocument).toBeUndefined();
    pending.name = 'Export this pending edit';
    editor.pendingDocument = JSON.stringify(pending);
    expect(parseSystemFile(editor.exportText()).name).toBe(pending.name);
    expect(editor.graph.name).toBe(pending.name);
    expect(editor.pendingDocument).toBeUndefined();
    expect(editor.dirty).toBe(true);
  });

  it('shares connection cycle checks, undo and structured fields with the desktop document model', () => {
    const editor = new PortableGraphDraft(storage());
    editor.importText(fixture);
    const [source, target] = editor.graph.nodes;
    const before = editor.exportText();
    expect(editor.connect(target.id, source.id, undefined)).toContain('cycle');
    expect(editor.exportText()).toBe(before);
    editor.updateNode(source.id, { task: 'Edited task' });
    expect(editor.graph.nodes[0].task).toBe('Edited task');
    editor.undo();
    expect(editor.exportText()).toBe(before);
    editor.redo();
    expect(editor.graph.nodes[0].task).toBe('Edited task');
    expect(editor.graph.nodes[1].review).toEqual(parseSystemFile(fixture).agents[1].review);
  });
});
