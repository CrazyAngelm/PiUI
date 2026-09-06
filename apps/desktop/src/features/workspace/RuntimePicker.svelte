<script lang="ts">
  import { t } from '../locale/language';
  import { runtimeSettings } from '../../host-api/runtimeSettings';
  import type { RuntimeSettings } from '../../../../../contracts/workspace-settings-v12';
  import type { WorkspaceSession } from '../../../../../contracts/workspace-v11';
  export let session: WorkspaceSession;
  export let disabled = false;
  export let onchange: () => void = () => {};
  let open = false;
  let busy = false;
  let error = '';
  let settings: RuntimeSettings | undefined;
  let trigger: HTMLButtonElement;
  $: current = settings?.sessionId === session.id ? settings : undefined;
  $: model = current?.models.find(entry => entry.id === current.model?.id && entry.provider === current.model?.provider) ?? current?.model ?? session.model;
  $: levels = model?.thinkingLevels ?? [];
  async function toggle(): Promise<void> {
    open = !open;
    if (!open) return;
    busy = true; error = '';
    const id = session.id;
    try { const result = await runtimeSettings({ type: 'get', sessionId: id }); if (session.id === id) settings = result; }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  async function update(index: number | undefined = undefined, thinkingLevel: string | undefined = undefined, serviceTier: 'standard' | 'fast' | undefined = undefined): Promise<void> {
    if (!current || busy || disabled) return;
    const next = index === undefined ? model : current.models[index];
    if (!next) return;
    busy = true; error = '';
    const id = session.id;
    try {
      const result = await runtimeSettings({ type: 'set', sessionId: id, model: next,
        ...(thinkingLevel ? { thinkingLevel } : index === undefined && current.thinkingLevel ? { thinkingLevel: current.thinkingLevel } : {}),
        ...(serviceTier ? { serviceTier } : current.serviceTier ? { serviceTier: current.serviceTier } : {}) });
      if (session.id === id) settings = result;
      onchange();
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  function close(): void { open = false; trigger?.focus(); }
</script>
<svelte:window onkeydowncapture={(event) => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }} onpointerdown={(event) => { if (open && event.target instanceof Element && !event.target.closest('.runtime-picker')) open = false; }} />
<div class="runtime-picker">
  <button class="trigger" bind:this={trigger} type="button" aria-expanded={open} aria-label={$t('Model and reasoning')} onclick={toggle} disabled={disabled}>
    {#if current?.serviceTier === 'fast'}<span class="bolt" aria-label="Fast">ϟ</span>{/if}
    <span>{model?.name ?? $t('Native model')}</span><span class="muted">{current?.thinkingLevel ? $t(current.thinkingLevel) : ''}</span><span aria-hidden="true">⌄</span>
  </button>
  {#if open}
    <section class="popover" aria-label={$t('Model and reasoning')} aria-busy={busy}>
      <label>{$t('Model')}<select aria-label={$t('Model')} disabled={busy || !current} value={current?.models.findIndex(entry => entry.id === model?.id && entry.provider === model?.provider) ?? -1} onchange={(event) => update(Number(event.currentTarget.value))}>
        {#if !current}<option value="-1">{$t('Loading…')}</option>{/if}
        {#each current?.models ?? [] as entry, index}<option value={index}>{entry.name}{entry.provider ? ` · ${entry.provider}` : ''}</option>{/each}
      </select></label>
      {#if levels.length}<label>{$t('Reasoning')}<select aria-label={$t('Reasoning')} value={current?.thinkingLevel ?? ''} disabled={busy} onchange={(event) => update(undefined, event.currentTarget.value)}><option value="" disabled>{$t('Model default')}</option>{#each levels as level}<option value={level}>{$t(level)}</option>{/each}</select></label>{/if}
      {#if current?.serviceTier}<button class="speed" type="button" aria-pressed={current.serviceTier === 'fast'} disabled={busy} onclick={() => update(undefined, undefined, current?.serviceTier === 'fast' ? 'standard' : 'fast')}><span><span class="bolt" aria-hidden="true">ϟ</span> Fast</span><span>{$t(current.serviceTier === 'fast' ? 'On' : 'Off')}</span></button>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
    </section>
  {/if}
</div>
<style>
  .runtime-picker { position:relative; min-width:0; }
  .trigger { display:flex; align-items:center; gap:7px; border:0; background:transparent; padding:6px 8px; color:var(--piui-text); font-size:12px; border-radius:7px; max-width:100%; }
  .trigger:hover { background:var(--piui-bg-raised); }
  .trigger > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .muted { color:var(--piui-text-muted); }
  .bolt { color:var(--piui-accent); }
  .popover { position:absolute; bottom:calc(100% + 10px); left:0; z-index:20; width:280px; max-width:calc(100vw - 48px); background:var(--piui-bg-raised); border:1px solid var(--piui-border-subtle); border-radius:12px; padding:14px; box-shadow:0 8px 28px #0005; display:grid; gap:12px; }
  label { display:grid; gap:6px; font-size:11px; color:var(--piui-text-muted); }
  select { width:100%; padding:8px; background:var(--piui-bg); border:1px solid var(--piui-border-subtle); color:var(--piui-text); border-radius:7px; font-size:12px; }
  .speed { display:flex; align-items:center; justify-content:space-between; padding:8px; background:transparent; border:1px solid var(--piui-border-subtle); color:var(--piui-text); border-radius:7px; }
  .speed[aria-pressed=true] { border-color:var(--piui-accent); }
  p { font-size:12px; color:var(--piui-text); margin:0; }
</style>
