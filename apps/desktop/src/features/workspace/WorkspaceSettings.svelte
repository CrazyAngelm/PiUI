<script lang="ts">
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
    <div><span>PiUI</span><h1 id="workspace-settings-title">Settings</h1></div>
    <button type="button" onclick={onClose}>Done</button>
  </header>
  <div class="body">
    <div class="rows">
      <label><span><strong>Theme</strong><small>Choose a theme or follow the operating system.</small></span>
        <select value={preferences.theme} onchange={(event) => change('theme', event)} disabled={busy}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </label>
      <label><span><strong>Density</strong><small>Adjust spacing without reducing control labels.</small></span>
        <select value={preferences.density} onchange={(event) => change('density', event)} disabled={busy}>
          <option value="comfortable">Comfortable</option><option value="compact">Compact</option>
        </select>
      </label>
      <label><span><strong>Motion</strong><small>Reduce nonessential interface transitions.</small></span>
        <select value={preferences.reducedMotion} onchange={(event) => change('reducedMotion', event)} disabled={busy}>
          <option value="system">Follow system</option><option value="reduce">Reduce motion</option>
        </select>
      </label>
      <label><span><strong>Chat text size</strong><small>Change local conversation text size.</small></span>
        <select value={preferences.fontSize} onchange={(event) => change('fontSize', event)} disabled={busy}>
          <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
        </select>
      </label>
      <label><span><strong>Conversation width</strong><small>Choose how much of the main workspace chat uses.</small></span>
        <select value={preferences.chatWidth} onchange={(event) => change('chatWidth', event)} disabled={busy}>
          <option value="wide">Wide</option><option value="centered">Centered</option><option value="focused">Focused</option>
        </select>
      </label>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
</section>

<style>
  .settings { flex:1; min-height:0; overflow:auto; background: var(--piui-bg); color: var(--piui-text); }
  header { height: 66px; padding: 0 var(--piui-space-6); border-bottom: 1px solid var(--piui-border-subtle); display:flex; align-items:center; justify-content:space-between; }
  header div { display:flex; align-items:baseline; gap:12px; }
  header span { color:var(--piui-text-muted); font-size:12px; }
  h1 { margin:0; font-size:18px; font-weight:650; }
  button, select { border:1px solid var(--piui-border); border-radius:7px; background:var(--piui-bg-raised); color:var(--piui-text); font:inherit; }
  button { padding:8px 13px; cursor:pointer; }
  button:focus-visible, select:focus-visible { outline:2px solid var(--piui-focus); outline-offset:2px; }
  .body { width:min(720px, calc(100% - 40px)); margin:0 auto; padding:42px 0; }
  .rows { border:1px solid var(--piui-border); border-radius:12px; background:var(--piui-bg-raised); overflow:hidden; }
  label { min-height:74px; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; gap:24px; border-bottom:1px solid var(--piui-border-subtle); }
  label:last-child { border-bottom:0; }
  label span { display:grid; gap:4px; }
  strong { font-size:14px; }
  small { color:var(--piui-text-muted); line-height:1.4; }
  select { min-width:150px; padding:8px 10px; }
  .error { color:var(--piui-danger); }
  @media (max-width: 620px) { label { align-items:stretch; flex-direction:column; gap:10px; } select { width:100%; } }
</style>
