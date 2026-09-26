<script lang="ts">
  import { harnessMeta } from '../harnessMeta';

  interface Props {
    kind: string;
    size?: number;
    /** Decorative when the harness name is already visible next to it. */
    decorative?: boolean;
  }
  let { kind, size = 18, decorative = true }: Props = $props();
  const meta = $derived(harnessMeta(kind));
</script>

<span
  class="mark"
  style:--hue={meta.hue}
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{Math.round(size * 0.58)}px"
  role={decorative ? undefined : 'img'}
  aria-label={decorative ? undefined : meta.label}
  aria-hidden={decorative ? 'true' : undefined}
>{meta.monogram}</span>

<style>
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 5px;
    background: color-mix(in srgb, var(--hue) 16%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--hue) 30%, transparent);
    color: var(--hue);
    font-weight: var(--piui-weight-semibold);
    line-height: 1;
  }
  :global(:root[data-theme='light']) .mark {
    color: color-mix(in srgb, var(--hue) 55%, #202020);
  }
</style>
