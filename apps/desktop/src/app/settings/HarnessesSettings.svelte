<script lang="ts">
  import { onMount } from 'svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Plus from '@lucide/svelte/icons/plus';
  import type { AcpAgentEntryV1 } from '../../../../../contracts/harness-registry-v1';
  import { t } from '../../features/locale/language';
  import { Badge, Button, Skeleton } from '../../lib/ui';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import AcpAgentCard from './AcpAgentCard.svelte';
  import AcpConfirmDialog from './AcpConfirmDialog.svelte';
  import AcpSecretsDialog from './AcpSecretsDialog.svelte';
  import AddAcpAgentDialog from './AddAcpAgentDialog.svelte';
  import TrustAcpAgentDialog from './TrustAcpAgentDialog.svelte';
  import { stateBadge } from './acpAgents';
  import { HarnessesStore } from './harnessesStore.svelte';

  /**
   * Settings → Harnesses (ADR-034): readiness of every harness and the ACP
   * agent registry. Loaded after mount; checks never block first paint.
   */
  interface Props {
    /** Injected by tests; the section owns its store otherwise. */
    store?: HarnessesStore;
  }
  let { store = new HarnessesStore() }: Props = $props();

  onMount(() => {
    void store.start();
    return () => store.dispose();
  });

  type Pending =
    | { kind: 'trust'; agent: AcpAgentEntryV1 }
    | { kind: 'version'; agent: AcpAgentEntryV1; version: string }
    | { kind: 'secrets'; agent: AcpAgentEntryV1 }
    | { kind: 'remove'; agent: AcpAgentEntryV1 };

  // Each dialog reviews a snapshot taken when it opened; the host rejects a
  // decision about anything that changed since (fingerprint, command, revision).
  let pending = $state.raw<Pending>();
  let dialogOpen = $state(false);
  let adding = $state(false);
  let dialogError = $state<string>();

  const locked = $derived(store.safeMode || store.busy !== '');

  function open(next: Pending): void {
    pending = next;
    dialogError = undefined;
    dialogOpen = true;
  }

  function close(): void {
    dialogOpen = false;
  }

  /** After a rejected decision: review the agent as it is now, or close when it is gone. */
  function review(): void {
    const current = pending === undefined ? undefined : store.agent(pending.agent.descriptor.id);
    if (pending === undefined || current === undefined) {
      close();
      return;
    }
    dialogError = undefined;
    pending = pending.kind === 'version' ? { ...pending, agent: current, version: current.version ?? pending.version } : { ...pending, agent: current };
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
    <Button size="sm" onclick={() => void store.check()} loading={store.busy === 'check'} disabled={locked}>
      {#snippet leading()}<RefreshCw />{/snippet}
      {$t('Check again')}
    </Button>
  </div>
  <p class="lead">{$t('PiUI drives the agent tools installed on this computer. Each harness keeps its own sign-in, models and history.')}</p>
  {#if store.safeMode}
    <p class="note" role="status">{$t('Safe mode: PiUI starts no agent program, so harness checks and changes are off.')}</p>
  {/if}
  {#if store.error}<p class="error" role="alert">{$t(store.error)}</p>{/if}

  {#if store.registry === undefined}
    {#if store.loading}
      <div class="loading" role="status"><span class="visually-hidden">{$t('Loading harnesses…')}</span><Skeleton lines={3} height="16px" /></div>
    {/if}
  {:else}
    <ul class="cards" aria-label={$t('Built-in harnesses')}>
      {#each store.builtins as harness (harness.harness)}
        {@const badge = stateBadge(harness.state, store.safeMode)}
        <li class="card">
          <HarnessMark kind={harness.harness} size={28} />
          <div class="card__main">
            <div class="card__title">
              <strong>{harness.name}</strong>
              {#if harness.version}<span class="muted">v{harness.version}</span>{/if}
              <Badge tone={badge.tone}>{$t(badge.label)}</Badge>
            </div>
            {#if harness.reason}<p class="muted">{$t(harness.reason)}</p>{/if}
            {#if harness.location || harness.verifiedVersions || harness.signInHint}
              <dl class="facts">
                {#if harness.location}<div><dt>{$t('Location')}</dt><dd><code>{harness.location}</code></dd></div>{/if}
                {#if harness.verifiedVersions}<div><dt>{$t('Tested with PiUI')}</dt><dd>{harness.verifiedVersions}</dd></div>{/if}
                {#if harness.signInHint}<div><dt>{$t('Sign-in')}</dt><dd>{$t(harness.signInHint)}</dd></div>{/if}
              </dl>
            {/if}
          </div>
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
    <p class="lead">{$t('Agents that speak the Agent Client Protocol. PiUI starts only the exact command line you trust, never through a shell. Trust is not a sandbox: an agent runs with your permissions.')}</p>
    <ul class="cards" aria-labelledby="acp-agents-title">
      {#each store.agents as row (row.agent.descriptor.id)}
        <AcpAgentCard
          {row}
          {store}
          onTrust={(agent) => open({ kind: 'trust', agent })}
          onConfirmVersion={(agent) => open({ kind: 'version', agent, version: agent.version ?? '' })}
          onSecrets={(agent) => open({ kind: 'secrets', agent })}
          onRemove={(agent) => open({ kind: 'remove', agent })}
        />
      {/each}
    </ul>
  {/if}
  <p class="muted small">{$t('Sign in inside each harness (for example in its terminal app). PiUI never reads or stores credentials.')}</p>
</div>

<AddAcpAgentDialog bind:open={adding} {store} onAdded={added} />

{#if pending?.kind === 'trust'}
  <TrustAcpAgentDialog
    bind:open={dialogOpen}
    agent={pending.agent}
    busy={store.busy.startsWith('trust:')}
    error={dialogError}
    onTrust={(agent) => void decide(() => store.trust(agent))}
    onReview={review}
  />
{:else if pending?.kind === 'version'}
  {@const target = pending}
  <AcpConfirmDialog
    bind:open={dialogOpen}
    title={$t('Use {0} {1}?', [target.agent.descriptor.displayName, target.version])}
    confirmLabel={$t('Use this version')}
    busy={store.busy.startsWith('version:')}
    error={dialogError}
    onConfirm={() => void decide(() => store.confirmVersion(target.agent, target.version))}
  >
    <p>{$t('PiUI has not verified this version with this agent. It may use the protocol differently than PiUI expects.')}</p>
    <p class="muted">{$t('The confirmation covers only version {0}. An update needs a new confirmation.', [target.version])}</p>
  </AcpConfirmDialog>
{:else if pending?.kind === 'secrets'}
  <AcpSecretsDialog
    bind:open={dialogOpen}
    agent={pending.agent}
    busy={store.busy.startsWith('secrets:')}
    error={dialogError}
    onSave={(agent, names) => void decide(() => store.allowSecrets(agent, names))}
  />
{:else if pending?.kind === 'remove'}
  {@const target = pending}
  <AcpConfirmDialog
    bind:open={dialogOpen}
    title={$t('Remove {0}?', [target.agent.descriptor.displayName])}
    confirmLabel={$t('Remove agent')}
    confirmVariant="danger"
    busy={store.busy.startsWith('remove:')}
    error={dialogError}
    onConfirm={() => void decide(() => store.remove(target.agent))}
  >
    <p>{$t('PiUI forgets this descriptor and your decisions about it. Chats with this agent keep their history but cannot start until you add it again.')}</p>
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
  }
  .title-row--section {
    margin-top: var(--piui-space-8);
  }
  .lead {
    margin: var(--piui-space-2) 0 var(--piui-space-4);
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
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
  .cards {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-3);
    padding: var(--piui-space-3) var(--piui-space-4);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .card__main {
    display: grid;
    flex: 1;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .card__title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 28px;
  }
  .card p {
    margin: 0;
  }
  .facts {
    display: grid;
    gap: 4px;
    margin: 0;
    font-size: var(--piui-text-sm);
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
  .muted {
    color: var(--piui-text-muted);
  }
  .small {
    margin-top: var(--piui-space-4);
    font-size: var(--piui-text-sm);
  }
</style>
