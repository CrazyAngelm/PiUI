<script lang="ts">
  interface Props {
    width?: string;
    height?: string;
    radius?: string;
    lines?: number;
  }
  let { width = '100%', height = '12px', radius = 'var(--piui-radius-xs)', lines = 1 }: Props = $props();
</script>

<span class="skeleton-group" aria-hidden="true">
  {#each Array.from({ length: lines }, (_, index) => index) as index (index)}
    <span
      class="skeleton"
      style:width={lines > 1 && index === lines - 1 ? '60%' : width}
      style:height
      style:border-radius={radius}
    ></span>
  {/each}
</span>

<style>
  .skeleton-group {
    display: grid;
    gap: 8px;
    width: 100%;
  }
  .skeleton {
    display: block;
    background: linear-gradient(90deg, var(--piui-surface-1), var(--piui-surface-2), var(--piui-surface-1));
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -200% 0;
    }
  }
  :global(:root[data-reduced-motion='reduce']) .skeleton {
    animation: none;
  }
</style>
