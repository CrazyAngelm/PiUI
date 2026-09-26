<script lang="ts">
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import Bot from '@lucide/svelte/icons/bot';
  import FolderCog from '@lucide/svelte/icons/folder-cog';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import Info from '@lucide/svelte/icons/info';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import Plus from '@lucide/svelte/icons/plus';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import { t, language, setLanguage, type Language } from '../../features/locale/language';
  import type { Preferences } from '../../host-api/types';
  import type { WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { Badge, Button, Kbd, Segmented } from '../../lib/ui';
  import type { SettingsSection } from '../workspaceStore.svelte';
  import HarnessMark from './HarnessMark.svelte';
  import ExtensionsSettings from '../settings/ExtensionsSettings.svelte';
  import { useWorkspace } from './context';

  interface Props {
    section: SettingsSection;
    onTrust: (workspace: WorkspaceSummary) => void;
  }
  let { section, onTrust }: Props = $props();
  const store = useWorkspace();

  const sections: { id: SettingsSection; label: string; icon: typeof Info }[] = [
    { id: 'general', label: 'General', icon: SlidersHorizontal },
    { id: 'harnesses', label: 'Harnesses', icon: Bot },
    { id: 'extensions', label: 'Extensions', icon: Puzzle },
    { id: 'projects', label: 'Projects', icon: FolderCog },
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
    { id: 'about', label: 'About', icon: Info },
  ];

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    void store.savePreferences({ ...store.preferences, [key]: value });
  }

  const shortcuts: { keys: string; label: string }[] = [
    { keys: 'Mod+N', label: 'New chat' },
    { keys: 'Mod+K', label: 'Search and commands' },
    { keys: 'Mod+,', label: 'Settings' },
    { keys: 'Mod+Shift+I', label: 'Inbox' },
    { keys: 'Mod+Alt+B', label: 'Toggle chat details' },
    { keys: 'Mod+.', label: 'Stop the running turn' },
    { keys: 'Enter', label: 'Send message' },
    { keys: 'Shift+Enter', label: 'New line in a message' },
    { keys: 'Escape', label: 'Close menus and dialogs' },
  ];
</script>

<section class="settings" aria-labelledby="settings-title">
  <nav class="settings__nav" aria-label={$t('Settings sections')}>
    <h1 id="settings-title">{$t('Settings')}</h1>
    {#each sections as item (item.id)}
      <button
        type="button"
        aria-current={section === item.id ? 'page' : undefined}
        onclick={() => store.navigate({ name: 'settings', section: item.id })}
      >
        <item.icon size={15} />
        <span>{$t(item.label)}</span>
      </button>
    {/each}
  </nav>

  <div class="settings__body">
    {#if section === 'general'}
      <h2>{$t('General')}</h2>
      {#if store.preferencesError}<p class="error" role="alert">{$t(store.preferencesError)}</p>{/if}
      <div class="rows">
        <div class="row">
          <div><strong>{$t('Language')}</strong><small>{$t('Interface language. Chats and prompts are never translated.')}</small></div>
          <Segmented
            label={$t('Language')}
            value={$language}
            options={[{ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }]}
            onValueChange={(value: Language) => setLanguage(value)}
          />
        </div>
        <div class="row">
          <div><strong>{$t('Theme')}</strong></div>
          <Segmented
            label={$t('Theme')}
            value={store.preferences.theme}
            options={[
              { value: 'system', label: $t('System') },
              { value: 'dark', label: $t('Dark') },
              { value: 'light', label: $t('Light') },
            ]}
            onValueChange={(value) => update('theme', value)}
          />
        </div>
        <div class="row">
          <div><strong>{$t('Density')}</strong><small>{$t('Compact fits more rows in lists and panels.')}</small></div>
          <Segmented
            label={$t('Density')}
            value={store.preferences.density}
            options={[
              { value: 'comfortable', label: $t('Comfortable') },
              { value: 'compact', label: $t('Compact') },
            ]}
            onValueChange={(value) => update('density', value)}
          />
        </div>
        <div class="row">
          <div><strong>{$t('Motion')}</strong></div>
          <Segmented
            label={$t('Motion')}
            value={store.preferences.reducedMotion}
            options={[
              { value: 'system', label: $t('Follow system') },
              { value: 'reduce', label: $t('Reduce') },
            ]}
            onValueChange={(value) => update('reducedMotion', value)}
          />
        </div>
        <div class="row">
          <div><strong>{$t('Chat text size')}</strong></div>
          <Segmented
            label={$t('Chat text size')}
            value={store.preferences.fontSize}
            options={[
              { value: 'small', label: $t('Small') },
              { value: 'medium', label: $t('Medium') },
              { value: 'large', label: $t('Large') },
            ]}
            onValueChange={(value) => update('fontSize', value)}
          />
        </div>
        <div class="row">
          <div><strong>{$t('Conversation width')}</strong></div>
          <Segmented
            label={$t('Conversation width')}
            value={store.preferences.chatWidth}
            options={[
              { value: 'focused', label: $t('Focused') },
              { value: 'centered', label: $t('Centered') },
              { value: 'wide', label: $t('Wide') },
            ]}
            onValueChange={(value) => update('chatWidth', value)}
          />
        </div>
      </div>
    {:else if section === 'harnesses'}
      <div class="title-row">
        <h2>{$t('Harnesses')}</h2>
        <Button size="sm" onclick={() => void store.loadCatalog()}>
          {#snippet leading()}<RefreshCw />{/snippet}
          {$t('Check again')}
        </Button>
      </div>
      <p class="lead">{$t('PiUI drives the agent tools installed on this computer. Each harness keeps its own sign-in, models and history.')}</p>
      <div class="cards">
        {#each store.catalog.harnesses as harness (harness.kind)}
          <article class="card">
            <HarnessMark kind={harness.kind} size={28} />
            <div class="card__main">
              <div class="card__title">
                <strong>{harness.name}</strong>
                {#if harness.version}<span class="muted">v{harness.version}</span>{/if}
                {#if harness.status === 'available'}
                  <Badge tone="success">{$t('Ready')}</Badge>
                {:else if harness.status === 'unverified'}
                  <Badge tone="warning">{$t('Needs setup')}</Badge>
                {:else}
                  <Badge>{$t('Not found')}</Badge>
                {/if}
              </div>
              {#if harness.reason}<p class="muted">{$t(harness.reason)}</p>{/if}
            </div>
          </article>
        {/each}
      </div>
      <p class="muted small">{$t('Sign in inside each harness (for example in its terminal app). PiUI never reads or stores credentials.')}</p>
    {:else if section === 'extensions'}
      <ExtensionsSettings safeMode={store.safeMode} />
    {:else if section === 'projects'}
      <div class="title-row">
        <h2>{$t('Projects')}</h2>
        <Button size="sm" onclick={() => void store.addProject()} loading={store.addingProject}>
          {#snippet leading()}<Plus />{/snippet}
          {$t('Add project…')}
        </Button>
      </div>
      <p class="lead">{$t('Trust lets agents work on a folder’s files within the permissions of each chat. Trust is not a sandbox.')}</p>
      <div class="cards">
        {#each store.catalog.workspaces.filter((item) => !item.personal) as workspace (workspace.id)}
          <article class="card">
            {#if workspace.trust === 'trusted'}<ShieldCheck size={18} class="ok" />{:else}<ShieldAlert size={18} class="warn" />{/if}
            <div class="card__main">
              <div class="card__title">
                <strong>{workspace.name}</strong>
                {#if workspace.missing}<Badge tone="danger">{$t('Missing')}</Badge>{/if}
                <Badge tone={workspace.trust === 'trusted' ? 'success' : 'warning'}>{workspace.trust === 'trusted' ? $t('Trusted') : $t('Restricted')}</Badge>
              </div>
            </div>
            {#if workspace.trust !== 'trusted' && !workspace.missing}
              <Button size="sm" onclick={() => onTrust(workspace)}>{$t('Review trust…')}</Button>
            {/if}
          </article>
        {:else}
          <p class="muted">{$t('No project folders yet.')}</p>
        {/each}
      </div>
    {:else if section === 'shortcuts'}
      <h2>{$t('Shortcuts')}</h2>
      <div class="rows">
        {#each shortcuts as shortcut (shortcut.keys)}
          <div class="row row--tight"><span>{$t(shortcut.label)}</span><Kbd keys={shortcut.keys} /></div>
        {/each}
      </div>
    {:else}
      <h2>{$t('About')}</h2>
      <div class="rows">
        <div class="row row--tight"><span>PiUI</span><span class="muted">0.1.1</span></div>
        <div class="row row--tight"><span>{$t('Safe mode')}</span><span class="muted">{store.safeMode ? $t('On') : $t('Off')}</span></div>
      </div>
      <p class="muted small">{$t('Local-first: no account, cloud backend or telemetry. Harnesses talk to their own providers.')}</p>
    {/if}
  </div>
</section>

<style>
  .settings {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }
  .settings__nav {
    display: grid;
    align-content: start;
    gap: 1px;
    padding: var(--piui-space-6) var(--piui-space-2);
    border-right: 1px solid var(--piui-border-subtle);
  }
  .settings__nav h1 {
    margin: 0 0 var(--piui-space-3);
    padding: 0 var(--piui-space-2);
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  .settings__nav button {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 30px;
    padding: 0 var(--piui-space-2);
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    text-align: left;
  }
  .settings__nav button:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .settings__nav button[aria-current='page'] {
    background: var(--piui-selected);
    color: var(--piui-text);
  }
  .settings__body {
    min-height: 0;
    padding: var(--piui-space-6) var(--piui-space-8) var(--piui-space-12);
    overflow-y: auto;
  }
  .settings__body > :global(*) {
    max-width: 720px;
  }
  h2 {
    margin: 0 0 var(--piui-space-4);
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title-row h2 {
    margin: 0;
  }
  .lead {
    margin: var(--piui-space-2) 0 var(--piui-space-4);
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
  }
  .row--tight {
    padding-block: var(--piui-space-2);
  }
  .cards {
    display: grid;
    gap: var(--piui-space-2);
  }
  .card {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    padding: var(--piui-space-3) var(--piui-space-4);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .card__main {
    flex: 1;
    min-width: 0;
  }
  .card__title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
  }
  .card p {
    margin: 4px 0 0;
  }
  .card :global(.ok) {
    color: var(--piui-success);
  }
  .card :global(.warn) {
    color: var(--piui-warning);
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .small {
    margin-top: var(--piui-space-4);
    font-size: var(--piui-text-sm);
  }
  .error {
    color: var(--piui-danger);
  }
</style>
