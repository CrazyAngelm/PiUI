<script lang="ts">
  import { onMount, tick } from 'svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Plus from '@lucide/svelte/icons/plus';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import type { AcpAgentEntryV1 } from '../../../../../contracts/harness-registry-v1';
  import { acpAgentId, acpHarnessId, isAcpHarness, type HarnessId } from '../../../../../contracts/harness-identity-v3';
  import { t } from '../../features/locale/language';
  import { Button, Skeleton, StatusDot } from '../../lib/ui';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import AcpAgentCard from './AcpAgentCard.svelte';
  import AcpConfirmDialog from './AcpConfirmDialog.svelte';
  import AcpSecretsDialog from './AcpSecretsDialog.svelte';
  import AddAcpAgentDialog from './AddAcpAgentDialog.svelte';
  import HarnessConnectDialog from './HarnessConnectDialog.svelte';
  import TrustAcpAgentDialog from './TrustAcpAgentDialog.svelte';
  import { nativeVersionStatus, versionBadge } from './acpAgents';
  import { canConnectBuiltin, connectIsPrimary, HarnessConnectStore, rowStatus } from './harnessConnect.svelte';
  import { HarnessesStore } from './harnessesStore.svelte';

  /**
   * Settings → Harnesses (ADR-034): readiness of every harness and the ACP
   * agent registry, one calm list. Each harness signs in with its own tools:
   * Connect (ADR-054) shows how. Loaded after mount; checks never block first
   * paint.
   */
  interface Props {
    /** Injected by tests; the section owns its store otherwise. */
    store?: HarnessesStore;
    connect?: HarnessConnectStore;
    /** Opens Settings → Nano account. */
    onOpenNanoAccount?: () => void;
    /** ChatGPT or an external provider changed: model catalogs are stale. */
    onModelSourcesChange?: () => void;
  }
  let {
    store = new HarnessesStore(),
    connect = new HarnessConnectStore(),
    onOpenNanoAccount = () => {},
    onModelSourcesChange = () => {},
  }: Props = $props();
  const uid = $props.id();

  onMount(() => {
    void store.start();
    void connect.describe();
    return () => {
      store.dispose();
      connect.dispose();
    };
  });

  type Pending =
    | { kind: 'trust'; agent: AcpAgentEntryV1 }
    | { kind: 'secrets'; agent: AcpAgentEntryV1 }
    | { kind: 'remove'; agent: AcpAgentEntryV1 };

  // Each dialog reviews a snapshot taken when it opened; the host rejects a
  // decision about anything that changed since (fingerprint, command, revision).
  let pending = $state.raw<Pending>();
  let dialogOpen = $state(false);
  let adding = $state(false);
  let dialogError = $state<string>();
  // Connect shows the harness as it is now, so only its identity is kept.
  let connecting = $state<HarnessId>();
  let connectOpen = $state(false);

  const locked = $derived(store.safeMode || store.busy !== '');
  const target = $derived.by(() => {
    const harness = connecting;
    if (harness === undefined) return undefined;
    if (isAcpHarness(harness)) {
      const row = store.agents.find((entry) => entry.agent.descriptor.id === acpAgentId(harness));
      if (row === undefined) return undefined;
      return {
        harness,
        name: row.agent.descriptor.displayName,
        agent: row.agent,
        hint: row.status?.signInHint ?? row.agent.descriptor.authHint,
        authMethods: row.agent.authMethods,
      };
    }
    const status = store.builtins.find((entry) => entry.harness === harness);
    if (status === undefined) return undefined;
    return { harness, name: status.name, agent: undefined, hint: status.signInHint, authMethods: [] as string[] };
  });

  function open(next: Pending): void {
    pending = next;
    dialogError = undefined;
    dialogOpen = true;
  }

  function close(): void {
    dialogOpen = false;
  }

  function connectTo(harness: HarnessId): void {
    connecting = harness;
    connectOpen = true;
  }

  /** The Connect dialog closes first; the existing secrets review opens right after. */
  function chooseSecrets(agent: AcpAgentEntryV1): void {
    void tick().then(() => open({ kind: 'secrets', agent }));
  }

  /** After a rejected decision: review the agent as it is now, or close when it is gone. */
  function review(): void {
    const current = pending === undefined ? undefined : store.agent(pending.agent.descriptor.id);
    if (pending === undefined || current === undefined) {
      close();
      return;
    }
    dialogError = undefined;
    pending = { ...pending, agent: current };
  }

  async function decide(action: () => Promise<{ message: string } | undefined>): Promise<void> {
    dialogError = undefined;
    const failure = await action();
    if (failure === undefined) close();
    else dialogError = failure.message;
  }

  function added(id: string): void {
    adding = false;
    // A resolved program goes straight to its review.
    const agent = store.agent(id);
    if (agent?.state === 'untrusted' && agent.commandLine !== undefined) open({ kind: 'trust', agent });
  }
</script>

<div class="harnesses">
  <div class="title-row">
    <h2>{$t('Harnesses')}</h2>
    <Button size="sm" variant="ghost" onclick={() => void store.check()} loading={store.busy === 'check'} disabled={locked}>
      {#snippet leading()}<RefreshCw />{/snippet}
      {$t('Check again')}
    </Button>
  </div>
  {#if store.safeMode}
    <p class="note" role="status">{$t('Safe mode: Nano Desktop starts no agent program, so harness checks and changes are off.')}</p>
  {/if}
  {#if store.error}<p class="error" role="alert">{$t(store.error)}</p>{/if}

  {#if store.registry === undefined}
    {#if store.loading}
      <div class="loading" role="status"><span class="visually-hidden">{$t('Loading harnesses…')}</span><Skeleton lines={3} height="16px" /></div>
    {/if}
  {:else}
    <ul class="rows" aria-label={$t('Built-in harnesses')}>
      {#each store.builtins as harness (harness.harness)}
        {@const status = rowStatus(harness.state, store.safeMode)}
        {@const advisory = versionBadge(nativeVersionStatus(harness))}
        {@const titleId = `${uid}-${harness.harness}`}
        <li class="row">
          <div class="row__line">
            <HarnessMark kind={harness.harness} size={24} />
            <div class="row__name">
              <strong id={titleId}>{harness.name}</strong>
              {#if harness.version}<span class="muted">v{harness.version}</span>{/if}
              {#if advisory}<span class="muted">{$t(advisory.label)}</span>{/if}
            </div>
            <span class="state" class:state--attention={!status.ready && status.dot === 'waiting'} class:state--danger={status.dot === 'failed'}>
              {#if status.ready}
                <StatusDot status={status.dot} label={$t(status.label)} />
              {:else}
                <StatusDot status={status.dot} />
                <span>{$t(status.label)}</span>
              {/if}
            </span>
            {#if canConnectBuiltin(harness.state)}
              <Button
                size="sm"
                variant={connectIsPrimary(harness.state) ? 'primary' : 'secondary'}
                disabled={locked}
                aria-describedby={titleId}
                onclick={() => connectTo(harness.harness)}
              >{$t('Connect')}</Button>
            {/if}
          </div>
          {#if harness.reason}<p class="row__reason muted">{$t(harness.reason)}</p>{/if}
          {#if harness.location || harness.verifiedVersions}
            <details class="row__details">
              <summary><ChevronRight size={12} />{$t('Details')}</summary>
              <dl class="facts">
                {#if harness.location}<div><dt>{$t('Location')}</dt><dd><code>{harness.location}</code></dd></div>{/if}
                {#if harness.verifiedVersions}<div><dt>{$t('Tested with Nano Desktop')}</dt><dd>{harness.verifiedVersions}</dd></div>{/if}
              </dl>
            </details>
          {/if}
        </li>
      {/each}
    </ul>

    <div class="title-row title-row--section">
      <h3 id="acp-agents-title">{$t('ACP agents')}</h3>
      <Button size="sm" onclick={() => (adding = true)} disabled={locked}>
        {#snippet leading()}<Plus />{/snippet}
        {$t('Add ACP agent…')}
      </Button>
    </div>
    {#if store.agents.length > 0}
      <ul class="rows" aria-labelledby="acp-agents-title">
        {#each store.agents as row (row.agent.descriptor.id)}
          <AcpAgentCard
            {row}
            {store}
            onConnect={(agent) => connectTo(acpHarnessId(agent.descriptor.id))}
            onTrust={(agent) => open({ kind: 'trust', agent })}
            onRemove={(agent) => open({ kind: 'remove', agent })}
            onSecrets={(agent) => open({ kind: 'secrets', agent })}
          />
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<AddAcpAgentDialog bind:open={adding} {store} onAdded={added} />

{#if target !== undefined}
  <HarnessConnectDialog
    bind:open={connectOpen}
    harness={target.harness}
    name={target.name}
    agent={target.agent}
    hint={target.hint}
    authMethods={target.authMethods}
    {store}
    {connect}
    {onOpenNanoAccount}
    {onModelSourcesChange}
    onSecrets={chooseSecrets}
  />
{/if}

{#if pending?.kind === 'trust'}
  <TrustAcpAgentDialog
    bind:open={dialogOpen}
    agent={pending.agent}
    busy={store.busy.startsWith('trust:')}
    error={dialogError}
    onTrust={(agent) => void decide(() => store.trust(agent))}
    onReview={review}
  />
{:else if pending?.kind === 'secrets'}
  <AcpSecretsDialog
    bind:open={dialogOpen}
    agent={pending.agent}
    busy={store.busy.startsWith('secrets:')}
    error={dialogError}
    onSave={(agent, names) => void decide(() => store.allowSecrets(agent, names))}
  />
{:else if pending?.kind === 'remove'}
  {@const removing = pending}
  <AcpConfirmDialog
    bind:open={dialogOpen}
    title={$t('Remove {0}?', [removing.agent.descriptor.displayName])}
    confirmLabel={$t('Remove agent')}
    confirmVariant="danger"
    busy={store.busy.startsWith('remove:')}
    error={dialogError}
    onConfirm={() => void decide(() => store.remove(removing.agent))}
  >
    <p>{$t('Nano Desktop forgets this descriptor and your decisions about it. Chats with this agent keep their history but cannot start until you add it again.')}</p>
  </AcpConfirmDialog>
{/if}

<style>
  .harnesses {
    display: grid;
    gap: 0;
    max-width: 720px;
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  h3 {
    margin: 0;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
  }
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
    margin-bottom: var(--piui-space-3);
  }
  .title-row--section {
    margin-top: var(--piui-space-8);
  }
  .note {
    margin: 0 0 var(--piui-space-4);
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-info-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-info-surface);
    color: var(--piui-info-text);
  }
  .error {
    margin: 0 0 var(--piui-space-4);
    color: var(--piui-danger-text);
  }
  .loading {
    padding: var(--piui-space-4) 0;
  }
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .rows > :global(li + li) {
    border-top: 1px solid var(--piui-border-subtle);
  }
  .row {
    display: grid;
    gap: var(--piui-space-1);
    padding: var(--piui-space-3) var(--piui-space-4);
  }
  .row__line {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    min-height: 32px;
  }
  .row__name {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--piui-space-1) var(--piui-space-2);
    min-width: 0;
  }
  .row__name strong {
    font-weight: var(--piui-weight-medium);
  }
  .row__name .muted {
    font-size: var(--piui-text-sm);
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .state--attention {
    color: var(--piui-warning-text);
  }
  .state--danger {
    color: var(--piui-danger-text);
  }
  .row__reason,
  .row__details {
    margin: 0 0 0 calc(24px + var(--piui-space-3));
    font-size: var(--piui-text-sm);
  }
  summary {
    display: inline-flex;
    align-items: center;
    gap: var(--piui-space-1);
    border-radius: var(--piui-radius-sm);
    color: var(--piui-text-muted);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    color: var(--piui-text);
  }
  summary:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 2px;
  }
  summary :global(svg) {
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  details[open] > summary :global(svg) {
    transform: rotate(90deg);
  }
  .facts {
    display: grid;
    gap: 4px;
    margin: var(--piui-space-2) 0 var(--piui-space-1);
  }
  .facts div {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    gap: var(--piui-space-3);
  }
  .facts dt {
    color: var(--piui-text-muted);
  }
  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  code {
    font-family: var(--piui-font-mono);
    font-size: 0.95em;
  }
  p {
    margin: 0;
  }
  .muted {
    color: var(--piui-text-muted);
  }
</style>
