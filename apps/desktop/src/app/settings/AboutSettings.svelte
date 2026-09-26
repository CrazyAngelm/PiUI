<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Download from '@lucide/svelte/icons/download';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { language, t } from '../../features/locale/language';
  import { APP_UPDATE_ERROR_COPY, appUpdateHost, type AppUpdateClient } from '../../host-api/appUpdateClient';
  import { Button, Dialog, Switch } from '../../lib/ui';
  import { AppUpdates, megabytes, progressPercent } from './appUpdates.svelte';

  interface Props {
    safeMode: boolean;
    /** Test seam; the desktop uses the transport-backed client. */
    client?: AppUpdateClient;
    /** Test seam: state that already loaded. */
    updates?: AppUpdates;
  }
  let { safeMode, client = appUpdateHost, updates: provided = undefined }: Props = $props();
  // The update state lives as long as this settings page.
  const updates = untrack(() => provided ?? new AppUpdates(client));
  let confirming = $state(false);

  const status = $derived(updates.status);
  const offer = $derived(status?.available ?? undefined);
  const lastCheck = $derived(status?.lastCheck ?? undefined);
  const percent = $derived(progressPercent(updates.progress));
  const locale = $derived($language === 'ru' ? 'ru-RU' : 'en-US');
  // Follows the host; a flip the host refused snaps back to the kept value.
  let autoCheck = $derived(status?.autoCheck ?? false);

  onMount(() => {
    if (updates.status === undefined) void updates.load();
    return () => updates.dispose();
  });

  async function toggleAutoCheck(enabled: boolean): Promise<void> {
    if (!(await updates.setAutoCheck(enabled))) autoCheck = updates.status?.autoCheck ?? false;
  }

  function formatDate(iso: string, withTime: boolean): string {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return '';
    return new Intl.DateTimeFormat(locale, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(time);
  }

  async function confirmInstall(): Promise<void> {
    const version = offer?.version;
    confirming = false;
    if (version !== undefined) await updates.install(version);
  }
</script>

<h2>{$t('About')}</h2>
<div class="rows">
  <div class="row"><span>PiUI</span><span class="muted">{status?.currentVersion ?? '…'}</span></div>
  <div class="row"><span>{$t('Safe mode')}</span><span class="muted">{safeMode ? $t('On') : $t('Off')}</span></div>
</div>

{#if updates.visible && status}
  <section class="updates" aria-labelledby="about-updates-title">
    <div class="title-row">
      <h3 id="about-updates-title">{$t('Updates')}</h3>
      <Button size="sm" onclick={() => void updates.check()} loading={updates.action === 'check' || status.phase === 'checking'} disabled={updates.busy}>
        {#snippet leading()}<RefreshCw />{/snippet}
        {$t('Check for updates')}
      </Button>
    </div>

    <p class="state" role="status">
      {#if status.phase === 'checking'}
        {$t('Checking for updates…')}
      {:else if status.phase === 'downloading' && offer}
        {$t('Downloading PiUI {0}…', [offer.version])}
      {:else if status.phase === 'installing' && offer}
        {$t('Installing PiUI {0}. PiUI will restart.', [offer.version])}
      {:else if status.phase === 'restarting'}
        {$t('PiUI is restarting to finish the update.')}
      {:else if status.phase === 'restart-required'}
        {$t('The update did not start. PiUI stopped its agents, so restart it to continue.')}
      {:else if offer}
        {$t('PiUI {0} is available.', [offer.version])}
      {:else if lastCheck?.outcome === 'up-to-date'}
        {$t('PiUI is up to date. Last checked {0}.', [formatDate(lastCheck.at, true)])}
      {:else if lastCheck?.outcome === 'failed'}
        {$t('The last check did not finish ({0}).', [formatDate(lastCheck.at, true)])}
      {:else}
        {$t('Not checked yet.')}
      {/if}
    </p>

    {#if updates.error}
      <p class="error" role="alert"><TriangleAlert size={14} /> {$t(updates.error)}</p>
    {:else if lastCheck?.outcome === 'failed' && lastCheck.error && !offer}
      <p class="muted">{$t(APP_UPDATE_ERROR_COPY[lastCheck.error])}</p>
    {/if}

    {#if status.phase === 'restart-required'}
      <div class="actions">
        <Button onclick={() => void updates.restart()} loading={updates.action === 'restart'}>
          {#snippet leading()}<RotateCcw />{/snippet}
          {$t('Restart PiUI')}
        </Button>
      </div>
    {:else if offer}
      <article class="offer" aria-labelledby="about-offer-title">
        <div class="offer__head">
          <div class="offer__title">
            <strong id="about-offer-title">PiUI {offer.version}</strong>
            {#if offer.date}<span class="muted">{formatDate(offer.date, false)}</span>{/if}
          </div>
          <Button variant="primary" onclick={() => (confirming = true)} loading={updates.action === 'install'} disabled={updates.busy}>
            {#snippet leading()}<Download />{/snippet}
            {$t('Download and restart')}
          </Button>
        </div>
        {#if status.phase === 'downloading'}
          <!-- A native progress element: no inline styles under the desktop CSP. -->
          <progress
            max="100"
            value={percent}
            aria-label={$t('Download progress')}
            aria-valuetext={percent === undefined ? megabytes(updates.progress?.downloadedBytes ?? 0) : `${percent}%`}
          ></progress>
          <p class="muted small">
            {percent === undefined
              ? megabytes(updates.progress?.downloadedBytes ?? 0)
              : `${megabytes(updates.progress?.downloadedBytes ?? 0)} / ${megabytes(updates.progress?.totalBytes ?? 0)}`}
          </p>
        {/if}
        {#if offer.notes}
          <!-- Release notes are plain text from the feed, never HTML. -->
          <div class="notes">{offer.notes}</div>
        {:else}
          <p class="muted">{$t('This release has no notes.')}</p>
        {/if}
      </article>
    {/if}

    <div class="rows">
      <div class="row">
        <div class="row__text">
          <strong>{$t('Check for updates automatically')}</strong>
          <small>{$t('When PiUI starts and once a day. Nothing installs without your confirmation.')}</small>
        </div>
        <Switch
          label={$t('Check for updates automatically')}
          hideLabel
          bind:checked={autoCheck}
          disabled={updates.action === 'auto-check'}
          onCheckedChange={(checked) => void toggleAutoCheck(checked)}
        />
      </div>
    </div>
    <p class="muted small note">
      <ShieldCheck size={14} />
      <span>{$t('PiUI installs an update only after its signature matches the key built into this version. Checks contact {0}.', [status.feedHost ?? ''])}</span>
    </p>
  </section>
{/if}

<p class="muted small">{$t('Local-first: no account, cloud backend or telemetry. Harnesses talk to their own providers.')}</p>

<Dialog
  bind:open={confirming}
  size="sm"
  title={$t('Install PiUI {0}?', [offer?.version ?? ''])}
  description={$t('PiUI downloads the update and checks its signature. Then it stops running chats and pipeline steps as it does when you quit, installs the update and starts again.')}
  closeLabel={$t('Close')}
>
  <p class="muted">{$t('Finish or copy any message you are writing first. Interrupted pipeline steps can be reviewed in Runs after the restart.')}</p>
  {#snippet footer()}
    <Button onclick={() => (confirming = false)}>{$t('Cancel')}</Button>
    <Button variant="primary" onclick={() => void confirmInstall()}>
      {#snippet leading()}<Download />{/snippet}
      {$t('Download and restart')}
    </Button>
  {/snippet}
</Dialog>

<style>
  h2 {
    margin: 0 0 var(--piui-space-4);
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  h3 {
    margin: 0;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
  }
  .rows {
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-4);
    padding: var(--piui-space-2) var(--piui-space-4);
  }
  .row + .row {
    border-top: 1px solid var(--piui-border-subtle);
  }
  .row__text {
    display: grid;
    gap: 2px;
  }
  .row__text small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .updates {
    display: grid;
    gap: var(--piui-space-3);
    margin-top: var(--piui-space-6);
  }
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
  }
  .state,
  .muted,
  .error {
    margin: 0;
  }
  .state {
    line-height: var(--piui-leading-normal);
  }
  .offer {
    display: grid;
    gap: var(--piui-space-3);
    padding: var(--piui-space-3) var(--piui-space-4);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .offer__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
  }
  .offer__title {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--piui-space-2);
  }
  .notes {
    padding: var(--piui-space-2) var(--piui-space-3);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  progress {
    width: 100%;
    height: 6px;
    overflow: hidden;
    border: 0;
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-2);
    color: var(--piui-action);
    appearance: none;
  }
  progress::-webkit-progress-bar {
    background: var(--piui-surface-2);
  }
  progress::-webkit-progress-value {
    background: var(--piui-action);
  }
  progress::-moz-progress-bar {
    background: var(--piui-action);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--piui-space-2);
  }
  .note {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
  }
  .note :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .small {
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  p.small {
    margin-top: var(--piui-space-4);
  }
  .updates p.small {
    margin-top: 0;
  }
  .error {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    color: var(--piui-danger-text);
  }
</style>
