<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import SquareTerminal from '@lucide/svelte/icons/square-terminal';
  import type { AcpAgentEntryV1 } from '../../../../../contracts/harness-registry-v1';
  import type { HarnessId } from '../../../../../contracts/harness-identity-v3';
  import { t } from '../../features/locale/language';
  import { Button, Dialog, StatusDot } from '../../lib/ui';
  import { copyParts } from '../chat/claudeSignIn.svelte';
  import { canChooseSecrets } from './acpAgents';
  import { rowStatus, type HarnessConnectStore } from './harnessConnect.svelte';
  import type { HarnessesStore } from './harnessesStore.svelte';
  import NanoProviderSettings from './NanoProviderSettings.svelte';

  /**
   * Connect (ADR-054): how one harness signs in. Every harness signs in with
   * its own tools; this dialog only shows the command, can ask the host to
   * open a terminal for it and checks the result again. Nano Desktop never
   * sees another harness's credentials. Nano's own dialog hosts its model
   * sources (ChatGPT plan, external providers).
   */
  interface Props {
    open?: boolean;
    harness: HarnessId;
    name: string;
    /** The added ACP agent this dialog is for. */
    agent?: AcpAgentEntryV1 | undefined;
    /** The harness's or descriptor's own sign-in hint (an English locale key). */
    hint?: string | undefined;
    /** Methods an ACP agent reported when it refused to start. */
    authMethods?: readonly string[];
    store: HarnessesStore;
    connect: HarnessConnectStore;
    /** Opens Settings → Nano account. */
    onOpenNanoAccount: () => void;
    /** ChatGPT or an external provider was connected or removed. */
    onModelSourcesChange: () => void;
    onSecrets: (agent: AcpAgentEntryV1) => void;
  }
  let {
    open = $bindable(false),
    harness,
    name,
    agent = undefined,
    hint = undefined,
    authMethods = [],
    store,
    connect,
    onOpenNanoAccount,
    onModelSourcesChange,
    onSecrets,
  }: Props = $props();

  const guide = $derived(connect.guide(harness));
  const safeMode = $derived(store.safeMode);
  // The row's current state, so "Check again" shows its result here too.
  const current = $derived(store.registry?.harnesses.find((entry) => entry.harness === harness));
  const status = $derived(current === undefined ? undefined : rowStatus(current.state, safeMode));
  const checking = $derived(store.busy === `check:${harness}`);
  const locked = $derived(safeMode || store.busy !== '');

  let copied = $state(false);
  let commandElement = $state<HTMLElement | null>(null);

  $effect(() => {
    if (open) {
      connect.reset();
      copied = false;
    }
  });

  $effect(() => {
    if (!copied) return;
    const timer = setTimeout(() => (copied = false), 2000);
    return () => clearTimeout(timer);
  });

  /** The Clipboard API can be refused; then the command is selected for the user to copy. */
  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      if (commandElement === null) return;
      const range = document.createRange();
      range.selectNodeContents(commandElement);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  function openNanoAccount(): void {
    open = false;
    onOpenNanoAccount();
  }

  function chooseSecrets(target: AcpAgentEntryV1): void {
    open = false;
    onSecrets(target);
  }
</script>

<Dialog
  bind:open
  title={$t('Connect {0}', [name])}
  description={guide.kind === 'nano' ? undefined : $t('{0} signs in with its own tools. Nano Desktop never sees its credentials.', [name])}
  closeLabel={$t('Close')}
>
  {#if safeMode}
    <p class="note" role="status">{$t('Safe mode is on: Nano Desktop starts no agent program.')}</p>
  {/if}

  <div class="body">
    {#if guide.kind === 'nano'}
      <Button block onclick={openNanoAccount}>
        {$t('Open Nano account')}
        {#snippet trailing()}<ArrowRight />{/snippet}
      </Button>
      {#if !safeMode}<NanoProviderSettings onChange={onModelSourcesChange} />{/if}
    {:else if guide.kind === 'terminal'}
      {@const info = guide.info}
      <div class="command">
        <code bind:this={commandElement}>{info.command}</code>
        <Button size="sm" variant="ghost" onclick={() => void copy(info.command)}>
          {#snippet leading()}{#if copied}<Check />{:else}<Copy />{/if}{/snippet}
          {copied ? $t('Copied') : $t('Copy command')}
        </Button>
      </div>
      {#if info.then}
        <p class="detail">
          {#each copyParts($t('Then type {0} there.')) as part, index (index)}{#if part.code === 0}<code>{info.then}</code>{:else}{part.text}{/if}{/each}
        </p>
      {/if}
      {#if info.terminal && !safeMode}
        <div class="actions">
          <Button variant="primary" loading={connect.busy} onclick={() => void connect.open(info.harness)}>
            {#snippet leading()}<SquareTerminal />{/snippet}
            {$t('Open terminal')}
          </Button>
        </div>
      {/if}
      {#if connect.error}
        <p class="problem" role="alert">{$t(connect.error)}</p>
      {:else if connect.opened === info.harness}
        <p class="detail" role="status">{$t('Finish signing in in the terminal, then check again.')}</p>
      {:else}
        <p class="detail">{$t('Sign in with {0}’s own tools in a terminal, then check again.', [name])}</p>
      {/if}
    {:else if guide.kind === 'acp'}
      <p class="detail">{hint ? $t(hint) : $t('Sign in with {0}’s own tools in a terminal, then check again.', [name])}</p>
      {#if authMethods.length > 0}<p class="detail">{$t('The agent offers: {0}.', [authMethods.join(', ')])}</p>{/if}
      {#if agent !== undefined && canChooseSecrets(agent)}
        {@const target = agent}
        <div class="actions">
          <Button disabled={locked} onclick={() => chooseSecrets(target)}>{$t('Secret variables…')}</Button>
        </div>
      {/if}
    {:else}
      <p class="detail">{hint ? $t(hint) : $t('Sign in with {0}’s own tools in a terminal, then check again.', [name])}</p>
    {/if}
  </div>

  {#snippet footer()}
    {#if status !== undefined}
      <span class="state" aria-live="polite">
        <StatusDot status={status.dot} />
        <span>{$t(status.label)}</span>
      </span>
    {/if}
    <Button variant="ghost" disabled={locked} loading={checking} onclick={() => void store.check(harness)}>
      {#snippet leading()}<RefreshCw />{/snippet}
      {$t('Check again')}
    </Button>
    <Button variant="primary" onclick={() => (open = false)}>{$t('Done')}</Button>
  {/snippet}
</Dialog>

<style>
  .body {
    display: grid;
    gap: var(--piui-space-4);
  }
  .note {
    margin: 0 0 var(--piui-space-4);
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-info-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-info-surface);
    color: var(--piui-info-text);
  }
  .command {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
    padding: var(--piui-space-2) var(--piui-space-2) var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
  }
  code {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-md);
    overflow-wrap: anywhere;
  }
  p {
    margin: 0;
  }
  .detail {
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .detail code {
    color: var(--piui-text);
    font-size: 0.95em;
  }
  .problem {
    color: var(--piui-danger-text);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: var(--piui-space-2);
    margin-right: auto;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
