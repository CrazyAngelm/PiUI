<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import { t } from '../../features/locale/language';
  import { harnessModels } from '../../host-api/harnessModels';
  import { Button } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';
  import { ClaudeSignInCheck, SIGNED_OUT_COPY, cachedSignedOut, copyParts } from './claudeSignIn.svelte';

  /**
   * Compact Claude Code sign-in status under the new-chat composer. It starts
   * from the host's cached verdict and never checks on its own: "Check again"
   * runs a catalog-only check of the user's `claude` CLI (no conversation, no
   * model turn). With `observe`, it follows the catalog request the composer
   * makes for its model picker, sharing it instead of starting another.
   */
  interface Props {
    workspaceId: string;
    observe?: boolean;
  }
  let { workspaceId, observe = false }: Props = $props();
  const uid = $props.id();
  const store = useWorkspace();
  const status = new ClaudeSignInCheck((id, refresh) => harnessModels({ workspaceId: id, harness: 'claude-code' }, refresh));

  const cached = $derived(cachedSignedOut(store.catalog.harnesses));
  const signedOut = $derived(status.signedOut(cached));
  // Booleans, so catalog updates that change nothing here never re-run the effect.
  const checkable = $derived.by(() => {
    const workspace = store.catalog.workspaces.find((item) => item.id === workspaceId);
    return Boolean(workspace && !workspace.missing && (workspace.personal || workspace.trust === 'trusted')) && !store.safeMode;
  });
  const COMMANDS = ['claude', '/login'];

  $effect(() => {
    if (observe && checkable) void status.observe(workspaceId);
  });
</script>

{#if signedOut || status.failed || status.checking || status.confirmed}
  <div class="signin" class:signin--ok={!signedOut && !status.failed}>
    <span class="signin__text" id="{uid}-status" role="status">
      {#if signedOut}
        <CircleAlert size={14} aria-hidden="true" />
        <span>
          {#each copyParts($t(SIGNED_OUT_COPY)) as part, index (index)}
            {#if part.code !== undefined}<code>{COMMANDS[part.code] ?? part.text}</code>{:else}{part.text}{/if}
          {/each}
        </span>
      {:else if status.checking}
        <span>{$t('Checking the Claude Code sign-in…')}</span>
      {:else if status.failed}
        <CircleAlert size={14} aria-hidden="true" />
        <span>{$t('Could not check the Claude Code sign-in.')}</span>
      {:else}
        <CircleCheck size={14} aria-hidden="true" />
        <span>{$t('Claude Code is signed in with your Claude subscription.')}</span>
      {/if}
    </span>
    {#if (signedOut || status.failed || status.checking) && checkable}
      <Button
        size="sm"
        variant="ghost"
        loading={status.checking}
        disabled={status.checking}
        aria-describedby="{uid}-status"
        onclick={() => void status.check(workspaceId)}
      >
        {$t('Check again')}
      </Button>
    {/if}
  </div>
{/if}

<style>
  .signin {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
    margin: var(--piui-space-2) 4px 0;
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .signin--ok {
    color: var(--piui-text-muted);
  }
  .signin__text {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .signin__text :global(svg) {
    flex: none;
  }
  code {
    padding: 0 4px;
    border-radius: var(--piui-radius-xs);
    background: var(--piui-surface-2);
    font-family: var(--piui-font-mono);
    font-size: 0.95em;
  }
</style>
