<script lang="ts">
  import { t } from '../../features/locale/language';
  import type { WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import NewChatComposer from './NewChatComposer.svelte';
  import { newChatPlacement } from '../worktrees/newChatPlacement.svelte';
  import { useWorkspace } from './context';

  interface Props {
    onTrust: (workspace: WorkspaceSummary) => void;
  }
  let { onTrust }: Props = $props();
  const store = useWorkspace();
  const loadHandoffBanner = () => import('../handoff/HandoffBanner.svelte');

  const noHarness = $derived(!store.catalogLoading && !store.catalog.harnesses.some((item) => item.status === 'available'));
</script>

<section class="home" aria-labelledby="home-title">
  <div class="home__inner">
    <div class="hero">
      <h1 id="home-title">{$t('What should we work on?')}</h1>
      {#if noHarness}
        <p class="hero__hint">
          {$t('No agent harness is ready yet.')}
          <button type="button" class="link" onclick={() => store.navigate({ name: 'settings', section: 'harnesses' })}>{$t('Set up harnesses')}</button>
        </p>
      {/if}
    </div>

    {#if newChatPlacement.handoff}
      <!-- "Continue in another harness": loaded only when one is pending. -->
      {#await loadHandoffBanner() then banner}<banner.default />{/await}
    {/if}
    <!-- A handoff replaces the draft: the composer remounts to read it. -->
    {#key newChatPlacement.epoch}
      <NewChatComposer {onTrust} />
    {/key}
  </div>
</section>

<style>
  .home {
    height: 100%;
    overflow-y: auto;
  }
  .home__inner {
    width: min(760px, calc(100% - 48px));
    margin: 0 auto;
    padding: clamp(40px, 14vh, 140px) 0 var(--piui-space-12);
  }
  .hero {
    display: grid;
    justify-items: center;
    gap: var(--piui-space-3);
    margin-bottom: var(--piui-space-7);
    text-align: center;
  }
  h1 {
    margin: 0;
    font-size: var(--piui-text-3xl);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: -0.02em;
  }
  .hero__hint {
    margin: 0;
    color: var(--piui-text-muted);
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
  }
</style>
