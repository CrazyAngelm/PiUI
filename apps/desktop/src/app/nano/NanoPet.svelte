<script lang="ts">
  import { clipFor, NANO_PET_ATLAS, type NanoPetState } from './nanoPet';

  interface Props {
    state?: NanoPetState;
    /** Width of one cell in pixels; the height follows the atlas cell (96x104). */
    size?: number;
  }
  let { state = 'idle', size = 32 }: Props = $props();

  const clip = $derived(clipFor(state));
</script>

<!--
  The pet is decoration: the chat's status already says what the agent does.
  Pure CSS sprite: the row is the state, steps() walks its frames, and
  reduced motion keeps the first frame. Custom properties are set through the
  CSSOM (style: directives), which the desktop CSP allows.
-->
<span
  class="pet"
  class:pet--idle={state === 'idle'}
  aria-hidden="true"
  data-state={state}
  style:--pet-size={size}
  style:--pet-row={clip.row}
  style:--pet-frames={clip.frames}
  style:--pet-ms={clip.ms}
  style:--pet-repeat={clip.repeat ?? 'infinite'}
  style:--pet-columns={NANO_PET_ATLAS.columns}
  style:--pet-rows={NANO_PET_ATLAS.rows}
></span>

<style>
  .pet {
    --cell-w: calc(var(--pet-size) * 1px);
    --cell-h: calc(var(--pet-size) * 1px * 104 / 96);
    display: inline-block;
    flex: none;
    width: var(--cell-w);
    height: var(--cell-h);
    background-image: url('../../assets/nano/atlas.small.webp');
    background-repeat: no-repeat;
    background-size: calc(var(--cell-w) * var(--pet-columns)) calc(var(--cell-h) * var(--pet-rows));
    background-position: 0 calc(var(--cell-h) * var(--pet-row) * -1);
    pointer-events: none;
    user-select: none;
    animation: pet-run calc(var(--pet-frames) * var(--pet-ms) * 1ms) steps(var(--pet-frames)) var(--pet-repeat);
  }
  @keyframes pet-run {
    from {
      background-position-x: 0;
    }
    to {
      background-position-x: calc(var(--cell-w) * var(--pet-frames) * -1);
    }
  }
  /*
    Rest breathes on the open-eyed frames (0 1 3 4 5) and blinks once (frame 2)
    every six seconds; walking the row would blink on every lap.
  */
  .pet--idle {
    animation: pet-rest 6s steps(1, end) infinite;
  }
  @keyframes pet-rest {
    0% {
      background-position-x: 0;
    }
    17% {
      background-position-x: calc(var(--cell-w) * -1);
    }
    34% {
      background-position-x: calc(var(--cell-w) * -3);
    }
    50% {
      background-position-x: calc(var(--cell-w) * -4);
    }
    66% {
      background-position-x: calc(var(--cell-w) * -5);
    }
    82% {
      background-position-x: 0;
    }
    94% {
      background-position-x: calc(var(--cell-w) * -2);
    }
    97% {
      background-position-x: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pet,
    .pet--idle {
      animation: none;
    }
  }
  :global(:root[data-reduced-motion='reduce']) .pet,
  :global(:root[data-reduced-motion='reduce']) .pet--idle {
    animation: none;
  }
</style>
