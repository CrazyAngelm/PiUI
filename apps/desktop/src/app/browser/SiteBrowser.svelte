<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Globe from '@lucide/svelte/icons/globe';
  import Plus from '@lucide/svelte/icons/plus';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import X from '@lucide/svelte/icons/x';
  import { tick } from 'svelte';
  import type { SiteBrowserAction, SiteBrowserSnapshot } from '../../../../../contracts/site-browser-v1';
  import { language, t } from '../../features/locale/language';
  import { browserAction, onBrowserChange, onBrowserNotice } from '../../host-api/siteBrowserClient';
  import { desktopAvailable } from '../../host-api/transport';
  import { IconButton } from '../../lib/ui';

  let snapshot = $state.raw<SiteBrowserSnapshot>({ tabs: [], active: null });
  let active = $derived(snapshot.tabs.find((tab) => tab.id === snapshot.active));
  let address = $state('');
  let addressField: HTMLInputElement | undefined = $state();
  let busy = $state(false);
  let editing = $state(false);
  let notice = $state('');
  let revision = 0;

  $effect(() => {
    if (!editing) address = active?.url ?? '';
  });

  $effect(() => {
    let disposed = false;
    let stopChanges: (() => void) | undefined;
    let stopNotices: (() => void) | undefined;
    void onBrowserChange(() => void refresh()).then((unlisten) => {
      if (disposed) unlisten();
      else stopChanges = unlisten;
    }).catch(() => { notice = 'Could not read browser tabs.'; });
    void onBrowserNotice((kind) => {
      notice = kind === 'popup'
        ? 'Pop-up blocked. You can open this page in your system browser.'
        : 'Open this page in your system browser to download the file.';
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopNotices = unlisten;
    }).catch(() => { notice = 'Could not read browser tabs.'; });
    void refresh().then(() => { if (!disposed) addressField?.focus(); });
    return () => {
      disposed = true;
      stopChanges?.();
      stopNotices?.();
    };
  });

  async function refresh(): Promise<void> {
    const reading = ++revision;
    try {
      const next = await browserAction({ action: 'read' });
      if (reading === revision) snapshot = next;
    } catch {
      if (reading === revision) notice = 'Could not read browser tabs.';
    }
  }

  async function run(request: SiteBrowserAction): Promise<void> {
    if (busy) return;
    busy = true;
    notice = '';
    const reading = ++revision;
    try {
      const next = await browserAction(request);
      if (reading === revision) snapshot = next;
      if (request.action === 'new') {
        editing = false;
        await tick();
        addressField?.focus();
      }
    } catch (cause) {
      const invalid = typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'INVALID_ADDRESS';
      notice = invalid || (!desktopAvailable && request.action === 'navigate')
        ? 'Enter a valid HTTP or HTTPS address.'
        : 'Could not complete the browser action.';
    } finally {
      busy = false;
    }
  }

  function navigate(event: SubmitEvent): void {
    event.preventDefault();
    if (snapshot.active === null) return;
    const input = address;
    editing = false;
    void run({ action: 'navigate', tab: snapshot.active, address: input });
  }

  function keydown(event: KeyboardEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.key.toLowerCase() === 'l') {
      event.preventDefault();
      addressField?.focus();
      addressField?.select();
    } else if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      void run({ action: 'new' });
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<header class="toolbar" aria-label={$t('Browser toolbar')}>
  <div class="tab-row">
    <div class="tabs" aria-label={$t('Browser tabs')} role="group">
      {#each snapshot.tabs as tab (tab.id)}
        <div class="tab" class:active={tab.id === snapshot.active}>
          <button type="button" class="tab-label" title={tab.host ?? $t('New tab')} aria-pressed={tab.id === snapshot.active} onclick={() => void run({ action: 'select', tab: tab.id })}>
            <Globe size={14} />
            <span>{tab.host ?? $t('New tab')}</span>
          </button>
          <IconButton label={$t('Close browser tab')} title={$t('Close browser tab')} size="sm" tooltip={false} onclick={() => void run({ action: 'close', tab: tab.id })}><X /></IconButton>
        </div>
      {/each}
    </div>
    <IconButton label={$t('New tab')} title={$t('New tab')} size="sm" tooltip={false} onclick={() => void run({ action: 'new' })}><Plus /></IconButton>
  </div>
  <div class="navigation">
    {#if active}
      {@const tab = active}
      {@const hasPage = tab.url !== null}
      <IconButton label={$t('Back')} title={$t('Back')} tooltip={false} disabled={!hasPage} onclick={() => void run({ action: 'back', tab: tab.id })}><ArrowLeft /></IconButton>
      <IconButton label={$t('Forward')} title={$t('Forward')} tooltip={false} disabled={!hasPage} onclick={() => void run({ action: 'forward', tab: tab.id })}><ArrowRight /></IconButton>
      <IconButton label={$t('Reload page')} title={$t('Reload page')} tooltip={false} disabled={!hasPage} onclick={() => void run({ action: 'reload', tab: tab.id })}><RotateCw /></IconButton>
      <form onsubmit={navigate}>
        <input aria-label={$t('Website address')} placeholder={$t('Website address')} bind:this={addressField} bind:value={address} oninput={() => { editing = true; }} onblur={() => { editing = false; }} inputmode="url" autocomplete="off" spellcheck="false" />
      </form>
      <IconButton label={$t('Open in system browser')} title={$t('Open in system browser')} tooltip={false} disabled={!hasPage} onclick={() => void run({ action: 'external', tab: tab.id, language: $language })}><ExternalLink /></IconButton>
    {/if}
  </div>
</header>
{#if notice}
  <div class="notice" role="status" title={$t(notice)}>{$t(notice)}</div>
{/if}

{#if !desktopAvailable}
  <main class="lab-page">{active?.url ?? $t('Website address')}</main>
{/if}

<style>
  .toolbar {
    box-sizing: border-box;
    display: grid;
    grid-template-rows: 38px 40px;
    height: 88px;
    padding: 4px 8px 5px;
    color: var(--piui-text);
    background: var(--piui-bg);
    border-bottom: 1px solid var(--piui-border);
  }
  .tab-row, .navigation, .tabs, .tab, .tab-label { display: flex; align-items: center; min-width: 0; }
  .tabs { gap: 4px; overflow-x: auto; scrollbar-width: none; }
  .tab { flex: none; max-width: 180px; border: 1px solid transparent; border-radius: var(--piui-radius-sm); }
  .tab.active { background: var(--piui-bg-raised); border-color: var(--piui-border); }
  .tab-label { gap: 6px; padding: 0 7px; align-self: stretch; color: var(--piui-text); }
  .tab-label :global(svg) { flex: none; }
  .tab-label span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .navigation { gap: 4px; }
  form { flex: 1; min-width: 0; }
  input {
    width: 100%;
    height: var(--piui-control-md);
    padding: 0 9px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-raised);
    color: var(--piui-text);
  }
  .notice {
    position: absolute;
    top: 8px;
    right: 10px;
    pointer-events: none;
    max-width: calc(100% - 20px);
    background: var(--piui-bg-raised);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    padding: 4px 8px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .lab-page { padding: 16px; overflow-wrap: anywhere; }
</style>
