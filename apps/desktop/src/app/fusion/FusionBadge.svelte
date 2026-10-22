<script lang="ts">
  import Swords from '@lucide/svelte/icons/swords';
  import { t } from '../../features/locale/language';
  import { Button, Dialog, Popover, StatusDot, toasts } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import { useWorkspace } from '../shell/context';
  import FusionPanel, { type FusionConfirm } from './FusionPanel.svelte';
  import { FusionPairState } from './fusionPairState.svelte';
  import { sidekickStateDot, sidekickStateLabel } from './fusionState';

  /**
   * The Fusion badge of a lead chat's header (ADR-043): the sidekick and what
   * it is doing, and a panel with the briefs and the person's controls.
   */
  interface Props {
    leadSessionId: string;
  }
  let { leadSessionId }: Props = $props();
  const store = useWorkspace();

  let model = $state.raw<FusionPairState>();
  let open = $state(false);
  let confirm = $state<FusionConfirm | undefined>();
  let confirmOpen = $state(false);
  let confirming = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    const created = new FusionPairState(leadSessionId);
    model = created;
    created.start();
    return () => created.dispose();
  });

  // The journal is also refetched whenever the panel opens (an event may have been missed).
  $effect(() => {
    if (open) void model?.refresh();
  });

  const pair = $derived(model?.state);
  const sidekickName = $derived(pair ? harnessMeta(pair.pair.sidekick.harness).short : '');
  const stateText = $derived(pair ? $t(sidekickStateLabel(pair.sidekick)) : '');
  const label = $derived(
    pair
      ? $t('Fusion pair, sidekick {0} {1}. Open details.', [sidekickName, stateText])
      : model?.error
        ? $t('Fusion pair, state unavailable. Open details.')
        : $t('Fusion pair, loading. Open details.'),
  );

  function openSession(sessionId: string): void {
    open = false;
    void store.openSession(sessionId);
  }

  function ask(request: FusionConfirm): void {
    confirm = request;
    open = false;
    confirmOpen = true;
  }

  // The panel that asked is gone by now; focus returns to the badge.
  function confirmChanged(next: boolean): void {
    if (!next) setTimeout(() => triggerEl?.focus(), 0);
  }

  async function run(): Promise<void> {
    const request = confirm;
    if (!request || !model) return;
    confirming = true;
    const ok =
      request.kind === 'reset'
        ? await model.act('resetSidekick', { type: 'resetSidekick', leadSessionId })
        : await model.act(`abandon:${request.roundId}`, { type: 'abandonRound', leadSessionId, roundId: request.roundId });
    confirming = false;
    confirmOpen = false;
    if (!ok && model.error) toasts.error($t('The Fusion action failed'), $t(model.error));
  }

  const confirmCopy = $derived(
    confirm?.kind === 'abandon'
      ? {
          title: $t('Abandon this round?'),
          description: $t('The round is closed without a verified report. Files the sidekick already changed stay as they are. This cannot be undone.'),
          action: $t('Abandon round'),
        }
      : {
          title: $t('Reset the sidekick?'),
          description: $t(
            'The current sidekick conversation is retired and stays readable. The next brief starts a fresh sidekick with an empty context, so it will not remember earlier briefs.',
          ),
          action: $t('Reset sidekick'),
        },
  );
</script>

<Popover bind:open align="start" width={440} padded={false} label={$t('Fusion pair')}>
  {#snippet trigger(props)}
    <button type="button" class="badge" bind:this={triggerEl} {...props} aria-label={label}>
      <Swords size={13} aria-hidden="true" />
      <span class="badge__text">{$t('Fusion')}{pair ? ` · ${sidekickName} ${stateText}` : ''}</span>
      {#if pair}<StatusDot status={sidekickStateDot(pair.sidekick)} />{/if}
    </button>
  {/snippet}
  {#if model}
    <FusionPanel {model} safeMode={store.safeMode} onOpenSession={openSession} onConfirm={ask} />
  {/if}
</Popover>

<!-- State changes are announced politely; the badge text alone is not a live region. -->
<span class="visually-hidden" role="status" aria-live="polite">{pair ? $t('Sidekick {0}: {1}', [sidekickName, stateText]) : ''}</span>

<Dialog bind:open={confirmOpen} title={confirmCopy.title} description={confirmCopy.description} size="sm" closeLabel={$t('Close')} onOpenChange={confirmChanged}>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmOpen = false)} disabled={confirming}>{$t('Cancel')}</Button>
    <Button variant="danger" onclick={() => void run()} loading={confirming}>{confirmCopy.action}</Button>
  {/snippet}
</Dialog>

<style>
  .badge {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    max-width: 280px;
    height: 24px;
    padding: 0 10px 0 12px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-xs);
    background: var(--piui-surface-2);
    color: var(--piui-text);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-medium);
    transition:
      background-color var(--piui-duration-fast) var(--piui-ease-out),
      border-color var(--piui-duration-fast) var(--piui-ease-out);
  }
  /* A slanted crimson blade on the left edge. */
  .badge::before {
    content: '';
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 3px;
    width: 3px;
    background: linear-gradient(180deg, var(--piui-chaos-gold), var(--piui-chaos));
    clip-path: polygon(40% 0, 100% 0, 60% 100%, 0 100%);
  }
  .badge:hover,
  .badge[data-state='open'] {
    border-color: var(--piui-chaos);
    background: var(--piui-hover);
  }
  .badge:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .badge__text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
