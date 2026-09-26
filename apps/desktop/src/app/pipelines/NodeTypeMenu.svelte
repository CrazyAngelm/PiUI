<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Bot from '@lucide/svelte/icons/bot';
  import MessageSquareText from '@lucide/svelte/icons/message-square-text';
  import Code from '@lucide/svelte/icons/code';
  import { t } from '../../features/locale/language';
  import type { GraphNode } from '../../features/orchestration/agentGraph';
  import { Button, Dialog, Menu, toasts, type MenuEntry } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';
  import type { PipelineEditorStore } from './editorStore.svelte';
  import {
    conversionContext,
    NODE_TYPE_LABEL,
    NODE_TYPES,
    nodeType,
    planConversion,
    type ConversionNote,
    type ConversionPlan,
    type NodeType,
  } from './nodeConversion';

  /**
   * Shows a node's type and changes it (agent, model call, script). A change
   * that removes connections or settings, or discards data, is confirmed in
   * a dialog that lists exactly what goes; every change is one undo step.
   */
  interface Props {
    editor: PipelineEditorStore;
    node: GraphNode;
  }
  let { editor, node }: Props = $props();
  const workspace = useWorkspace();

  const ICONS = { agent: Bot, llm: MessageSquareText, script: Code } as const;
  const current = $derived(nodeType(node));
  let pending = $state.raw<ConversionPlan | undefined>();
  let confirmOpen = $state(false);
  let converting = $state(false);

  const items = $derived<MenuEntry[]>([
    { type: 'label', label: $t('Change type') },
    ...NODE_TYPES.map((type) => ({
      label: $t(NODE_TYPE_LABEL[type]),
      icon: ICONS[type],
      checked: type === current,
      disabled: editor.readOnly || converting || type === current,
      onSelect: () => choose(type),
    })),
  ]);

  function context() {
    return conversionContext(workspace.catalog.harnesses);
  }

  function choose(to: NodeType): void {
    const plan = planConversion(editor.graph, node.id, to, context());
    if (plan === undefined) return;
    if (plan.needsConfirmation) {
      pending = plan;
      confirmOpen = true;
    } else {
      void apply(plan);
    }
  }

  async function apply(plan: ConversionPlan): Promise<void> {
    if (converting) return;
    converting = true;
    try {
      // A new or moved profile starts with the harness's first native model.
      const model = plan.harness === undefined ? undefined : await editor.defaultModel(plan.harness);
      if (editor.convertNode(plan.nodeId, plan.to, context(), model)) {
        toasts.success($t('Changed to {0}', [$t(NODE_TYPE_LABEL[plan.to])]), $t('Undo restores the previous type and everything the change removed.'));
      }
    } finally {
      converting = false;
      confirmOpen = false;
      pending = undefined;
    }
  }

  function text(note: ConversionNote): string {
    return $t(note.message, note.params ?? []);
  }
</script>

{#if current}
  <Menu align="end" {items} minWidth={190}>
    {#snippet trigger(props)}
      <button type="button" class="type" aria-label={$t('Node type: {0}', [$t(NODE_TYPE_LABEL[current])])} {...props}>
        <span>{$t(NODE_TYPE_LABEL[current])}</span>
        <ChevronDown size={12} />
      </button>
    {/snippet}
  </Menu>
{/if}

<Dialog
  bind:open={confirmOpen}
  title={pending ? $t('Change this node to {0}?', [$t(NODE_TYPE_LABEL[pending.to])]) : ''}
  description={$t('The new type cannot keep everything listed below. Undo restores it.')}
  closeLabel={$t('Close')}
  onOpenChange={(open) => {
    if (!open && !converting) pending = undefined;
  }}
>
  {#if pending}
    <div class="changes">
      {#if pending.removals.length}
        <section aria-labelledby="conversion-removed">
          <h3 id="conversion-removed">{$t('Removed connections and settings')}</h3>
          <ul>
            {#each pending.removals as note, index (index)}<li>{text(note)}</li>{/each}
          </ul>
        </section>
      {/if}
      {#if pending.losses.length}
        <section aria-labelledby="conversion-discarded">
          <h3 id="conversion-discarded">{$t('Discarded')}</h3>
          <ul>
            {#each pending.losses as note, index (index)}<li>{text(note)}</li>{/each}
          </ul>
        </section>
      {/if}
      <p class="kept">{$t('Kept: the name, position, result connections, result fields, run condition, review and approval.')}</p>
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmOpen = false)} disabled={converting}>{$t('Cancel')}</Button>
    <Button variant="danger" loading={converting} onclick={() => pending && void apply(pending)}>
      {pending ? $t('Change to {0}', [$t(NODE_TYPE_LABEL[pending.to])]) : ''}
    </Button>
  {/snippet}
</Dialog>

<style>
  .type {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 6px 0 8px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    white-space: nowrap;
  }
  .type:hover {
    border-color: var(--piui-border-strong);
    color: var(--piui-text);
  }
  .type:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .changes {
    display: grid;
    gap: var(--piui-space-3);
  }
  h3 {
    margin: 0 0 4px;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  ul {
    display: grid;
    gap: 2px;
    margin: 0;
    padding-left: 18px;
  }
  .kept {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
