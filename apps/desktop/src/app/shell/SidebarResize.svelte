<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../features/locale/language';
  import PaneSplitter from './panes/PaneSplitter.svelte';

  let { onWidth }: { onWidth: (width: number | undefined) => void } = $props();
  const widthKey = 'piui.shell.sidebar.width';
  let preferred = $state(readWidth());
  let divider: HTMLDivElement;
  let available = $state(0);
  let layout = $state({ rail: 0, sidebar: 0, workArea: 0 });
  const minimum = $derived(layout.sidebar - layout.rail);
  const maximum = $derived(Math.max(minimum, available - layout.workArea));
  const width = $derived(clamp(preferred ?? layout.sidebar));
  const ready = $derived(layout.sidebar > 0 && available > 0);

  function readWidth(): number | undefined {
    try {
      const saved = Number(localStorage.getItem(widthKey));
      return Number.isFinite(saved) && saved > 0 ? saved : undefined;
    } catch {
      return undefined;
    }
  }

  function clamp(value: number): number {
    return Math.round(Math.max(minimum, Math.min(maximum, value)));
  }

  function resize(value: number | undefined): void {
    const next = value === undefined ? undefined : clamp(value);
    if (preferred === next) return;
    preferred = next;
    try {
      if (next === undefined) localStorage.removeItem(widthKey);
      else localStorage.setItem(widthKey, String(next));
    } catch {
      // Resizing remains available when persistent storage is blocked.
    }
  }

  onMount(() => {
    const tokens = getComputedStyle(divider);
    layout = {
      rail: parseFloat(tokens.getPropertyValue('--piui-rail-width')),
      sidebar: parseFloat(tokens.getPropertyValue('--piui-sidebar-width')),
      workArea: parseFloat(tokens.getPropertyValue('--piui-panel-width')),
    };
    return () => onWidth(undefined);
  });

  $effect(() => {
    if (ready) onWidth(width);
  });
</script>

<div class="sidebar-resize" bind:this={divider} bind:clientWidth={available}>
  {#if ready}
    <span style:width="{width}px"></span>
    <PaneSplitter
      direction="row"
      ratio={width / available}
      label={$t('Resize sidebar')}
      controls="workspace-sidebar"
      bounds={{ min: minimum / available, max: maximum / available }}
      onResize={(ratio) => resize(available * ratio)}
      onReset={() => resize(undefined)}
    />
  {/if}
</div>

<style>
  .sidebar-resize {
    position: absolute;
    inset: 0 0 0 var(--piui-rail-width);
    display: flex;
    pointer-events: none;
  }
  .sidebar-resize :global(.splitter) {
    pointer-events: auto;
  }
</style>
