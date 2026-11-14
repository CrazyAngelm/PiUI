import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph } from '../../features/orchestration/agentGraph';
import type { PipelineTemplateV1 } from '../../host-api/pipelineLibraryClient';
import { buildTemplate } from '../pipelines/templates';
import { ChatPipelineError } from './chatPipelines.svelte';
import { templateSystem } from './templateLibrary';
import {
  choiceFromKey,
  draftFromTemplate,
  previewDetail,
  readyToSave,
  rememberedPipeline,
  rememberPipeline,
  templateKey,
  uniquePipelineName,
} from './templateRun';

const identity = (value: string): string => value;
const withModel = async () => ({ model: 'gpt-test' });

function savedTemplate(): PipelineTemplateV1 {
  // A saved template is a complete system file: its agents carry a model.
  const graph = buildTemplate('chain', 'codex', identity);
  const system = templateSystem({ ...graph, nodes: graph.nodes.map((node) => ({ ...node, profile: { ...node.profile, model: 'gpt-test' } })) });
  return { id: 'tpl-1', name: 'Mine', description: 'A saved one', scope: { kind: 'project' }, system } as unknown as PipelineTemplateV1;
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('template keys', () => {
  it('names a built-in and a saved template, and finds the choice again', () => {
    const saved = savedTemplate();
    expect(templateKey({ kind: 'builtin', id: 'review' })).toBe('builtin:review');
    expect(templateKey({ kind: 'saved', template: saved })).toBe('saved:tpl-1');
    expect(choiceFromKey('builtin:review', [])).toEqual({ kind: 'builtin', id: 'review' });
    expect(choiceFromKey('saved:tpl-1', [saved])).toEqual({ kind: 'saved', template: saved });
  });

  it('finds nothing for an unknown built-in, a deleted template or a malformed key', () => {
    expect(choiceFromKey('builtin:nope', [])).toBeUndefined();
    expect(choiceFromKey('saved:gone', [savedTemplate()])).toBeUndefined();
    expect(choiceFromKey('direct:codex', [])).toBeUndefined();
    expect(choiceFromKey('nonsense', [])).toBeUndefined();
  });
});

describe('uniquePipelineName', () => {
  it('keeps a free name and numbers a taken one from 2', () => {
    expect(uniquePipelineName('Review loop', ['Chain'])).toBe('Review loop');
    expect(uniquePipelineName('Review loop', ['Review loop'])).toBe('Review loop 2');
    expect(uniquePipelineName('Review loop', ['Review loop', 'Review loop 2'])).toBe('Review loop 3');
  });

  it('ignores case and surrounding spaces when comparing', () => {
    expect(uniquePipelineName('Review loop', ['  REVIEW LOOP '])).toBe('Review loop 2');
  });
});

describe('draftFromTemplate and previewDetail', () => {
  it('builds a built-in draft whose preview accepts chat messages and names the answering agent', async () => {
    const draft = await draftFromTemplate({ kind: 'builtin', id: 'chain' }, 'codex', identity);
    expect(draft.key).toBe('builtin:chain');
    expect(draft.name).toBe('Chain');
    expect(draft.graph.nodes).toHaveLength(3);
    expect(draft.detail).toMatchObject({ commandId: '', teamId: '', pipelineId: '', name: 'Chain', accepts: true });
    expect(draft.detail.reply).toMatchObject({ stepName: 'Reviewer', harness: 'codex' });
    expect(draft.detail.reply?.model).toBeUndefined();
  });

  it('builds a draft from a saved template', async () => {
    const draft = await draftFromTemplate({ kind: 'saved', template: savedTemplate() }, 'pi', identity);
    expect(draft.key).toBe('saved:tpl-1');
    expect(draft.graph.nodes).toHaveLength(3);
    expect(draft.detail.accepts).toBe(true);
  });

  it('reports a graph without a single text input as not accepting chat messages', async () => {
    const graph = {
      ...buildTemplate('chain', 'codex', identity),
      inputs: [
        { name: 'a', label: 'A', kind: 'text' as const },
        { name: 'b', label: 'B', kind: 'text' as const },
      ],
    };
    expect((await previewDetail(graph)).accepts).toBe(false);
  });

  it('shows the model a step already has', async () => {
    const graph = buildTemplate('review', 'codex', identity);
    graph.nodes = graph.nodes.map((node) => ({ ...node, profile: { ...node.profile, model: 'gpt-x', modelProvider: 'openai' } }));
    expect((await previewDetail(graph)).reply?.model).toEqual({ id: 'gpt-x', name: 'gpt-x', provider: 'openai' });
  });
});

describe('readyToSave', () => {
  it('fills models, gives a unique name and returns a valid graph', async () => {
    const draft = await draftFromTemplate({ kind: 'builtin', id: 'chain' }, 'codex', identity);
    const graph = await readyToSave(draft, withModel, ['Chain']);
    expect(graph.name).toBe('Chain 2');
    expect(graph.id).toBe(draft.graph.id);
    expect(graph.nodes.every((node) => node.profile.model === 'gpt-test')).toBe(true);
    // The draft itself is not changed: a failed save can be tried again from it.
    expect(draft.graph.name).toBe('Chain');
    expect(draft.graph.nodes.every((node) => node.profile.model === '')).toBe(true);
  });

  it('keeps a model the template already has', async () => {
    const draft = await draftFromTemplate({ kind: 'builtin', id: 'review' }, 'codex', identity);
    const [first, ...rest] = draft.graph.nodes;
    const graph = await readyToSave({ ...draft, graph: { ...draft.graph, nodes: [{ ...first!, profile: { ...first!.profile, model: 'mine' } }, ...rest] } }, withModel, []);
    expect(graph.nodes[0]?.profile.model).toBe('mine');
    expect(graph.nodes[1]?.profile.model).toBe('gpt-test');
  });

  it('refuses when a harness has no model, naming it', async () => {
    const draft = await draftFromTemplate({ kind: 'builtin', id: 'chain' }, 'codex', identity);
    await expect(readyToSave(draft, async () => undefined, [])).rejects.toThrow('This template needs a model, but Codex has none available.');
    await expect(readyToSave(draft, async () => undefined, [], (value, parameters) => value.replace('{0}', String(parameters?.[0])))).rejects.toBeInstanceOf(
      ChatPipelineError,
    );
  });

  it('treats a model catalog that fails like a harness without models', async () => {
    const draft = await draftFromTemplate({ kind: 'builtin', id: 'chain' }, 'codex', identity);
    await expect(
      readyToSave(
        draft,
        async () => {
          throw new Error('offline');
        },
        [],
      ),
    ).rejects.toBeInstanceOf(ChatPipelineError);
  });

  it('refuses a graph the editor would not save', async () => {
    const draft = await draftFromTemplate({ kind: 'builtin', id: 'chain' }, 'codex', identity);
    const empty = { ...draft, graph: { ...emptyGraph(), name: 'Empty' } };
    await expect(readyToSave(empty, withModel, [])).rejects.toBeInstanceOf(ChatPipelineError);
  });
});

describe('remembered pipelines', () => {
  it('remembers the pipeline a template was saved as, per project', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(rememberedPipeline('ws', 'builtin:chain')).toBeUndefined();
    rememberPipeline('ws', 'builtin:chain', 'cmd-1');
    rememberPipeline('ws', 'saved:tpl-1', 'cmd-2');
    expect(rememberedPipeline('ws', 'builtin:chain')).toBe('cmd-1');
    expect(rememberedPipeline('ws', 'saved:tpl-1')).toBe('cmd-2');
    expect(rememberedPipeline('other', 'builtin:chain')).toBeUndefined();
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    vi.stubGlobal('localStorage', broken);
    expect(rememberedPipeline('ws', 'builtin:chain')).toBeUndefined();
    expect(() => rememberPipeline('ws', 'builtin:chain', 'cmd-1')).not.toThrow();
  });

  it('survives storage without localStorage and stored garbage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(rememberedPipeline('ws', 'builtin:chain')).toBeUndefined();
    expect(() => rememberPipeline('ws', 'builtin:chain', 'cmd-1')).not.toThrow();
    const storage = memoryStorage();
    storage.setItem('piui.chat.templatePipelines.v1', '[1,2');
    vi.stubGlobal('localStorage', storage);
    expect(rememberedPipeline('ws', 'builtin:chain')).toBeUndefined();
    storage.setItem('piui.chat.templatePipelines.v1', '{"ws":{"builtin:chain":42}}');
    expect(rememberedPipeline('ws', 'builtin:chain')).toBeUndefined();
    rememberPipeline('ws', 'builtin:chain', 'cmd-1');
    expect(rememberedPipeline('ws', 'builtin:chain')).toBe('cmd-1');
  });
});
