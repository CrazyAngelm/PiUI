<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../../../features/locale/language';
  import ChatView from '../ChatView.svelte';
  import { useWorkspace } from '../context';
  import PaneSplitter from './PaneSplitter.svelte';
  import { placePanes, type PaneEdge, type PaneLeaf } from './paneLayout';
  import { workbench } from './workbench.svelte';
  import { CHAT_DRAG_TYPE } from './dragType';

  type Zone = PaneEdge | 'replace';

  interface Props {
    onDelete: (sessionId: string) => void;
  }
  let { onDelete }: Props = $props();
  const store = useWorkspace();

  const count = $derived(workbench.shown.length);
  const placed = $derived(placePanes(workbench.layout));
  /** The chat being dragged from the sidebar or a tab, while a drag lasts. */
  let dragged = $state<string | undefined>();
  let hover = $state<{ paneId: string; zone: Zone } | undefined>();

  function enter(leaf: PaneLeaf): void {
    if (leaf.id === workbench.activePaneId) return;
    store.focusSession(leaf.sessionId);
  }

  /** Closing or splitting destroys the focused control; the work moves to the composer of the active pane. */
  function focusActiveComposer(): void {
    void tick().then(() => {
      const id = workbench.activePaneId;
      if (!id) return;
      document.querySelector<HTMLElement>(`[data-pane="${id}"] textarea, [data-pane="${id}"] [contenteditable="true"]`)?.focus();
    });
  }

  function close(leaf: PaneLeaf): void {
    const wasSelected = leaf.sessionId === store.selectedSessionId;
    const next = workbench.closePane(leaf.id);
    if (wasSelected) {
      if (next) store.focusSession(next);
      else store.goHome();
    }
    focusActiveComposer();
  }

  // The drag data cannot be read while the pointer is over a pane, so it is taken when the drag starts.
  function dragStart(event: DragEvent): void {
    dragged = event.dataTransfer?.getData(CHAT_DRAG_TYPE) || undefined;
  }
  function dragEnd(): void {
    dragged = undefined;
    hover = undefined;
  }

  /** The outer quarter of a pane is an edge; the middle replaces its chat. */
  function zoneAt(event: DragEvent, element: HTMLElement): Zone {
    const box = element.getBoundingClientRect();
    const x = (event.clientX - box.left) / Math.max(box.width, 1);
    const y = (event.clientY - box.top) / Math.max(box.height, 1);
    const edges: [PaneEdge, number][] = [
      ['left', x],
      ['right', 1 - x],
      ['top', y],
      ['bottom', 1 - y],
    ];
    const [edge, distance] = edges.reduce((best, next) => (next[1] < best[1] ? next : best));
    return distance < 0.25 ? edge : 'replace';
  }

  /** An edge needs room for a pane, or a chat that is already on screen and only moves. */
  function allowed(leaf: PaneLeaf, zone: Zone): boolean {
    if (!dragged) return false;
    if (zone === 'replace') return true;
    return dragged !== leaf.sessionId && (!workbench.full || workbench.shown.includes(dragged));
  }

  function over(event: DragEvent, leaf: PaneLeaf): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const zone = zoneAt(event, target);
    if (!allowed(leaf, zone)) {
      hover = undefined;
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (hover?.paneId !== leaf.id || hover.zone !== zone) hover = { paneId: leaf.id, zone };
  }

  function drop(event: DragEvent, leaf: PaneLeaf): void {
    const target = event.currentTarget;
    const id = event.dataTransfer?.getData(CHAT_DRAG_TYPE);
    dragEnd();
    if (!id || !(target instanceof HTMLElement)) return;
    event.preventDefault();
    const zone = zoneAt(event, target);
    if (zone === 'replace') {
      workbench.activate(leaf.id);
      void store.openSession(id);
    } else if (id !== leaf.sessionId && workbench.openBeside(id, zone, leaf.id)) {
      void store.openSession(id);
      focusActiveComposer();
    }
  }

  const splitLabel = (direction: 'row' | 'column'): string => (direction === 'row' ? $t('Resize panes side by side') : $t('Resize panes top and bottom'));
</script>

<!-- Pointer events do not run during a native drag, so one that does means the drag ended unseen. -->
<svelte:window
  ondragstart={dragStart}
  ondragend={dragEnd}
  ondrop={dragEnd}
  onpointermove={() => {
    if (dragged) dragEnd();
  }}
/>

{#snippet leafPane(leaf: PaneLeaf)}
  <section
    class="pane"
    class:pane--active={count > 1 && leaf.id === workbench.activePaneId}
    data-pane={leaf.id}
    onpointerdowncapture={() => enter(leaf)}
    onfocusincapture={() => enter(leaf)}
  >
    {#key leaf.sessionId}
      <ChatView
        sessionId={leaf.sessionId}
        active={leaf.id === workbench.activePaneId}
        {onDelete}
        onClosePane={count > 1 ? () => close(leaf) : undefined}
      />
    {/key}
    {#if dragged}
      <!-- Only while a chat is dragged: the zone under the pointer shows what a drop does. -->
      <div class="drop" aria-hidden="true" ondragover={(event) => over(event, leaf)} ondragleave={() => (hover = undefined)} ondrop={(event) => drop(event, leaf)} role="presentation">
        {#if hover?.paneId === leaf.id}<div class="drop__zone drop__zone--{hover.zone}"></div>{/if}
      </div>
    {/if}
  </section>
{/snippet}

<!--
  One flat keyed list in reading order, placed by the layout's fractions: a chat stays mounted,
  with its scroll position and composer, when a pane opens or closes beside it, and the keyboard
  walks a pane, the separator after it, then the next pane.
-->
<div class="grid">
  {#each placed as place (place.key)}
    {#if place.kind === 'pane'}
      <div class="cell" style:left="{place.left * 100}%" style:top="{place.top * 100}%" style:width="{place.width * 100}%" style:height="{place.height * 100}%">
        {@render leafPane(place.leaf)}
      </div>
    {:else}
      <!-- The box of one split. Its separator sits at the ratio and measures this box while it is dragged. -->
      <div
        class="divider"
        class:divider--column={place.direction === 'column'}
        style:left="{place.left * 100}%"
        style:top="{place.top * 100}%"
        style:width="{place.width * 100}%"
        style:height="{place.height * 100}%"
      >
        <span style:flex="{place.ratio} 1 0"></span>
        <PaneSplitter direction={place.direction} ratio={place.ratio} label={splitLabel(place.direction)} onResize={(ratio) => workbench.resize(place.path, ratio)} />
        <span style:flex="{1 - place.ratio} 1 0"></span>
      </div>
    {/if}
  {/each}
</div>

<style>
  .grid {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .cell {
    position: absolute;
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  /* Drawn over the seam of its two halves; only the separator takes the pointer. */
  .divider {
    position: absolute;
    z-index: 3;
    display: flex;
    pointer-events: none;
  }
  .divider--column {
    flex-direction: column;
  }
  .divider :global(.splitter) {
    pointer-events: auto;
  }
  .pane {
    position: relative;
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
  }
  .pane--active::before {
    content: '';
    position: absolute;
    inset: 0 0 auto;
    z-index: 2;
    height: 2px;
    background: var(--piui-accent);
    pointer-events: none;
  }
  .drop {
    position: absolute;
    inset: 0;
    z-index: 4;
  }
  .drop__zone {
    position: absolute;
    border: 2px dashed var(--piui-accent);
    background: var(--piui-accent-soft);
    opacity: 0.85;
    pointer-events: none;
  }
  .drop__zone--replace {
    inset: 0;
  }
  .drop__zone--left {
    inset: 0 50% 0 0;
  }
  .drop__zone--right {
    inset: 0 0 0 50%;
  }
  .drop__zone--top {
    inset: 0 0 50% 0;
  }
  .drop__zone--bottom {
    inset: 50% 0 0 0;
  }
</style>
