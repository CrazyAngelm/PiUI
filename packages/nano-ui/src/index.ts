import { mount, unmount } from 'svelte';
import type { GraphEditorHandle, GraphEditorOptions } from '../../../contracts/graph-drafts-v1';
import GraphEditor from '../../../apps/desktop/src/shared/graph/GraphEditor.svelte';
import { PortableGraphDraft } from '../../../apps/desktop/src/shared/graph/portableGraphDraft.svelte';
import { createTranslation } from './locale';
import { TRANSLATION_CONTEXT } from '../../../apps/desktop/src/features/locale/context';
import '../../../apps/desktop/src/styles/tokens.css';
import './island.css';

export type { GraphEditorOptions, GraphEditorHandle } from '../../../contracts/graph-drafts-v1';
const mounted = new WeakSet<HTMLElement>();
const appearances = new Set(['light', 'dark', 'system']);

/** The host supplies authenticated operations; this bundle has no network transport. */
export function mountGraphEditor(target: HTMLElement, options: GraphEditorOptions): GraphEditorHandle {
  if (options.contractVersion !== 1 || !['en', 'ru'].includes(options.language)
    || !appearances.has(options.appearance ?? 'system')
    || !['list', 'load', 'save'].every(key => typeof options[key as 'list' | 'load' | 'save'] === 'function')) {
    throw new Error('Unsupported graph editor contract.');
  }
  if (mounted.has(target) || target.childNodes.length) throw new Error('The graph editor needs an empty, unmounted element.');
  const root = target.ownerDocument.createElement('div');
  root.className = 'nano-graph-root';
  root.dataset.nanoUi = 'graph-v1';
  root.dataset.style = 'nano';
  root.dataset.theme = options.appearance ?? 'system';
  root.dataset.reducedMotion = 'system';
  root.lang = options.language;
  target.append(root);
  const editor = new PortableGraphDraft(options);
  let component: ReturnType<typeof mount>;
  try { component = mount(GraphEditor, { target: root, props: { editor, portalTarget: root }, context: new Map([[TRANSLATION_CONTEXT, createTranslation(options.language)]]) }); }
  catch (error) { editor.dispose(); root.remove(); throw error; }
  mounted.add(target);
  let disposed = false;
  return {
    hasUnsavedChanges: () => !disposed && editor.dirty,
    setAppearance(value) {
      if (!appearances.has(value)) throw new Error('Unsupported graph editor appearance.');
      if (!disposed) root.dataset.theme = value;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      editor.dispose();
      await unmount(component);
      root.remove();
      mounted.delete(target);
    },
  };
}
