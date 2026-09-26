import { getContext, setContext } from 'svelte';
import type { WorkspaceStore } from '../workspaceStore.svelte';

const KEY = Symbol('piui.workspace');

export function provideWorkspace(store: WorkspaceStore): WorkspaceStore {
  return setContext(KEY, store);
}

export function useWorkspace(): WorkspaceStore {
  const store = getContext<WorkspaceStore | undefined>(KEY);
  if (store === undefined) throw new Error('Workspace store is not provided.');
  return store;
}

/** The context key, for component tests that render with a store of their own. */
export const WORKSPACE_CONTEXT: symbol = KEY;
