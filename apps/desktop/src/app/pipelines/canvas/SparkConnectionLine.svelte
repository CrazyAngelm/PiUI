<script lang="ts">
  import { getBezierPath, Position, useConnection, useSvelteFlow } from '@xyflow/svelte';
  import { sparkPath } from './wireHue';

  // Drawn by Svelte Flow only while a connection is being dragged, inside the
  // viewport: `from` and `to` are flow coordinates, `pointer` is container pixels.
  const connection = useConnection();
  const flow = useSvelteFlow();
  const live = $derived(connection.current);
  let seed = $state(1);
  let reduced = $state(false);

  function reducedMotion(): boolean {
    return (
      document.documentElement.dataset.reducedMotion === 'reduce' ||
      (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    );
  }

  const pointer = $derived.by(() => {
    if (!live.inProgress) return { x: 0, y: 0 };
    const { x, y, zoom } = flow.getViewport();
    return { x: (live.pointer.x - x) / zoom, y: (live.pointer.y - y) / zoom };
  });
  const snapped = $derived(live.inProgress && live.isValid === true && live.toHandle !== null);
  // Re-jitter the arc so it crackles, but only while it is drawn (hovering a valid port)
  // and motion is allowed. The cleanup stops the timer when the arc goes away or this
  // component unmounts (Svelte Flow removes the line as soon as the drag ends).
  $effect(() => {
    const sync = (): void => {
      reduced = reducedMotion();
    };
    sync();
    const query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    query?.addEventListener('change', sync);
    const setting = new MutationObserver(sync);
    setting.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] });
    return () => {
      query?.removeEventListener('change', sync);
      setting.disconnect();
    };
  });
  $effect(() => {
    if (!snapped || reduced) return;
    const timer = setInterval(() => (seed = (seed % 9973) + 1), 55);
    return () => clearInterval(timer);
  });
  // Step cards carry their wire color in node data (see FlowCanvas). A wire takes
  // its source's color: dragged back from an input, that is the node it lands on.
  const source = $derived(live.inProgress ? (live.fromHandle?.type === 'target' ? live.toNode : live.fromNode) : null);
  const color = $derived((typeof source?.data.wire === 'string' ? source.data.wire : '') || 'var(--piui-wire-idle)');
  const wire = $derived.by(() => {
    if (!live.inProgress) return '';
    const end = snapped ? pointer : live.to;
    const [path] = getBezierPath({
      sourceX: live.from.x,
      sourceY: live.from.y,
      sourcePosition: live.fromPosition,
      targetX: end.x,
      targetY: end.y,
      targetPosition: snapped ? live.toPosition : live.fromPosition === Position.Right ? Position.Left : Position.Right,
      curvature: 0.35,
    });
    return path;
  });
  const arc = $derived(live.inProgress && snapped ? sparkPath(pointer, live.to, seed) : '');
</script>

{#if live.inProgress}
  <g class="spark-line" class:spark-line--snapped={snapped} style:--wire={color}>
    <path class="spark-line__wire" d={wire} />
    <circle class="spark-line__from" cx={live.from.x} cy={live.from.y} r="4.5" />
    {#if snapped}
      <path class="spark-line__glow" d={arc} />
      <path class="spark-line__arc" d={arc} />
      <circle class="spark-line__ring" cx={live.to.x} cy={live.to.y} r="11" />
      <circle class="spark-line__tip" cx={pointer.x} cy={pointer.y} r="3" />
    {/if}
  </g>
{/if}

<style>
  .spark-line {
    pointer-events: none;
  }
  .spark-line__wire {
    fill: none;
    stroke: var(--piui-wire-idle);
    stroke-width: 2.2;
    stroke-linecap: round;
    filter: drop-shadow(0 0 2px color-mix(in srgb, var(--piui-wire-idle) 45%, transparent));
  }
  .spark-line__from {
    fill: var(--piui-wire-idle);
    stroke: var(--piui-bg);
    stroke-width: 2;
  }
  .spark-line__glow {
    fill: none;
    stroke: var(--wire);
    stroke-width: 6;
    stroke-linejoin: round;
    opacity: 0.35;
    filter: blur(3px);
  }
  .spark-line__arc {
    fill: none;
    stroke: var(--wire);
    stroke-width: 1.8;
    stroke-linejoin: round;
    stroke-linecap: round;
    filter: drop-shadow(0 0 4px var(--wire));
  }
  .spark-line__ring {
    fill: color-mix(in srgb, var(--wire) 12%, transparent);
    stroke: var(--wire);
    stroke-width: 1.5;
    filter: drop-shadow(0 0 6px var(--wire));
    transform-box: fill-box;
    transform-origin: center;
    animation: spark-ring 0.9s var(--piui-ease-out, ease-out) infinite;
  }
  .spark-line__tip {
    fill: var(--piui-wire-idle);
  }
  @keyframes spark-ring {
    0% {
      transform: scale(0.75);
      opacity: 1;
    }
    100% {
      transform: scale(1.25);
      opacity: 0.55;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spark-line__ring {
      animation: none;
    }
  }
  :global(:root[data-reduced-motion='reduce']) .spark-line__ring {
    animation: none;
  }
</style>
