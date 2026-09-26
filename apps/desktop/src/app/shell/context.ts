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
