<script lang="ts">
  import ImageIcon from '@lucide/svelte/icons/image';
  import { thumbnail } from './thumbnails';

  interface Props {
    /** Pending attachment id. */
    id: string;
    /** Accessible name of the preview. */
    label: string;
    /** Rendered edge length in CSS pixels. */
    size?: number;
  }
  let { id, label, size = 36 }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);
  let failed = $state(false);

  // Drawn from decoded bytes: no image URL, so the desktop CSP needs no change.
  $effect(() => {
    const target = canvas;
    const current = id;
    if (target === null) return;
    let cancelled = false;
    void thumbnail(current).then((bitmap) => {
      if (cancelled) return;
      const context = bitmap ? target.getContext('2d') : null;
      if (!bitmap || !context) {
        failed = true;
        return;
      }
      const ratio = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3);
      const edge = Math.round(size * ratio);
      target.width = edge;
      target.height = edge;
      const scale = Math.max(edge / bitmap.width, edge / bitmap.height);
      const width = bitmap.width * scale;
      const height = bitmap.height * scale;
      context.drawImage(bitmap, (edge - width) / 2, (edge - height) / 2, width, height);
    });
    return () => {
      cancelled = true;
    };
  });
</script>

<span class="thumb" class:thumb--fallback={failed} role="img" aria-label={label}>
  {#if failed}
    <ImageIcon size={16} />
  {:else}
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
  {/if}
</span>

<style>
  .thumb {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 36px;
    height: 36px;
    overflow: hidden;
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-2);
  }
  .thumb canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .thumb--fallback {
    color: var(--piui-text-muted);
  }
</style>
