<script lang="ts">
  import { shortcutParts } from './keys';

  interface Props {
    /** Shortcut such as "Ctrl+K" or "Mod+Shift+M"; Mod maps to the platform key. */
    keys: string;
    tone?: 'default' | 'inverse';
  }
  let { keys, tone = 'default' }: Props = $props();
  const parts = $derived(shortcutParts(keys));
</script>

<span class="kbd kbd--{tone}" aria-label={parts.join('+')}>
  {#each parts as part (part)}<kbd>{part}</kbd>{/each}
</span>

<style>
  .kbd {
    display: inline-flex;
    gap: 2px;
    flex: none;
  }
  kbd {
    min-width: 16px;
    padding: 1px 4px;
    border: 1px solid var(--piui-border);
    border-bottom-width: 2px;
    border-radius: var(--piui-radius-xs);
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
    font-family: var(--piui-font-ui);
    font-size: 10px;
    line-height: 1.4;
    text-align: center;
  }
  .kbd--inverse kbd {
    background: var(--piui-surface-2);
  }
</style>
