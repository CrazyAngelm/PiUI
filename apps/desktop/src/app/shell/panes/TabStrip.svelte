<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Columns2 from '@lucide/svelte/icons/columns-2';
  import Plus from '@lucide/svelte/icons/plus';
  import Rows2 from '@lucide/svelte/icons/rows-2';
  import X from '@lucide/svelte/icons/x';
  import { t } from '../../../features/locale/language';
  import { attention } from '../../attention/attention.svelte';
  import Mark from '../../marks/Mark.svelte';
  import { marks } from '../../marks/marks.svelte';
  import { IconButton, Spinner, matchesShortcut, type MenuEntry } from '../../../lib/ui';
  import ContextMenu from '../../../lib/ui/ContextMenu.svelte';
  import { useWorkspace } from '../context';
  import HarnessMark from '../HarnessMark.svelte';
  import { CHAT_DRAG_TYPE } from './dragType';
  import { panes, type PaneEdge } from './paneLayout';
  import { workbench } from './workbench.svelte';

  const store = useWorkspace();
  let strip = $state<HTMLElement | null>(null);

  const sessions = $derived(new Map(store.catalog.sessions.map((session) => [session.id, session])));
  const tabs = $derived(workbench.tabs.filter((id) => sessions.has(id)));
  const selected = $derived(store.selectedSessionId);
  /** The one tab in the tab order; the others are reached with the arrow keys. */
  const tabStop = $derived(tabs.includes(selected) ? selected : tabs[0]);
  const onScreen = $derived(new Set(workbench.shown));

  // Chats that no longer exist leave the strip, once the catalog is known.
  // A catalog that failed to load is empty, not proof that every chat is gone.
  $effect(() => {
    if (store.catalogLoading || store.catalogError) return;
    const known = new Set(store.catalog.sessions.map((session) => session.id));
    const snapshots = store.snapshots;
    const current = store.selectedSessionId;
    untrack(() => workbench.prune((id) => known.has(id) || snapshots[id] !== undefined || current === id));
  });

  // The selected tab stays in view in a long strip.
  $effect(() => {
    const id = selected;
    if (!id) return;
    void tick().then(() => tabButtons().find((button) => button.dataset.tab === id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });

  const tabButtons = (): HTMLElement[] => [...(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];

  function attentionLabel(kind: string | undefined): string {
    return kind === 'decision' ? $t('Needs your decision') : kind === 'failed' ? $t('Failed') : $t('New result');
  }

  /** A chat on screen is only focused; any other is opened in the active pane. */
  function select(id: string): void {
    if (id === selected) return;
    if (workbench.shown.includes(id)) store.focusSession(id);
    else void store.openSession(id);
  }

  function closeTab(id: string): void {
    const wasSelected = id === selected;
    const next = workbench.closeTab(id);
    if (!wasSelected) return;
    if (next) store.focusSession(next);
    else store.goHome();
  }

  function openBeside(id: string, edge: PaneEdge): void {
    if (workbench.openBeside(id, edge)) void store.openSession(id);
  }

  function menuItems(id: string): MenuEntry[] {
    // A chat cannot sit beside itself, and a fifth chat has no room.
    // A narrow window shows the selected chat only, so it has no panes to open.
    const unavailable = workbench.activeSessionId === id || (workbench.full && !onScreen.has(id)) || window.matchMedia('(max-width: 760px)').matches;
    return [
      { label: $t('Open to the right'), icon: Columns2, disabled: unavailable, onSelect: () => openBeside(id, 'right') },
      { label: $t('Open below'), icon: Rows2, disabled: unavailable, onSelect: () => openBeside(id, 'bottom') },
      { type: 'separator' },
      { label: $t('Close tab'), icon: X, onSelect: () => closeTab(id) },
      { label: $t('Close other tabs'), disabled: tabs.length < 2, onSelect: () => workbench.closeOthers(id) },
    ];
  }

  function focusTab(index: number): void {
    const buttons = tabButtons();
    buttons[(index + buttons.length) % buttons.length]?.focus();
  }

  function tabKey(event: KeyboardEvent, id: string): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const index = tabs.indexOf(id);
    if (event.key === 'ArrowRight') focusTab(index + 1);
    else if (event.key === 'ArrowLeft') focusTab(index - 1);
    else if (event.key === 'Home') focusTab(0);
    else if (event.key === 'End') focusTab(tabs.length - 1);
    else if (event.key === 'Delete') {
      // Focus moves to the neighbour that stays.
      const neighbour = tabs[index + 1] ?? tabs[index - 1];
      closeTab(id);
      void tick().then(() => tabButtons().find((button) => button.dataset.tab === neighbour)?.focus());
    } else return;
    event.preventDefault();
  }

  // ---- reordering ----------------------------------------------------------
  let draggingTab = $state<string | undefined>();
  let dropIndex = $state<number | undefined>();

  function dragStart(event: DragEvent, id: string): void {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(CHAT_DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = 'move';
    draggingTab = id;
  }
  function dragEnd(): void {
    draggingTab = undefined;
    dropIndex = undefined;
  }
  function dragOver(event: DragEvent, index: number): void {
    if (!draggingTab) return;
    event.preventDefault();
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const box = target.getBoundingClientRect();
    dropIndex = event.clientX < box.left + box.width / 2 ? index : index + 1;
  }
  function drop(event: DragEvent): void {
    const id = draggingTab;
    const at = dropIndex;
    dragEnd();
    if (!id || at === undefined) return;
    event.preventDefault();
    // It lands in front of the tab that was under the pointer (or last); its own slot is gone by then.
    const before = tabs[at];
    if (before === id) return;
    const rest = workbench.tabs.filter((tab) => tab !== id);
    workbench.moveTab(id, before === undefined ? rest.length : rest.indexOf(before));
  }

  // ---- window shortcuts ----------------------------------------------------
  function stepTab(by: 1 | -1): void {
    if (tabs.length === 0) return;
    const index = tabs.indexOf(selected);
    const next = index < 0 ? (by === 1 ? 0 : tabs.length - 1) : (index + by + tabs.length) % tabs.length;
    const id = tabs[next];
    if (id) select(id);
  }

  function stepPane(by: 1 | -1): void {
    const all = panes(workbench.layout);
    if (all.length < 2) return;
    const index = all.findIndex((leaf) => leaf.id === workbench.activePaneId);
    const next = all[(index + by + all.length) % all.length];
    if (!next) return;
    store.focusSession(next.sessionId);
    // F6 moves the work to the pane, not only the highlight.
    void tick().then(() => document.querySelector<HTMLElement>(`[data-pane="${next.id}"] textarea, [data-pane="${next.id}"] [contenteditable="true"]`)?.focus());
  }

  function keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (matchesShortcut(event, 'Mod+W')) {
      if (store.route.name !== 'chat' || !selected) return;
      event.preventDefault();
      closeTab(selected);
    } else if (matchesShortcut(event, 'Ctrl+Tab')) {
      event.preventDefault();
      stepTab(1);
    } else if (matchesShortcut(event, 'Ctrl+Shift+Tab')) {
      event.preventDefault();
      stepTab(-1);
    } else if (store.route.name === 'chat' && matchesShortcut(event, 'F6')) {
      event.preventDefault();
      stepPane(1);
    } else if (store.route.name === 'chat' && matchesShortcut(event, 'Shift+F6')) {
      event.preventDefault();
      stepPane(-1);
    }
  }
</script>

<svelte:window onkeydown={keydown} />

{#if tabs.length > 0}
  <div class="bar">
    <!-- The tabs take the focus, not the list; the list only receives a dragged tab. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_interactive_supports_focus -->
    <div class="strip" role="tablist" aria-label={$t('Open chats')} bind:this={strip} ondragend={dragEnd} ondrop={drop} ondragover={(event) => draggingTab && event.preventDefault()}>
      {#each tabs as id, index (id)}
        {@const session = sessions.get(id)}
        {#if session}
          {@const isSelected = id === selected}
          {@const mark = marks.session(id)}
          {@const kind = attention.kind(id)}
          <ContextMenu items={menuItems(id)}>
            {#snippet target(props)}
              <!-- The wrapper only carries the drag and the menu; the tab and its close button are the controls. -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
              <div
                {...props}
                class="tab"
                class:tab--selected={isSelected}
                class:tab--before={dropIndex === index && draggingTab !== undefined}
                class:tab--after={dropIndex === index + 1 && index === tabs.length - 1 && draggingTab !== undefined}
                data-shown={onScreen.has(id) && !isSelected ? '' : undefined}
                role="presentation"
                draggable="true"
                ondragstart={(event) => dragStart(event, id)}
                ondragend={dragEnd}
                ondragover={(event) => dragOver(event, index)}
              >
                <button
                  type="button"
                  role="tab"
                  class="tab__main"
                  data-tab={id}
                  aria-selected={isSelected}
                  tabindex={id === tabStop ? 0 : -1}
                  title={session.title}
                  onclick={() => select(id)}
                  onkeydown={(event) => tabKey(event, id)}
                  onmousedown={(event) => {
                    if (event.button === 1) event.preventDefault();
                  }}
                  onauxclick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      closeTab(id);
                    }
                  }}
                >
                  <HarnessMark kind={session.harness} size={14} />
                  {#if mark}<Mark {mark} size={13} />{/if}
                  <span class="tab__title">{session.title}</span>
                  {#if ['starting', 'running', 'stopping'].includes(session.status)}
                    <Spinner size={10} />
                  {:else if kind}
                    <span class="tab__attention" role="img" aria-label={attentionLabel(kind)}></span>
                  {/if}
                </button>
                <button type="button" class="tab__close" tabindex="-1" aria-label={$t('Close tab {0}', [session.title])} onclick={() => closeTab(id)}>
                  <X size={12} />
                </button>
              </div>
            {/snippet}
          </ContextMenu>
        {/if}
      {/each}
    </div>
    <IconButton label={$t('New chat')} shortcut="Mod+N" size="sm" onclick={() => store.goHome()}><Plus /></IconButton>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: var(--piui-space-1);
    height: 36px;
    padding-right: var(--piui-space-2);
    border-bottom: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
    flex: none;
  }
  .strip {
    display: flex;
    align-items: stretch;
    align-self: stretch;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  .strip::-webkit-scrollbar {
    display: none;
  }
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    flex: 0 1 auto;
    min-width: 0;
    max-width: 240px;
    color: var(--piui-text-muted);
  }
  .tab::after {
    content: '';
    position: absolute;
    inset: auto 6px 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: transparent;
    pointer-events: none;
  }
  .tab[data-shown]::after {
    background: var(--piui-text-faint);
  }
  .tab--selected {
    background: var(--piui-bg);
    color: var(--piui-text);
  }
  .tab--selected::after {
    background: var(--piui-accent);
  }
  .tab:hover:not(.tab--selected) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .tab--before {
    box-shadow: inset 2px 0 0 var(--piui-accent);
  }
  .tab--after {
    box-shadow: inset -2px 0 0 var(--piui-accent);
  }
  .tab__main {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 100%;
    padding: 0 28px 0 var(--piui-space-3);
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font-size: var(--piui-text-md);
    text-align: left;
  }
  .tab__main:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: -2px;
  }
  .tab__title {
    min-width: 0;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab__attention {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--piui-accent);
    flex: none;
  }
  .tab__close {
    position: absolute;
    top: 50%;
    right: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: var(--piui-radius-xs);
    background: transparent;
    color: var(--piui-text-muted);
    opacity: 0;
    transform: translateY(-50%);
  }
  .tab:hover .tab__close,
  .tab:focus-within .tab__close,
  .tab--selected .tab__close {
    opacity: 1;
  }
  .tab__close:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
</style>
