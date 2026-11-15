<script lang="ts" module>
  import type { MarkShape } from './marks.svelte';

  /** Outlines on a 16 by 16 grid. */
  export const SHAPE_PATHS: Record<MarkShape, string> = {
    circle: 'M8 1.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13z',
    square: 'M4 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
    diamond: 'M8 1l7 7l-7 7l-7-7z',
    triangle: 'M8 2l7 12H1z',
    star: 'M8 1l2 4.9l5 .3l-3.9 3.3l1.3 5.1L8 11.9l-4.4 2.7l1.3-5.1L1 6.2l5-.3z',
    hexagon: 'M8 1l6 3.5v7L8 15l-6-3.5v-7z',
  };
</script>

<script lang="ts">
  import type { Mark } from './marks.svelte';

  interface Props {
    mark: Mark;
    size?: number;
  }
  let { mark, size = 14 }: Props = $props();
</script>

{#if mark.kind === 'emoji'}
  <span class="mark mark--emoji" data-mark="emoji" style="--mark-size: {size}px" aria-hidden="true">{mark.value}</span>
{:else}
  <svg class="mark" data-mark={mark.shape} data-mark-color={mark.color} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d={SHAPE_PATHS[mark.shape]} style="fill: var(--piui-mark-{mark.color})" />
  </svg>
{/if}

<style>
  .mark {
    flex: none;
  }
  .mark--emoji {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--mark-size);
    height: var(--mark-size);
    font-size: calc(var(--mark-size) * 0.86);
    line-height: 1;
  }
</style>
