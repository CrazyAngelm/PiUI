<script lang="ts">
  import Expand from '@lucide/svelte/icons/expand';
  import { useTranslation } from '../../features/locale/context';
  import type { TimelineBlock } from '../../host-api/types';
  import { Button } from '../../lib/ui';
  import { useAnswerSource } from './answerSource';
  const t = useTranslation();
  const answers = useAnswerSource();

  let { block, printMode = false }: { block: TimelineBlock; printMode?: boolean } = $props();
  // A shortened answer says so, wherever it is shown, and offers the full text when the history can be read.
  const shortened = $derived(block.kind === 'assistant' && block.truncated === true && answers.full(block.id) === undefined);
</script>

{#if shortened}
  <div class="shortened" role="note">
    <span>{$t('This answer was shortened to keep the chat responsive.')}</span>
    {#if answers.canLoad() && !printMode}
      <Button size="sm" variant="ghost" onclick={() => void answers.load(block)} loading={answers.busy(block.id)}>
        {#snippet leading()}<Expand />{/snippet}
        {$t('Show full answer')}
      </Button>
    {/if}
  </div>
{/if}

<style>
  .shortened {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
    margin: 4px 0 0;
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
</style>
