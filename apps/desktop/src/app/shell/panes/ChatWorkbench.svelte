<script lang="ts">
  import { untrack } from 'svelte';
  import ChatView from '../ChatView.svelte';
  import { useWorkspace } from '../context';
  import PaneGrid from './PaneGrid.svelte';
  import { workbench } from './workbench.svelte';

  interface Props {
    onDelete: (sessionId: string) => void;
  }
  let { onDelete }: Props = $props();
  const store = useWorkspace();

  // The same query as the shell's drawer: a narrow window shows the selected chat only.
  const query = window.matchMedia('(max-width: 760px)');
  let narrow = $state(query.matches);
  $effect(() => {
    const update = (): void => {
      narrow = query.matches;
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });

  // The selected chat is the route; the workbench follows it.
  $effect(() => {
    const route = store.route;
    if (route.name !== 'chat') return;
    const id = route.sessionId;
    untrack(() => workbench.show(id));
  });

  // Chats beside the selected one load themselves and count as seen.
  $effect(() => {
    const selected = store.selectedSessionId;
    const shown = narrow ? [] : workbench.shown.filter((id) => id !== selected);
    untrack(() => store.setShownSessions(shown));
  });
  $effect(() => () => store.setShownSessions([]));

  const selectedId = $derived(store.selectedSessionId);
</script>

{#if narrow}
  {#if selectedId}
    {#key selectedId}
      <ChatView sessionId={selectedId} {onDelete} />
    {/key}
  {/if}
{:else}
  <PaneGrid {onDelete} />
{/if}
