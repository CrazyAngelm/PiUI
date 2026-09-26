<script lang="ts">
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import type { AcpAgentEntryV1 } from '../../../../../contracts/harness-registry-v1';
  import { t } from '../../features/locale/language';
  import { Button } from '../../lib/ui';

  /**
   * What a trust decision covers: the exact program and arguments PiUI will
   * start, the environment names it passes and what trust does not mean.
   */
  interface Props {
    agent: AcpAgentEntryV1;
    error: string | undefined;
    onReview: () => void;
  }
  let { agent, error, onReview }: Props = $props();
  const uid = $props.id();

  const line = $derived(agent.commandLine);
  const secrets = $derived(agent.secretEnvironment);
  const names = $derived(agent.descriptor.environment ?? []);
</script>

<div class="review">
  {#if line}
    <section aria-labelledby="{uid}-command">
      <h3 id="{uid}-command">{$t('Command line')}</h3>
      <dl class="command">
        <div><dt>{$t('Program')}</dt><dd><code>{line.program}</code></dd></div>
        <div>
          <dt>{$t('Arguments')}</dt>
          <dd>
            {#if line.args.length > 0}
              <ol>{#each line.args as arg, index (index)}<li><code>{arg}</code></li>{/each}</ol>
            {:else}
              <span class="muted">{$t('None')}</span>
            {/if}
          </dd>
        </div>
      </dl>
    </section>
  {/if}
  <section aria-labelledby="{uid}-environment">
    <h3 id="{uid}-environment">{$t('Environment variables')}</h3>
    {#if names.length > 0}
      <p>{$t('PiUI passes these names from your environment. It never reads, shows or stores their values.')}</p>
      <p><code>{names.join(', ')}</code></p>
      {#if secrets.length > 0}
        <p class="muted">{$t('Secret-like names ({0}) pass only after you allow them separately.', [secrets.join(', ')])}</p>
      {/if}
    {:else}
      <p class="muted">{$t('Only the basic environment (locations, locale and PATH). No keys or tokens.')}</p>
    {/if}
  </section>
  <p class="warning">
    <ShieldAlert size={16} aria-hidden="true" />
    <span>{$t('Trust is not a sandbox. The agent runs with your user account’s permissions and keeps its own tools, network access and credentials. PiUI runs this command now to read its version, and later to start chats.')}</span>
  </p>
  <p class="muted small">{$t('Descriptor fingerprint: {0}', [agent.fingerprint.slice(0, 16)])}</p>
  {#if error}
    <div class="error" role="alert">
      <p>{$t(error)}</p>
      <Button size="sm" onclick={onReview}>{$t('Review the current command')}</Button>
    </div>
  {/if}
</div>

<style>
  .review {
    display: grid;
    gap: var(--piui-space-4);
    line-height: var(--piui-leading-normal);
  }
  h3 {
    margin: 0 0 var(--piui-space-2);
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  p {
    margin: 0;
  }
  section p + p {
    margin-top: var(--piui-space-2);
  }
  .command {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-code-surface);
  }
  .command div {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: var(--piui-space-3);
  }
  .command dt {
    color: var(--piui-text-muted);
  }
  .command dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  ol {
    display: grid;
    gap: 2px;
    margin: 0;
    padding-left: var(--piui-space-5);
  }
  code {
    font-family: var(--piui-font-mono);
    font-size: 0.95em;
  }
  .warning {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-warning-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
  }
  .warning :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .small {
    font-size: var(--piui-text-sm);
  }
  .error {
    display: grid;
    gap: var(--piui-space-2);
    justify-items: start;
    color: var(--piui-danger-text);
  }
</style>
