<script lang="ts">
  import { onMount } from 'svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { language, t } from '../../features/locale/language';
  import type { NanoRemoteUnavailableV1 } from '../../host-api/nanoRemoteClient';
  import { Badge, Button, Skeleton, Spinner, Switch } from '../../lib/ui';
  import { nanoRemote as sharedRemote, type NanoRemote } from '../nano/nanoRemote.svelte';

  interface Props {
    /** Safe mode: the host opens no link, so the switch is off and unavailable. */
    safeMode: boolean;
    /** Test seam; the settings page uses the application's remote access state. */
    remote?: NanoRemote;
  }
  let { safeMode, remote = sharedRemote }: Props = $props();

  const UNAVAILABLE_COPY: Readonly<Record<NanoRemoteUnavailableV1, string>> = {
    'safe-mode': 'Not available in safe mode.',
    'signed-out': 'Sign in to use remote access.',
    'unsupported-server': 'This Nano server does not support remote access yet.',
  };

  const status = $derived(remote.status);
  const locale = $derived($language === 'ru' ? 'ru-RU' : 'en-US');
  const busy = $derived(remote.action !== undefined);
  const reason = $derived(safeMode ? 'safe-mode' : (status?.unavailable ?? undefined));
  const link = $derived(status?.link ?? 'off');
  const viewers = $derived(remote.viewers);
  const browsers = $derived(status?.browsers ?? []);
  const waiting = $derived(status !== undefined && reason === undefined && status.enabled && link === 'online' && viewers.length === 0);
  const connecting = $derived(status !== undefined && reason === undefined && status.enabled && (link === 'connecting' || link === 'retrying'));
  const refused = $derived(status !== undefined && reason === undefined && status.enabled && link === 'refused');

  /**
   * The switch's own state: it follows the host, is set at once by a click, and
   * snaps back when the host refuses. Derived (not an effect) so the first
   * render already shows the host's answer.
   */
  let on = $derived(!safeMode && (status?.enabled ?? false));

  onMount(() => {
    void remote.start();
  });

  const toggle = (checked: boolean): void => {
    void remote.setEnabled(checked).then((done) => {
      if (!done) on = !safeMode && (remote.status?.enabled ?? false);
    });
  };

  function formatDate(iso: string | null | undefined): string {
    const time = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(time) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(time) : '';
  }
</script>

<div class="remote">
  {#if remote.error}
    <p class="notice" role="alert"><TriangleAlert size={14} /> <span>{$t(remote.error)}</span></p>
  {/if}

  {#if !safeMode && status === undefined}
    {#if remote.error}
      <div class="actions">
        <Button size="sm" onclick={() => void remote.start()}>
          {#snippet leading()}<RefreshCw />{/snippet}
          {$t('Try again')}
        </Button>
      </div>
    {:else}
      <div class="loading" aria-busy="true"><Skeleton lines={2} /></div>
    {/if}
  {:else}
    <div class="rows">
      <div class="row">
        <div class="row__text">
          <strong>{$t('Allow remote access from Nano Web')}</strong>
          <small>
            {reason !== undefined
              ? $t(UNAVAILABLE_COPY[reason])
              : $t('Browsers you approve on this computer can open your chats here, send messages and answer approvals. While one is connected, your chat list and the content of all open chats pass through Nano\'s server to it and are not stored there.')}
          </small>
        </div>
        <Switch
          label={$t('Allow remote access from Nano Web')}
          hideLabel
          bind:checked={on}
          disabled={reason !== undefined || busy}
          onCheckedChange={toggle}
        />
      </div>

      {#if waiting}
        <div class="row row--status" role="status"><span>{$t('Waiting for connections')}</span></div>
      {:else if connecting}
        <div class="row row--status" role="status"><Spinner size={14} /> <span>{$t('Connecting…')}</span></div>
      {:else if refused}
        <div class="row row--status row--warning" role="status"><TriangleAlert size={14} /> <span>{$t('The Nano server refused remote access.')}</span></div>
      {/if}
    </div>

    {#if viewers.length > 0}
      <h3>{$t('Connected now')}</h3>
      <ul class="rows" aria-label={$t('Connected now')}>
        {#each viewers as viewer (viewer.id)}
          <li class="row">
            <div class="row__text">
              <span class="name">
                <strong title={viewer.fingerprint}>{viewer.label}</strong>
                {#if viewer.grant === 'once'}<Badge>{$t('Allowed once')}</Badge>{/if}
              </span>
            </div>
            <Button size="sm" aria-label={$t('Disconnect {0}', [viewer.label])} onclick={() => void remote.kick(viewer.id)} disabled={busy}>
              {$t('Disconnect')}
            </Button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if browsers.length > 0}
      <h3>{$t('Allowed browsers')}</h3>
      <ul class="rows" aria-label={$t('Allowed browsers')}>
        {#each browsers as browser (browser.id)}
          <li class="row">
            <div class="row__text">
              <strong title={browser.fingerprint}>{browser.label}</strong>
              <small>
                {$t('Added {0}', [formatDate(browser.createdAt)])}{#if browser.lastUsedAt} · {$t('Last used {0}', [formatDate(browser.lastUsedAt)])}{/if}
              </small>
            </div>
            <Button size="sm" aria-label={$t('Remove {0}', [browser.label])} onclick={() => void remote.forget(browser.id)} disabled={busy}>
              {$t('Remove')}
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .remote {
    margin-top: var(--piui-space-6);
  }
  h3 {
    margin: var(--piui-space-6) 0 var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  .loading {
    padding: var(--piui-space-2) 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
    margin-top: var(--piui-space-3);
  }
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-4);
    padding: var(--piui-space-3) var(--piui-space-4);
  }
  .row + .row {
    border-top: 1px solid var(--piui-border-subtle);
  }
  .row__text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .row__text small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .row__text strong {
    overflow-wrap: anywhere;
  }
  .name {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .row--status {
    justify-content: flex-start;
    gap: var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .row--warning {
    color: var(--piui-warning);
  }
  .notice {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
    margin: 0 0 var(--piui-space-3);
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .notice :global(svg) {
    flex: none;
    margin-top: 2px;
  }
</style>
