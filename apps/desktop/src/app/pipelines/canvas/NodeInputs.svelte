<script lang="ts">
  import { useTranslation } from '../../../features/locale/context';
  const t = useTranslation();
  import type { NodeInput } from './wireHue';

  interface Props {
    inputs: readonly NodeInput[];
    /** The source of a connection that has just landed. */
    fresh: string | undefined;
  }
  let { inputs, fresh }: Props = $props();
  const LIMIT = 6;
  // Keep a just-connected source visible even past the limit.
  const shown = $derived.by(() => {
    const first = inputs.slice(0, LIMIT);
    const landed = inputs.find((input) => input.id === fresh);
    return landed && !first.includes(landed) ? [...first.slice(0, LIMIT - 1), landed] : first;
  });
  const rest = $derived(inputs.filter((input) => !shown.includes(input)));
  const restNames = $derived(rest.map((input) => input.name).join(', '));
</script>

{#if inputs.length}
  <ul class="piui-node-inputs" aria-label={$t('Inputs')}>
    {#each shown as input (input.id)}
      <li class:piui-node-inputs__fresh={input.id === fresh} style:--wire={input.wire} title={input.name}>
        <span class="piui-node-inputs__dot" aria-hidden="true"></span>
        <span class="visually-hidden">{input.name}</span>
      </li>
    {/each}
    {#if rest.length > 0}
      <li class="piui-node-inputs__more" title={restNames}>
        <span aria-hidden="true">+{rest.length}</span>
        <span class="visually-hidden">{restNames}</span>
      </li>
    {/if}
  </ul>
{/if}
