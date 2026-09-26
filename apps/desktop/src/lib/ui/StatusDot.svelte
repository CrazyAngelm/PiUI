<script lang="ts" module>
  export type Status = 'idle' | 'running' | 'waiting' | 'failed' | 'done' | 'offline';
</script>

<script lang="ts">
  interface Props {
    status: Status;
    label?: string;
  }
  let { status, label }: Props = $props();
</script>

<span
  class="dot dot--{status}"
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
></span>

<style>
  .dot {
    position: relative;
    display: inline-block;
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--piui-text-disabled);
  }
  .dot--done {
    background: var(--piui-success);
  }
  .dot--failed {
    background: var(--piui-danger);
  }
  .dot--waiting {
    background: var(--piui-warning);
  }
  .dot--offline {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--piui-text-disabled);
  }
  .dot--running {
    background: var(--piui-accent);
  }
  .dot--running::after {
    content: '';
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 1.5px solid var(--piui-accent);
    opacity: 0;
    animation: pulse 1.6s var(--piui-ease-out) infinite;
  }
  @keyframes pulse {
    0% {
      transform: scale(0.6);
      opacity: 0.8;
    }
    100% {
      transform: scale(1.5);
      opacity: 0;
    }
  }
  :global(:root[data-reduced-motion='reduce']) .dot--running::after {
    animation: none;
  }
</style>
