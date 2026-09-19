<script lang="ts">
  import { language, setLanguage, t } from '../locale/language';
  import type { Preferences } from '../../host-api/types';

  export let preferences: Preferences;
  export let busy = false;
  export let error: string | undefined;
  export let onChange: (next: Preferences) => void;
  export let onClose: () => void;

  function change<K extends keyof Preferences>(key: K, event: Event): void {
    onChange({ ...preferences, [key]: (event.currentTarget as HTMLSelectElement).value });
  }
</script>

<section class="settings" aria-labelledby="workspace-settings-title">
  <header>
    <div><span>{$t('PiUI')}</span><h1 id="workspace-settings-title">{$t('Settings')}</h1></div>
    <button type="button" onclick={onClose}>{$t('Done')}</button>
  </header>
  <div class="body">
    <div class="rows">
      <label><span><strong>{$t('Language')}</strong></span><select aria-label={$t("Language")} value={$language} onchange={(event) => setLanguage(event.currentTarget.value as 'en' | 'ru')}><option value="en">{$t('English')}</option><option value="ru">Русский</option></select></label>
      <label><span><strong>{$t('Theme')}</strong><small>{$t('Choose a theme or follow the operating system.')}</small></span>
        <select value={preferences.theme} onchange={(event) => change('theme', event)} disabled={busy}>
          <option value="system">{$t('System')}</option><option value="light">{$t('Light')}</option><option value="dark">{$t('Dark')}</option>
        </select>
      </label>
      <label><span><strong>{$t('Density')}</strong><small>{$t('Adjust spacing without reducing control labels.')}</small></span>
        <select value={preferences.density} onchange={(event) => change('density', event)} disabled={busy}>
          <option value="comfortable">{$t('Comfortable')}</option><option value="compact">{$t('Compact')}</option>
        </select>
      </label>
      <label><span><strong>{$t('Motion')}</strong><small>{$t('Reduce nonessential interface transitions.')}</small></span>
        <select value={preferences.reducedMotion} onchange={(event) => change('reducedMotion', event)} disabled={busy}>
          <option value="system">{$t('Follow system')}</option><option value="reduce">{$t('Reduce motion')}</option>
        </select>
      </label>
      <label><span><strong>{$t('Chat text size')}</strong><small>{$t('Change local conversation text size.')}</small></span>
        <select value={preferences.fontSize} onchange={(event) => change('fontSize', event)} disabled={busy}>
          <option value="small">{$t('Small')}</option><option value="medium">{$t('Medium')}</option><option value="large">{$t('Large')}</option>
        </select>
      </label>
      <label><span><strong>{$t('Conversation width')}</strong><small>{$t('Choose how much of the main workspace chat uses.')}</small></span>
        <select value={preferences.chatWidth} onchange={(event) => change('chatWidth', event)} disabled={busy}>
          <option value="wide">{$t('Wide')}</option><option value="centered">{$t('Centered')}</option><option value="focused">{$t('Focused')}</option>
        </select>
      </label>
    </div>
    {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
  </div>
</section>

<style>
  .settings { flex:1; min-height:0; overflow:auto; background: var(--piui-bg); color: var(--piui-text); }
  header { height: 46px; padding: 0 var(--piui-space-6); border-bottom: 1px solid var(--piui-border-subtle); display:flex; align-items:center; justify-content:space-between; }
  header div { display:flex; align-items:baseline; gap:12px; }
  header span { color:var(--piui-text-muted); font-size:12px; }
  h1 { margin:0; font-size:15px; font-weight:650; }
  button, select { border:1px solid var(--piui-border); border-radius:7px; background:var(--piui-bg-raised); color:var(--piui-text); font:inherit; }
  button { padding:6px 10px; cursor:pointer; }
  button:focus-visible, select:focus-visible { outline:2px solid var(--piui-focus); outline-offset:2px; }
  .body { width:min(720px, calc(100% - 40px)); margin:0 auto; padding:28px 0; }
  .rows { border:1px solid var(--piui-border); border-radius:12px; background:var(--piui-bg-raised); overflow:hidden; }
  label { min-height:60px; padding:10px 14px; display:flex; align-items:center; justify-content:space-between; gap:24px; border-bottom:1px solid var(--piui-border-subtle); }
  label:last-child { border-bottom:0; }
  label span { display:grid; gap:4px; }
  strong { font-size:14px; }
  small { color:var(--piui-text-muted); line-height:1.4; }
  select { min-width:150px; padding:6px 9px; }
  .error { color:var(--piui-danger); }
  @media (max-width: 620px) { label { align-items:stretch; flex-direction:column; gap:10px; } select { width:100%; } }
</style>
