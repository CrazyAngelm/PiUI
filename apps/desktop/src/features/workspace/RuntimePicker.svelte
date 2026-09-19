<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../locale/language';
  import { runtimeSettings } from '../../host-api/runtimeSettings';
  import type { RuntimeSettings } from '../../../../../contracts/workspace-settings-v16';
  import type { WorkspaceModel, WorkspaceSession } from '../../../../../contracts/workspace-v15';
  import { selectedRuntimeModel, effortName } from './runtimePickerState';
  export let session: WorkspaceSession;
  export let disabled = false;
  export let onchange: () => void = () => {};
  let open = false;
  let view: 'effort' | 'models' = 'effort';
  let busy = false;
  let error = '';
  let settings: RuntimeSettings | undefined;
  let trigger: HTMLButtonElement;
  let panel: HTMLElement;
  let preview: number | undefined;
  $: current = settings?.sessionId === session.id ? settings : undefined;
  $: model = selectedRuntimeModel(current?.models ?? [], current?.model ?? session.model);
  $: levels = model?.thinkingLevels ?? [];
  $: effortIndex = current?.thinkingLevel ? levels.indexOf(current.thinkingLevel) : -1;
  $: position = preview ?? effortIndex;
  $: effort = position >= 0 ? levels[position] : current?.thinkingLevel;
  $: fill = position < 0 ? 0 : (position + 1) / levels.length;
  $: overflowing = levels.length > 1 && position === levels.length - 1;
  $: catalogHasModel = current?.models.some(entry => entry.id === model?.id && entry.provider === model?.provider) ?? false;
  async function toggle(): Promise<void> {
    open = !open;
    if (!open) return;
    view = 'effort'; busy = true; error = '';
    const id = session.id;
    try { const result = await runtimeSettings({ type: 'get', sessionId: id }); if (session.id === id) settings = result; }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  async function update(next: WorkspaceModel | undefined = model, thinkingLevel: string | undefined = undefined, serviceTier: 'standard' | 'fast' | undefined = undefined): Promise<void> {
    if (!current || !next || busy || disabled) return;
    const sameModel = next.id === model?.id && next.provider === model?.provider;
    busy = true; error = '';
    const id = session.id;
    try {
      const result = await runtimeSettings({ type: 'set', sessionId: id, model: next,
        ...(thinkingLevel ? { thinkingLevel } : sameModel && current.thinkingLevel ? { thinkingLevel: current.thinkingLevel } : {}),
        ...(serviceTier ? { serviceTier } : current.serviceTier ? { serviceTier: current.serviceTier } : {}) });
      if (session.id === id) { settings = result; view = 'effort'; }
      onchange();
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; preview = undefined; }
  }
  async function showModels(): Promise<void> {
    view = 'models'; await tick();
    panel?.querySelector<HTMLButtonElement>('[aria-checked="true"], .model-option:not(:disabled)')?.focus();
  }
  function listKeys(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = [...panel.querySelectorAll<HTMLButtonElement>('.model-option:not(:disabled)')];
    if (!options.length) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
  }
  function close(): void { open = false; preview = undefined; trigger?.focus(); }
</script>
<svelte:window onkeydowncapture={(event) => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }} onpointerdown={(event) => { if (open && event.target instanceof Element && !event.target.closest('.runtime-picker')) { open = false; preview = undefined; } }} />
<div class="runtime-picker">
  <button class="trigger" bind:this={trigger} type="button" aria-expanded={open} aria-label={$t('Model and reasoning')} onclick={toggle} disabled={disabled}>
    {#if current?.serviceTier === 'fast'}<span class="bolt" aria-label={$t('Fast')}>ϟ</span>{/if}
    <span>{model?.name ?? $t('Native model')}</span><span class="muted">{current?.thinkingLevel ? $t(effortName(current.thinkingLevel)) : ''}</span>
  </button>
  {#if open}
    <section class="popover" bind:this={panel} aria-label={$t('Model and reasoning')} aria-busy={busy}>
      {#if view === 'models'}
        <div class="list-heading"><button type="button" class="back" aria-label={$t('Back to reasoning')} onclick={() => view = 'effort'}>‹</button><span>{$t('Select model')}</span></div>
        <div class="model-list" role="menu" tabindex="-1" aria-label={$t('Model')} onkeydown={listKeys}>
          {#if model && !catalogHasModel}<button type="button" class="model-option" role="menuitemradio" aria-checked="true" disabled><span>{model.name}</span><span aria-hidden="true">✓</span></button>{/if}
          {#each current?.models ?? [] as entry}
            <button type="button" class="model-option" role="menuitemradio" aria-checked={entry.id === model?.id && entry.provider === model?.provider} disabled={busy || disabled} onclick={() => update(entry)}>
              <span>{entry.name}{#if current?.models.some(other => other.id === entry.id && other.provider !== entry.provider)}<small>{entry.provider}</small>{/if}</span>
              {#if entry.id === model?.id && entry.provider === model?.provider}<span class="check" aria-hidden="true">✓</span>{/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="effort-heading">
          {#if current?.serviceTier}<button class="speed" type="button" aria-label={$t('Fast')} title={$t('Fast')} aria-pressed={current.serviceTier === 'fast'} disabled={busy || disabled || !catalogHasModel} onclick={() => update(model, undefined, current?.serviceTier === 'fast' ? 'standard' : 'fast')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-7z" /></svg></button>{:else}<span></span>{/if}
          <div class="effort-title"><strong>{effort ? $t(effortName(effort)) : $t('Model default')}</strong><button class="model-heading" type="button" aria-label={$t('Select model')} disabled={busy || disabled || !current} onclick={showModels}>{model?.name ?? $t('Native model')} <span aria-hidden="true">›</span></button></div>
          <span class="energy-mark" aria-hidden="true">✧</span>
        </div>
        {#if levels.length}
          <div class="energy" class:overflowing style:--fill={fill}>
            <div class="energy-rail" aria-hidden="true"><div class="energy-fill"><span class="ripple"></span></div><div class="stops">{#each levels as level}<i class:lit={levels.indexOf(level) <= position}></i>{/each}</div></div>
            {#if overflowing}
              <div class="chaos-field" aria-hidden="true">
                <span class="vortex"></span><span class="vortex echo"></span>
                <svg class="lightning" viewBox="0 0 300 70" preserveAspectRatio="none"><path d="m8 42 38-13-8 18 48-22-9 19 54-11-14 18 60-23-9 16 72-9"/><path d="m112 8 39 14-18 5 46 8-15 10 58-9 22 0"/><path d="m186 65 22-17-14-3 39-7 12-2"/></svg>
                <span class="infall"></span><span class="infall second"></span>
              </div>
            {/if}
            <input class="effort-range" type="range" min="0" max={levels.length - 1} step="1" value={Math.max(0, position)} aria-label={$t('Reasoning')} aria-valuetext={effort ? $t(effortName(effort)) : $t('Model default')} disabled={busy || disabled || levels.length === 1 || !catalogHasModel} oninput={(event) => preview = Number(event.currentTarget.value)} onchange={(event) => update(model, levels[Number(event.currentTarget.value)])} />
          </div>
          <div class="energy-caption"><span>{$t('Chaos energy')}</span><span>{overflowing ? $t('Overflowing') : effort ? $t(effortName(effort)) : $t('Model default')}</span></div>
        {:else}<p class="note">{$t(busy ? 'Loading…' : 'Reasoning options are unavailable for this model.')}</p>{/if}
      {/if}
      {#if error}<p class="error" role="alert">{$t(error)}</p><button class="retry" type="button" disabled={busy || disabled} onclick={() => { open = false; void toggle(); }}>{$t('Try again')}</button>{/if}
    </section>
  {/if}
</div>
<style>
  .runtime-picker { position:relative; min-width:0; }
  button { font:inherit; color:var(--piui-text); cursor:pointer; }
  button:disabled { cursor:default; opacity:.55; }
  button:focus-visible, input:focus-visible { outline:2px solid var(--piui-focus); outline-offset:3px; }
  .trigger { display:flex; align-items:center; gap:7px; border:0; background:transparent; padding:6px 10px; font-size:13px; border-radius:var(--piui-radius-lg); max-width:100%; }
  .trigger:hover, .trigger[aria-expanded=true] { background:var(--piui-surface-2); }
  .trigger > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .muted { color:var(--piui-text-muted); }
  .bolt { color:var(--piui-accent); }
  .popover { position:absolute; bottom:calc(100% + 10px); left:0; z-index:20; width:310px; max-width:calc(100vw - 48px); box-sizing:border-box; background:var(--piui-surface-1); border:1px solid var(--piui-border); border-radius:var(--piui-radius-lg); padding:16px; box-shadow:0 8px 28px #0003; }
  .effort-heading { display:grid; grid-template-columns:28px 1fr 28px; align-items:start; gap:8px; margin-bottom:22px; }
  .effort-title { display:grid; justify-items:center; gap:4px; min-width:0; }
  strong { color:var(--piui-accent); font-size:17px; font-weight:600; }
  .model-heading { background:transparent; border:0; padding:2px 5px; color:var(--piui-text-muted); display:flex; gap:8px; align-items:center; border-radius:var(--piui-radius-sm); }
  .model-heading:hover { color:var(--piui-text); background:var(--piui-surface-2); }
  .speed { background:transparent; border:0; border-radius:var(--piui-radius-sm); padding:3px; color:var(--piui-text-muted); }
  .speed:hover { background:var(--piui-surface-2); }
  .speed[aria-pressed=true] { color:var(--piui-accent); background:var(--piui-accent-soft); }
  svg { width:22px; height:22px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linejoin:round; }
  .energy-mark { text-align:right; font-size:22px; color:var(--piui-text-muted); }
  .energy { height:34px; position:relative; }
  .energy-rail { position:absolute; inset:0; background:var(--piui-surface-3); border-radius:30px; overflow:hidden; }
  .energy-fill { position:absolute; inset:0; transform:scaleX(var(--fill)); transform-origin:left; background:var(--piui-accent); border-radius:inherit; transition:transform 180ms ease-out; overflow:hidden; }
  .ripple { position:absolute; inset:45% -10% -60%; border-radius:42%; background:var(--piui-accent-ink); opacity:.15; transform:rotate(-4deg); }
  .overflowing { --chaos-core:#100608; --chaos-red:#72152d; --chaos-edge:#cf4b6e; }
  .overflowing .energy-fill { background:radial-gradient(ellipse at 94% 50%, var(--chaos-core) 5%, #350914 28%, var(--chaos-red) 68%, #a93250); }
  .overflowing .ripple { background:var(--chaos-core); opacity:.6; animation:surge 2200ms ease-in-out infinite alternate; }
  .overflowing .stops .lit { background:#e9a5b6; }
  .stops { position:absolute; inset:0 16px; display:flex; align-items:center; justify-content:space-between; }
  .stops i { width:4px; height:4px; background:var(--piui-text-muted); opacity:.5; border-radius:50%; }
  .stops .lit { background:var(--piui-accent-ink); }
  .effort-range { position:absolute; margin:0; inset:0; width:100%; height:34px; background:transparent; appearance:none; cursor:pointer; border-radius:30px; }
  .effort-range::-webkit-slider-thumb { appearance:none; width:34px; height:34px; border:0; border-radius:50%; background:var(--piui-text); box-shadow:0 1px 4px #0002; }
  .effort-range::-moz-range-thumb { width:34px; height:34px; border:0; border-radius:50%; background:var(--piui-text); }
  .overflowing .effort-range::-webkit-slider-thumb { background:var(--chaos-core); box-shadow:inset 0 0 0 2px var(--chaos-edge), 0 0 12px var(--chaos-red); }
  .overflowing .effort-range::-moz-range-thumb { background:var(--chaos-core); box-shadow:inset 0 0 0 2px var(--chaos-edge), 0 0 12px var(--chaos-red); }
  .effort-range:disabled { cursor:default; }
  .energy-caption { display:flex; justify-content:space-between; gap:8px; margin-top:10px; font-size:11px; color:var(--piui-text-muted); }
  .overflowing + .energy-caption > :last-child { color:var(--piui-accent); }
  .chaos-field { position:absolute; inset:-18px -8px; overflow:hidden; pointer-events:none; border-radius:24px; }
  .vortex { position:absolute; right:-8px; top:2px; width:66px; height:66px; border:2px solid var(--chaos-red); border-left-color:var(--chaos-edge); border-bottom-color:transparent; border-radius:43% 57% 50% 45%; box-sizing:border-box; animation:orbit 3200ms linear infinite; }
  .vortex.echo { inset:12px 2px auto auto; width:46px; height:46px; border-width:3px; animation-direction:reverse; opacity:.65; }
  .lightning { position:absolute; inset:0; width:100%; height:100%; stroke:var(--chaos-edge); stroke-width:1.4; filter:drop-shadow(0 0 3px var(--chaos-red)); animation:charge 2800ms ease-in-out infinite alternate; }
  .lightning path:nth-child(2) { stroke:var(--chaos-red); stroke-width:2; }
  .infall { position:absolute; right:24px; top:34px; height:2px; width:50px; background:var(--chaos-edge); transform-origin:right; animation:consume 2600ms ease-in infinite; }
  .infall.second { animation-delay:1300ms; --angle:155deg; }
  .list-heading { display:flex; align-items:center; gap:8px; color:var(--piui-text-muted); font-size:12px; margin-bottom:8px; }
  .back { background:transparent; border:0; font-size:22px; border-radius:var(--piui-radius-sm); padding:0 8px; }
  .model-list { display:grid; gap:2px; max-height: min(360px, 50vh); overflow-y:auto; padding:3px; margin:-3px; }
  .model-option { display:flex; justify-content:space-between; align-items:center; gap:12px; width:100%; padding:9px 10px; text-align:left; background:transparent; border:0; border-radius:var(--piui-radius-sm); }
  .model-option:hover, .back:hover { background:var(--piui-surface-2); }
  .model-option[aria-checked=true] { background:var(--piui-accent-soft); }
  .check { color:var(--piui-accent); }
  small { display:block; color:var(--piui-text-muted); }
  .note, .error { font-size:12px; color:var(--piui-text-muted); margin:8px 0 0; }
  .error { color:var(--piui-danger); }
  .retry { background:transparent; border:0; padding:8px 0 0; }
  @keyframes surge { to { transform:translateY(-4px) rotate(4deg); } }
  @keyframes orbit { to { transform:rotate(360deg); } }
  @keyframes charge { from { opacity:.35; transform:scaleY(.85); } to { opacity:.9; transform:scaleY(1.08); } }
  @keyframes consume { 0% { transform:rotate(var(--angle, -18deg)) translateX(-90px) scaleX(1); opacity:0; } 30% { opacity:.7; } 100% { transform:rotate(var(--angle, -18deg)) translateX(0) scaleX(0); opacity:0; } }
  :global(:root[data-reduced-motion="reduce"]) .chaos-field *, :global(:root[data-reduced-motion="reduce"]) .overflowing .ripple { animation:none; }
  :global(:root[data-reduced-motion="reduce"]) .infall { display:none; }
  @media (prefers-reduced-motion:reduce) { .energy-fill { transition:none; } .overflowing .ripple, .chaos-field * { animation:none; } .infall { display:none; } }
</style>
