<script lang="ts">
  import type { FakeScenario } from '../../host-api/types';

  export let enabled = false;
  export let busy = false;
  export let onRun: (scenario: FakeScenario, text: string) => void;

  let text = 'Verify the safe runtime boundary.';
  let scenario: FakeScenario = 'stream';

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (enabled && !busy && text.trim().length > 0) {
      onRun(scenario, text);
    }
  }
</script>

<form class="composer" aria-label="Deterministic fake runtime composer" onsubmit={submit}>
  <div class="composer-heading">
    <span>Deterministic fake runtime</span>
    <span class="local-only">Local only · not sent to Pi</span>
  </div>
  <label class="visually-hidden" for="fake-scenario-text">Fake scenario input</label>
  <textarea id="fake-scenario-text" bind:value={text} rows="2" disabled={!enabled || busy} placeholder="Describe a deterministic fake turn"></textarea>
  <div class="composer-controls">
    <label for="fake-scenario">Scenario</label>
    <select id="fake-scenario" bind:value={scenario} disabled={!enabled || busy}>
      <option value="stream">Stream</option>
      <option value="abort">Abort</option>
      <option value="crash">Crash</option>
      <option value="malformed">Malformed protocol</option>
    </select>
    <button type="submit" disabled={!enabled || busy || text.trim().length === 0}>{busy ? 'Running…' : 'Run scenario'}</button>
  </div>
  {#if !enabled}
    <p>Trust this project and select an indexed session to run the local fake runtime.</p>
  {/if}
</form>

<style>
  .composer { margin: 0 var(--piui-space-6) var(--piui-space-4); overflow: hidden; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-md); background: var(--piui-surface-1); }
  .composer-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--piui-space-3); padding: var(--piui-space-2) var(--piui-space-3); border-bottom: 1px solid var(--piui-border-subtle); color: var(--piui-text); font-size: 12px; font-weight: 700; }
  .local-only { color: var(--piui-text-faint); font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
  textarea { display: block; width: 100%; resize: vertical; min-height: 66px; max-height: 180px; border: 0; padding: var(--piui-space-3); background: transparent; color: var(--piui-text); line-height: 1.5; }
  textarea:disabled { color: var(--piui-text-muted); }
  .composer-controls { display: flex; align-items: center; gap: var(--piui-space-2); padding: var(--piui-space-2) var(--piui-space-3); border-top: 1px solid var(--piui-border-subtle); }
  label { color: var(--piui-text-muted); font-size: 11px; font-weight: 700; }
  select { min-height: 30px; max-width: 180px; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-2); color: var(--piui-text); font-size: 12px; }
  button { min-height: 30px; margin-left: auto; padding: 0 var(--piui-space-3); border-radius: var(--piui-radius-sm); background: var(--piui-accent); color: var(--piui-accent-ink); font-size: 12px; font-weight: 750; }
  button:disabled { background: var(--piui-surface-2); color: var(--piui-text-faint); }
  p { margin: 0; padding: 0 var(--piui-space-3) var(--piui-space-3); color: var(--piui-text-muted); font-size: 11px; line-height: 1.4; }
  @media (max-width: 700px) { .composer { margin: 0 var(--piui-space-4) var(--piui-space-3); }.composer-controls { flex-wrap: wrap; }.composer-controls button { margin-left: 0; } }
</style>
