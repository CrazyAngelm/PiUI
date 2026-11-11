<script lang="ts">
  import { onMount } from 'svelte';
  import CreditCard from '@lucide/svelte/icons/credit-card';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Lock from '@lucide/svelte/icons/lock';
  import LogIn from '@lucide/svelte/icons/log-in';
  import LogOut from '@lucide/svelte/icons/log-out';
  import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { language, t } from '../../features/locale/language';
  import { NANO_ACCOUNT_ERROR_COPY } from '../../host-api/nanoAccountClient';
  import { Badge, Button, Skeleton, Spinner, Switch } from '../../lib/ui';
  import { nanoAccount as sharedAccount, type NanoAccount } from '../nano/nanoAccount.svelte';
  import { nanoPetPreference } from '../nano/nanoPetPreference.svelte';
  import { NANO_TIER_COPY, creditsFraction, creditsLevel, creditsText, lockCopy, retryAction } from '../nano/nanoView';

  interface Props {
    /** Safe mode: Nano is not contacted, so only the local sign-out is offered. */
    safeMode: boolean;
    /** Test seam; the settings page uses the application's account. */
    account?: NanoAccount;
    /** Opens Settings → About, where updates live (a too-old client is told to update). */
    onOpenUpdates?: () => void;
  }
  let { safeMode, account = sharedAccount, onOpenUpdates = () => {} }: Props = $props();

  const status = $derived(account.status);
  const accountState = $derived(account.state);
  const entitlements = $derived(account.entitlements);
  const credits = $derived(account.credits);
  const locale = $derived($language === 'ru' ? 'ru-RU' : 'en-US');
  const busy = $derived(account.action !== undefined);
  const level = $derived(credits ? creditsLevel(credits) : 'ok');
  const fraction = $derived(credits ? creditsFraction(credits) : undefined);
  const tooOld = $derived(status?.lastError === 'client-too-old');
  // Failed actions always show; the host's last error only where the state has no text of its own.
  const notice = $derived(
    account.error ??
      (status?.lastError && (accountState === 'signed-out' || accountState === 'signed-in') ? NANO_ACCOUNT_ERROR_COPY[status.lastError] : undefined),
  );

  /** The saved sign-in was just forgotten (safe mode: the host cannot say whether one existed). */
  let forgotten = $state(false);

  onMount(() => {
    void account.start();
  });

  const forgetSignIn = (): void => {
    void account.signOut().then((done) => {
      forgotten = done;
    });
  };

  function formatDate(iso: string | null | undefined): string {
    const time = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(time) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(time) : '';
  }

  const switchWorkspace = (event: Event & { currentTarget: HTMLSelectElement }): void => {
    const select = event.currentTarget;
    void account.selectWorkspace(select.value).then((done) => {
      // A refused switch snaps the select back to the workspace the host kept.
      if (!done) select.value = account.status?.selectedWorkspaceId ?? '';
    });
  };
</script>

<div class="title-row">
  <h2>{$t('Nano account')}</h2>
  {#if status?.server.development}
    <Badge tone="warning" title={status.server.origin}>{$t('Development server')}</Badge>
  {/if}
</div>

{#if notice}
  <p class="notice notice--error" role="alert"><TriangleAlert size={14} /> <span>{$t(notice)}</span></p>
{/if}

{#if safeMode}
  <!-- The host refuses every Nano action in safe mode except the local sign-out, which makes no network call. -->
  <p class="lead">{$t('Safe mode is on: Nano is not contacted. You can still forget the sign-in saved on this computer.')}</p>
  <div class="actions">
    <Button onclick={forgetSignIn} loading={account.action === 'sign-out'} disabled={busy}>
      {#snippet leading()}<LogOut />{/snippet}
      {$t('Forget saved sign-in')}
    </Button>
  </div>
  {#if forgotten}
    <p class="lead forgotten" role="status">{$t('The saved sign-in was removed.')}</p>
  {/if}
{:else if status === undefined}
  <div class="loading" aria-busy="true"><Skeleton lines={3} /></div>
{:else if accountState === 'signed-out'}
  <p class="lead">{$t('Sign in to use Nano models, dictation and your cloud agent. Only account requests, the messages of Nano chats and the audio you dictate leave this computer; your history stays here.')}</p>
  <div class="actions">
    <Button variant="primary" onclick={() => void account.signIn()} loading={account.action === 'sign-in'} disabled={busy}>
      {#snippet leading()}<LogIn />{/snippet}
      {$t('Sign in')}
    </Button>
    <Button variant="ghost" onclick={() => void account.openLink('signup')} disabled={busy}>
      {#snippet trailing()}<ExternalLink />{/snippet}
      {$t('Create account')}
    </Button>
  </div>
{:else if accountState === 'signing-in'}
  <p class="lead waiting" role="status"><Spinner size={14} /> {$t('Finish signing in in your browser.')}</p>
  <div class="actions">
    <Button onclick={() => void account.cancelSignIn()} loading={account.action === 'cancel'} disabled={busy}>{$t('Cancel')}</Button>
  </div>
{:else if accountState === 'expired'}
  <p class="lead">{$t('Your sign-in ended. Sign in again to keep using Nano; your local chats stay on this computer.')}</p>
  <div class="actions">
    <Button variant="primary" onclick={() => void account.signIn()} loading={account.action === 'sign-in'} disabled={busy}>
      {#snippet leading()}<LogIn />{/snippet}
      {$t('Sign in again')}
    </Button>
  </div>
{:else if accountState === 'unsupported'}
  <p class="lead">{$t(tooOld ? NANO_ACCOUNT_ERROR_COPY['client-too-old'] : NANO_ACCOUNT_ERROR_COPY['unsupported-server'])}</p>
  <div class="actions">
    {#if tooOld}
      <Button variant="primary" onclick={onOpenUpdates}>{$t('Check for updates')}</Button>
    {:else}
      {@const retry = retryAction(status)}
      <!-- Without a known person there is no saved credential to refresh: the retry is the sign-in. -->
      <Button onclick={() => void (retry === 'sign-in' ? account.signIn() : account.refresh())} loading={account.action === retry} disabled={busy}>
        {#snippet leading()}<RefreshCw />{/snippet}
        {$t('Try again')}
      </Button>
    {/if}
  </div>
{:else}
  <!-- signed-in and offline both know the person; offline cannot show fresh numbers. -->
  <div class="rows">
    <div class="row">
      <div class="row__text">
        <strong>{status.user?.displayName ?? $t('Nano account')}</strong>
        {#if status.user?.email}<small>{status.user.email}</small>{/if}
      </div>
      {#if accountState === 'offline'}<Badge tone="warning">{$t('Offline')}</Badge>{/if}
    </div>

    {#if accountState === 'offline'}
      <div class="row">
        <span>{$t('Nano could not be reached. You stay signed in; try again when you are online.')}</span>
        <Button size="sm" onclick={() => void account.refresh()} loading={account.action === 'refresh'} disabled={busy}>
          {#snippet leading()}<RefreshCw />{/snippet}
          {$t('Try again')}
        </Button>
      </div>
    {/if}

    {#if status.workspaces.length > 1}
      <div class="row">
        <label for="nano-workspace">{$t('Workspace')}</label>
        <select id="nano-workspace" class="select" value={status.selectedWorkspaceId ?? ''} disabled={busy || accountState === 'offline'} onchange={switchWorkspace}>
          {#each status.workspaces as workspace (workspace.id)}
            <option value={workspace.id}>{workspace.name}</option>
          {/each}
        </select>
      </div>
    {/if}

    {#if entitlements}
      <div class="row">
        <span>{$t('Plan')}</span>
        <span class="plan">
          <strong>{entitlements.plan.name}</strong>
          {#if entitlements.plan.renewsAt}<small>{$t('Renews {0}', [formatDate(entitlements.plan.renewsAt)])}</small>{/if}
        </span>
      </div>
      {#if credits}
        <div class="row row--gauge">
          <div class="gauge">
            <div class="gauge__head">
              <span>{$t('Credits')}</span>
              <span class="gauge__value" data-level={level}>
                {credits.included === null
                  ? $t('{0} credits left', [creditsText(Math.max(0, credits.balance), locale)])
                  : $t('{0} of {1} credits left', [creditsText(Math.max(0, credits.balance), locale), creditsText(credits.included, locale)])}
              </span>
            </div>
            {#if fraction !== undefined && credits.included !== null}
              <!-- A native progress element: no inline styles under the desktop CSP. -->
              <progress class="gauge__bar" data-level={level} max={credits.included} value={Math.max(0, Math.min(credits.balance, credits.included))} aria-label={$t('Credits')}></progress>
            {/if}
          </div>
          <Button size="sm" variant="ghost" onclick={() => void account.refresh()} loading={account.action === 'refresh'} disabled={busy || accountState === 'offline'}>
            {#snippet leading()}<RefreshCw />{/snippet}
            {$t('Refresh')}
          </Button>
        </div>
      {/if}
    {:else if accountState === 'signed-in'}
      <div class="row"><Skeleton lines={2} /></div>
    {/if}
  </div>

  {#if entitlements && entitlements.modes.length > 0}
    <h3>{$t('Modes')}</h3>
    <ul class="modes rows">
      {#each entitlements.modes as mode (mode.id)}
        {@const locked = lockCopy(mode)}
        <li class="row mode" class:mode--locked={locked !== undefined}>
          <div class="row__text">
            <span class="mode__name">
              <strong>{mode.name}</strong>
              <Badge>{$t(NANO_TIER_COPY[mode.tier])}</Badge>
            </span>
            {#if mode.costHint}<small>{mode.costHint}</small>{/if}
          </div>
          {#if locked}<span class="mode__lock"><Lock size={13} /> {$t(locked)}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if status.credentialStore === 'memory'}
    <p class="notice notice--warning" role="status">
      <TriangleAlert size={14} />
      <span>{$t('Your sign-in is kept in memory only. The system credential store could not be used, so you will have to sign in again after Nano Desktop closes.')}</span>
    </p>
  {/if}

  <div class="actions">
    <Button onclick={() => void account.openLink('billing')} disabled={busy || accountState === 'offline'}>
      {#snippet leading()}<CreditCard />{/snippet}
      {$t('Manage plan')}
    </Button>
    <Button onclick={() => void account.openLink('devices')} disabled={busy || accountState === 'offline'}>
      {#snippet leading()}<MonitorSmartphone />{/snippet}
      {$t('Devices')}
    </Button>
    <Button variant="ghost" onclick={() => void account.signOut()} loading={account.action === 'sign-out'} disabled={busy}>
      {#snippet leading()}<LogOut />{/snippet}
      {$t('Sign out')}
    </Button>
  </div>
{/if}

<div class="rows pet">
  <div class="row">
    <span>{$t('Show Nano avatar')}</span>
    <Switch label={$t('Show Nano avatar')} hideLabel checked={nanoPetPreference.enabled} onCheckedChange={(checked: boolean) => nanoPetPreference.set(checked)} />
  </div>
</div>

<style>
  h2 {
    margin: 0;
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  h3 {
    margin: var(--piui-space-6) 0 var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    margin-bottom: var(--piui-space-4);
  }
  .lead {
    margin: 0 0 var(--piui-space-4);
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .forgotten {
    margin: var(--piui-space-3) 0 0;
  }
  .waiting {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    color: var(--piui-text);
  }
  .loading {
    padding: var(--piui-space-2) 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
    margin-top: var(--piui-space-4);
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
  .row__text small,
  .plan small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .plan {
    display: grid;
    justify-items: end;
    gap: 2px;
  }
  .pet {
    margin-top: var(--piui-space-6);
  }
  .select {
    min-width: 180px;
    height: var(--piui-control-md);
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
  }
  .select option {
    background: var(--piui-bg-raised);
    color: var(--piui-text);
  }
  .select:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .select:disabled {
    opacity: 0.5;
  }
  .row--gauge {
    align-items: end;
  }
  .gauge {
    display: grid;
    flex: 1;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .gauge__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--piui-space-3);
  }
  .gauge__value {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    font-variant-numeric: tabular-nums;
  }
  .gauge__value[data-level='low'] {
    color: var(--piui-warning);
  }
  .gauge__value[data-level='empty'] {
    color: var(--piui-danger);
  }
  /* The credit gauge is the screen's one chaos accent: a slanted crimson-to-gold bar. */
  .gauge__bar {
    appearance: none;
    width: 100%;
    height: 8px;
    border: 0;
    background: var(--piui-surface-3);
    clip-path: polygon(0 0, 100% 0, 99% 100%, 0 100%);
    overflow: hidden;
  }
  .gauge__bar::-webkit-progress-bar {
    background: var(--piui-surface-3);
  }
  .gauge__bar::-webkit-progress-value {
    background: linear-gradient(90deg, var(--piui-chaos), var(--piui-chaos-gold));
  }
  .gauge__bar::-moz-progress-bar {
    background: linear-gradient(90deg, var(--piui-chaos), var(--piui-chaos-gold));
  }
  .gauge__bar[data-level='low']::-webkit-progress-value {
    background: var(--piui-warning);
  }
  .gauge__bar[data-level='low']::-moz-progress-bar {
    background: var(--piui-warning);
  }
  .gauge__bar[data-level='empty']::-webkit-progress-value {
    background: var(--piui-danger);
  }
  .gauge__bar[data-level='empty']::-moz-progress-bar {
    background: var(--piui-danger);
  }
  .mode__name {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .mode--locked .mode__name {
    color: var(--piui-text-muted);
  }
  .mode__lock {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .notice {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
    margin: var(--piui-space-4) 0 0;
    padding: var(--piui-space-2) var(--piui-space-3);
    border-radius: var(--piui-radius-sm);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .notice :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .notice--error {
    margin: 0 0 var(--piui-space-4);
    border: 1px solid var(--piui-danger-border);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
  }
  .notice--warning {
    border: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
  }
</style>
