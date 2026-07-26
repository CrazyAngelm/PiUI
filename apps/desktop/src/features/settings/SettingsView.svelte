<script lang="ts">
  import type { ExtensionSummary, Preferences } from '../../host-api/types';

  export let preferences: Preferences;
  export let preferencesBusy = false;
  export let preferencesError: string | undefined;
  export let extensions: ExtensionSummary[] = [];
  export let extensionsLoading = false;
  export let extensionsError: string | undefined;
  export let extensionBusyId: string | undefined;
  export let onTheme: (event: Event) => void;
  export let onDensity: (event: Event) => void;
  export let onMotion: (event: Event) => void;
  export let onFontSize: (event: Event) => void;
  export let onChatWidth: (event: Event) => void;
  export let onToggleExtension: (extension: ExtensionSummary, enabled: boolean) => void;
  export let onRefreshExtensions: () => void;
  export let onClose: () => void;

  type SettingsTab = 'appearance' | 'extensions';
  let activeTab: SettingsTab = 'appearance';

  function selectTab(tab: SettingsTab): void {
    activeTab = tab;
    if (tab === 'extensions' && extensions.length === 0 && !extensionsLoading) onRefreshExtensions();
  }

  function toggleExtension(extension: ExtensionSummary, event: Event): void {
    onToggleExtension(extension, (event.currentTarget as HTMLInputElement).checked);
  }
</script>

<section class="settings-view" aria-labelledby="settings-title">
  <header class="settings-header">
    <div>
      <p class="settings-kicker">PiUI</p>
      <h1 id="settings-title">Settings</h1>
    </div>
    <button type="button" class="settings-close" onclick={onClose} aria-label="Close settings">Done</button>
  </header>

  <div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings sections">
      <button type="button" class:active={activeTab === 'appearance'} aria-current={activeTab === 'appearance' ? 'page' : undefined} onclick={() => selectTab('appearance')}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="m19 13.5 1.2.9-1.7 2.9-1.4-.6a7 7 0 0 1-2 1.2L15 19.5h-3.4l-.2-1.6a7 7 0 0 1-2-1.2l-1.4.6-1.7-2.9 1.2-.9a7 7 0 0 1 0-2.3l-1.2-.9L8 7.4l1.4.6a7 7 0 0 1 2-1.2l.2-1.6H15l.2 1.6a7 7 0 0 1 2 1.2l1.4-.6 1.7 2.9-1.2.9a7 7 0 0 1-.1 2.3Z"/></svg>
        <span>Appearance</span>
      </button>
      <button type="button" class:active={activeTab === 'extensions'} aria-current={activeTab === 'extensions' ? 'page' : undefined} onclick={() => selectTab('extensions')}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v4h4v8h-4v4H8v-4H4V8h4V4Z"/><path d="M9.5 9.5h5v5h-5z"/></svg>
        <span>Extensions</span>
        {#if extensions.length > 0}<span class="nav-count">{extensions.length}</span>{/if}
      </button>
    </nav>

    <div class="settings-content">
      {#if activeTab === 'appearance'}
        <section class="settings-section" aria-labelledby="appearance-title">
          <div class="section-heading">
            <p class="section-eyebrow">Interface</p>
            <h2 id="appearance-title">Appearance</h2>
            <p>Choose how PiUI looks and how much room the conversation uses. These local settings never modify Pi configuration.</p>
          </div>

          <div class="settings-card">
            <label class="setting-row" for="theme-preference">
              <span><strong>Theme</strong><small>Choose a fixed theme or follow Windows.</small></span>
              <select id="theme-preference" value={preferences.theme} onchange={onTheme} disabled={preferencesBusy}>
                <option value="system">System</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label class="setting-row" for="font-size-preference">
              <span><strong>Chat text size</strong><small>Changes message and composer text without changing your Pi prompts.</small></span>
              <select id="font-size-preference" value={preferences.fontSize} onchange={onFontSize} disabled={preferencesBusy}>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </label>
            <label class="setting-row" for="chat-width-preference">
              <span><strong>Conversation width</strong><small>Wide uses more workspace. Centered and focused add more space at the sides.</small></span>
              <select id="chat-width-preference" value={preferences.chatWidth} onchange={onChatWidth} disabled={preferencesBusy}>
                <option value="wide">Wide</option>
                <option value="centered">Centered</option>
                <option value="focused">Focused</option>
              </select>
            </label>
            <label class="setting-row" for="density-preference">
              <span><strong>Density</strong><small>Adjust spacing throughout the workspace.</small></span>
              <select id="density-preference" value={preferences.density} onchange={onDensity} disabled={preferencesBusy}>
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </label>
            <label class="setting-row" for="motion-preference">
              <span><strong>Motion</strong><small>Reduce nonessential interface transitions.</small></span>
              <select id="motion-preference" value={preferences.reducedMotion} onchange={onMotion} disabled={preferencesBusy}>
                <option value="system">Follow system</option>
                <option value="reduce">Reduce motion</option>
              </select>
            </label>
          </div>
          {#if preferencesError}<p class="settings-error" role="alert">{preferencesError}</p>{/if}
        </section>
      {:else}
        <section class="settings-section" aria-labelledby="extensions-title">
          <div class="section-heading section-heading--actions">
            <div>
              <p class="section-eyebrow">Pi resources</p>
              <h2 id="extensions-title">Extensions</h2>
              <p>Global extensions run with full system permissions. Changes apply the next time a chat runtime starts.</p>
            </div>
            <button type="button" class="refresh-extensions" onclick={onRefreshExtensions} disabled={extensionsLoading || extensionBusyId !== undefined}>{extensionsLoading ? 'Loading…' : 'Refresh'}</button>
          </div>

          {#if extensionsError}
            <div class:extension-error--compact={extensions.length > 0} class="extension-error" role="alert"><strong>Extension update failed.</strong><p>{extensionsError}</p>{#if extensions.length === 0}<button type="button" onclick={onRefreshExtensions}>Try again</button>{/if}</div>
          {/if}
          {#if extensionsLoading && extensions.length === 0}
            <div class="extension-loading" role="status"><span></span><span></span><span></span></div>
          {:else if extensions.length === 0}
            <div class="extension-empty"><strong>No global extensions found</strong><p>Install extensions with Pi, then refresh this page.</p></div>
          {:else}
            <div class="extension-list" aria-label="Global Pi extensions">
              {#each extensions as extension (extension.id)}
                <article class="extension-row">
                  <div class="extension-icon" aria-hidden="true">{extension.name.slice(0, 1).toUpperCase()}</div>
                  <div class="extension-copy">
                    <strong>{extension.name}</strong>
                    <span>{extension.source} extension</span>
                  </div>
                  <label class="switch" aria-label={`${extension.enabled ? 'Disable' : 'Enable'} ${extension.name}`}>
                    <input type="checkbox" checked={extension.enabled} onchange={(event) => toggleExtension(extension, event)} disabled={extensionBusyId !== undefined} />
                    <span aria-hidden="true"></span>
                  </label>
                </article>
              {/each}
            </div>
            <p class="extension-note">Project-local extensions are intentionally not managed here. They remain behind the project trust boundary.</p>
          {/if}
        </section>
      {/if}
    </div>
  </div>
</section>

<style>
  .settings-view { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--piui-bg); }
  .settings-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; min-height: 86px; padding: 18px clamp(24px, 4vw, 56px); border-bottom: 1px solid var(--piui-border-subtle); }
  .settings-kicker { margin: 0 0 3px; color: var(--piui-text-faint); font-size: 10px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
  .settings-header h1 { margin: 0; font-size: 25px; letter-spacing: -.035em; }
  .settings-close { min-height: 34px; padding: 0 14px; border: 1px solid var(--piui-border); border-radius: 9px; background: var(--piui-surface-1); color: var(--piui-text); font-size: 12px; font-weight: 700; }
  .settings-close:hover { border-color: var(--piui-accent); background: var(--piui-surface-2); }
  .settings-layout { display: grid; grid-template-columns: minmax(170px, 210px) minmax(0, 1fr); min-height: 0; flex: 1 1 0; }
  .settings-nav { display: flex; flex-direction: column; gap: 3px; padding: 24px 14px; border-right: 1px solid var(--piui-border-subtle); background: var(--piui-bg-raised); }
  .settings-nav button { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 0 11px; border-radius: 9px; background: transparent; color: var(--piui-text-muted); text-align: left; font-size: 13px; font-weight: 650; }
  .settings-nav button:hover { background: var(--piui-surface-1); color: var(--piui-text); }
  .settings-nav button.active { background: var(--piui-surface-2); color: var(--piui-text); }
  .settings-nav svg { width: 17px; height: 17px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .nav-count { margin-left: auto; color: var(--piui-text-faint); font-size: 10px; }
  .settings-content { min-width: 0; min-height: 0; overflow: auto; }
  .settings-section { width: min(100% - 64px, 820px); margin: 0 auto; padding: clamp(42px, 7vw, 76px) 0 80px; }
  .section-heading { margin-bottom: 26px; }
  .section-heading--actions { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
  .section-eyebrow { margin: 0 0 8px; color: var(--piui-accent); font-size: 10px; font-weight: 760; letter-spacing: .12em; text-transform: uppercase; }
  .section-heading h2 { margin: 0; font-size: clamp(28px, 4vw, 38px); letter-spacing: -.045em; }
  .section-heading p:not(.section-eyebrow) { max-width: 620px; margin: 10px 0 0; color: var(--piui-text-muted); font-size: 13px; line-height: 1.55; }
  .settings-card, .extension-list { overflow: hidden; border: 1px solid var(--piui-border); border-radius: 14px; background: var(--piui-bg-raised); }
  .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 28px; min-height: 82px; padding: 15px 18px; }
  .setting-row + .setting-row, .extension-row + .extension-row { border-top: 1px solid var(--piui-border-subtle); }
  .setting-row > span { display: grid; gap: 4px; min-width: 0; }
  .setting-row strong { font-size: 13px; }
  .setting-row small { color: var(--piui-text-muted); font-size: 11px; line-height: 1.4; }
  .setting-row select { width: min(190px, 42%); min-height: 36px; padding: 0 30px 0 10px; border: 1px solid var(--piui-border); border-radius: 8px; background: var(--piui-surface-1); color: var(--piui-text); font-size: 12px; }
  .refresh-extensions { min-height: 34px; padding: 0 13px; border: 1px solid var(--piui-border); border-radius: 8px; background: var(--piui-surface-1); color: var(--piui-text-muted); font-size: 11px; font-weight: 700; }
  .refresh-extensions:hover:not(:disabled) { border-color: var(--piui-accent); color: var(--piui-text); }
  .extension-row { display: flex; align-items: center; gap: 13px; min-height: 70px; padding: 12px 16px; }
  .extension-icon { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 auto; border: 1px solid var(--piui-border); border-radius: 9px; background: var(--piui-surface-1); color: var(--piui-accent); font-size: 12px; font-weight: 800; }
  .extension-copy { display: grid; min-width: 0; gap: 3px; }
  .extension-copy strong { overflow: hidden; color: var(--piui-text); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
  .extension-copy span { color: var(--piui-text-faint); font-size: 10px; }
  .switch { position: relative; width: 38px; height: 22px; flex: 0 0 auto; margin-left: auto; }
  .switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .switch span { display: block; width: 100%; height: 100%; border: 1px solid var(--piui-border); border-radius: 999px; background: var(--piui-surface-3); transition: background-color 140ms ease, border-color 140ms ease; }
  .switch span::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--piui-text-muted); transition: transform 140ms ease, background-color 140ms ease; }
  .switch input:checked + span { border-color: var(--piui-accent); background: var(--piui-accent); }
  .switch input:checked + span::after { background: var(--piui-accent-ink); transform: translateX(16px); }
  .switch input:focus-visible + span { outline: 2px solid var(--piui-focus); outline-offset: 3px; }
  .switch input:disabled + span { cursor: wait; opacity: .55; }
  .extension-note { margin: 14px 2px 0; color: var(--piui-text-faint); font-size: 10px; line-height: 1.5; }
  .extension-loading { display: grid; gap: 10px; padding: 18px; border: 1px solid var(--piui-border); border-radius: 14px; background: var(--piui-bg-raised); }
  .extension-loading span { display: block; width: 75%; height: 14px; border-radius: 4px; background: var(--piui-surface-2); }
  .extension-loading span:nth-child(2) { width: 58%; }.extension-loading span:nth-child(3) { width: 68%; }
  .extension-empty, .extension-error { padding: 36px; border: 1px dashed var(--piui-border); border-radius: 14px; color: var(--piui-text-muted); text-align: center; }
  .extension-error { margin-bottom: 12px; border-color: var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }
  .extension-error--compact { padding: 12px 14px; text-align: left; }
  .extension-empty strong, .extension-error strong { color: var(--piui-text); font-size: 14px; }.extension-empty p, .extension-error p { margin: 7px 0 0; font-size: 11px; }.extension-error button { margin-top: 14px; padding: 7px 11px; border-radius: 7px; background: var(--piui-surface-2); color: var(--piui-text); font-size: 11px; }
  .settings-error { margin: 14px 0 0; color: var(--piui-danger); font-size: 11px; }
  @media (max-width: 780px) { .settings-layout { grid-template-columns: 1fr; }.settings-nav { flex-direction: row; padding: 10px 16px; border-right: 0; border-bottom: 1px solid var(--piui-border-subtle); }.settings-nav button { width: auto; }.settings-content { min-height: 0; }.settings-section { width: min(100% - 32px, 820px); padding-top: 32px; } }
</style>
