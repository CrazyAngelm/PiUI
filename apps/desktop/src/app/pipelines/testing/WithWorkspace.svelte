<script lang="ts">
  import { untrack, type Component } from 'svelte';
  import { Tooltip } from 'bits-ui';
  import type { WorkspaceStore } from '../../workspaceStore.svelte';
  import { provideWorkspace } from '../../shell/context';

  /** Test-only wrapper: renders `component` with the shell's workspace and tooltip contexts. */
  interface Props {
    workspace: Pick<WorkspaceStore, 'catalog'>;
    component: Component<Record<string, unknown>>;
    props: Record<string, unknown>;
  }
  let { workspace, component: Child, props }: Props = $props();
  provideWorkspace(untrack(() => workspace) as WorkspaceStore);
</script>

<Tooltip.Provider>
  <Child {...props} />
</Tooltip.Provider>
