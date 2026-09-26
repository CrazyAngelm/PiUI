<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../features/locale/language';
  import { automationsHost, type AutomationsClient } from '../../host-api/automationsClient';
  import { backgroundError, backgroundHost, type BackgroundClient, type BackgroundSettingsV1, type BackgroundUpdateRequest } from '../../host-api/backgroundClient';
  import { orchestrationError } from '../../host-api/orchestrationClient';
  import { Skeleton, Switch } from '../../lib/ui';

  interface Props {
    client?: BackgroundClient;
    automations?: AutomationsClient;
  }
  let { client = backgroundHost, automations = automationsHost }: Props = $props();

  let settings = $state.raw<BackgroundSettingsV1 | undefined>();
  let paused = $state(false);
  let busy = $state('');
  let error = $state('');

  const windows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  const readOnly = $derived(settings?.readOnly ?? true);

  onMount(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void client
      .settings()
      .then((value) => (settings = value))
      .catch((cause: unknown) => (error = backgroundError(cause).message));
    void automations
      .state()
      .then((value) => (paused = value.paused))
      .catch(() => {
        // An older host has no switch; the row stays off.
      });
    void automations
      .listen((event) => (paused = event.paused))
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  });

  async function change(key: keyof BackgroundUpdateRequest, value: boolean): Promise<void> {
    if (busy) return;
    busy = key;
    error = '';
    try {
      settings = await client.update({ [key]: value });
    } catch (cause) {
      error = backgroundError(cause).message;
      // Show what is really in effect after a refusal.
      settings = await client.settings().catch(() => settings);
    } finally {
      busy = '';
    }
  }

  async function pause(value: boolean): Promise<void> {
    if (busy) return;
    busy = 'paused';
    error = '';
    try {
      paused = (await automations.setPaused(value)).paused;
    } catch (cause) {
      error = orchestrationError(cause).message;
    } finally {
      busy = '';
    }
  }
</script>

<h2>{$t('Background')}</h2>
<p class="lead">{$t('Automations keep running while PiUI is in the tray. Scheduled runs can use your paid plans.')}</p>
{#if !settings && !error}
  <Skeleton lines={3} />
{:else}
  {#if settings?.readOnly}<p class="note" role="status">{$t('Safe mode keeps background settings read-only.')}</p>{/if}
  <div class="rows">
    <div class="row">
      <div>
        <strong>{$t('Keep running in the tray when the window is closed')}</strong>
        <small>{$t('Closing the window hides PiUI in the tray. Quit from the tray menu stops PiUI and every agent it started.')}</small>
      </div>
      <Switch
        label={$t('Keep running in the tray when the window is closed')}
        hideLabel
        checked={settings?.keepInTray ?? false}
        disabled={readOnly || busy !== '' || !(settings?.trayAvailable ?? false)}
        onCheckedChange={(value) => void change('keepInTray', value)}
      />
    </div>
    <div class="row">
      <div>
        <strong>{windows ? $t('Start PiUI when I sign in to Windows') : $t('Start PiUI when I sign in')}</strong>
        <small>
          {settings?.launchAtLoginAvailable === false
            ? $t('Not available in this build.')
            : $t('PiUI starts in the tray when the option above is on; otherwise it opens its window.')}
        </small>
      </div>
      <Switch
        label={windows ? $t('Start PiUI when I sign in to Windows') : $t('Start PiUI when I sign in')}
        hideLabel
        checked={settings?.launchAtLogin ?? false}
        disabled={readOnly || busy !== '' || !(settings?.launchAtLoginAvailable ?? false)}
        onCheckedChange={(value) => void change('launchAtLogin', value)}
      />
    </div>
    <div class="row">
      <div>
        <strong>{$t('Pause all automations')}</strong>
        <small>{$t('Nothing starts on a schedule or after an event until you resume. Runs already working continue.')}</small>
      </div>
      <Switch
        label={$t('Pause all automations')}
        hideLabel
        checked={paused}
        disabled={readOnly || busy !== ''}
        onCheckedChange={(value) => void pause(value)}
      />
    </div>
  </div>
{/if}
{#if error}<p class="error" role="alert">{$t(error)}</p>{/if}

<style>
  h2 {
    margin: 0 0 var(--piui-space-2);
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  .lead {
    margin: 0 0 var(--piui-space-4);
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
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
    padding: var(--piui-space-3) var(--piui-space-4);
  }
  .row + .row {
    border-top: 1px solid var(--piui-border-subtle);
  }
  .row div {
    display: grid;
    gap: 2px;
  }
  .row small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .note {
    margin: 0 0 var(--piui-space-3);
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .error {
    margin: var(--piui-space-3) 0 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
</style>
