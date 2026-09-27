<script lang="ts">
  import { onMount } from 'svelte';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import FileArchive from '@lucide/svelte/icons/file-archive';
  import Wrench from '@lucide/svelte/icons/wrench';
  import type { PluginEntryV1, PluginReviewV1, PluginsCommandV1 } from '../../../../../contracts/plugins-v1';
  import { t } from '../../features/locale/language';
  import { pluginsError } from '../../host-api/pluginsClient';
  import { Button, Dialog, EmptyState, Skeleton, toasts } from '../../lib/ui';
  import PluginCard from './PluginCard.svelte';
  import PluginSettingsDialog from './PluginSettingsDialog.svelte';
  import PluginTrustDialog from './PluginTrustDialog.svelte';
  import { pluginRegistry, type PluginRegistry } from './pluginRegistry.svelte';

  /**
   * Settings → Plugins (ADR-032): install from a folder or a .zip, load an
   * unpacked folder for development, review every permission before trust,
   * enable, disable, remove, reload and restart. Safe mode lists plugins
   * read-only. Nothing here runs plugin code; the host does, after trust.
   */
  interface Props {
    /** Injected by tests; the shared registry otherwise. */
    registry?: PluginRegistry;
  }
  let { registry = pluginRegistry }: Props = $props();

  onMount(() => {
    void registry.start();
  });

  let busy = $state('');
  let review = $state.raw<PluginReviewV1>();
  let reviewOpen = $state(false);
  let reviewError = $state('');
  let settingsFor = $state.raw<PluginEntryV1>();
  let settingsOpen = $state(false);
  let removing = $state.raw<PluginEntryV1>();
  let removeOpen = $state(false);

  const safeMode = $derived(registry.safeMode);
  const plugins = $derived(registry.plugins);

  function failure(cause: unknown): string {
    const error = pluginsError(cause);
    const problems = error.problems.map((problem) => `${$t(problem.message, [problem.subject ?? ''])}${problem.detail ? ` ${$t(problem.detail)}` : ''}`);
    return [$t(error.message), ...problems].join(' ');
  }

  async function act(key: string, command: PluginsCommandV1, done: string | undefined = undefined): Promise<boolean> {
    if (busy) return false;
    busy = key;
    try {
      const response = await registry.run(command);
      if (response.review) {
        review = response.review;
        reviewError = '';
        reviewOpen = true;
      }
      if (done) toasts.success($t(done));
      return true;
    } catch (cause) {
      toasts.error($t('The plugin change did not go through'), failure(cause));
      return false;
    } finally {
      busy = '';
    }
  }

  async function pick(source: 'folder' | 'zip' | 'development'): Promise<void> {
    await act(`pick:${source}`, { type: 'pick', source });
  }

  async function confirmReview(): Promise<void> {
    if (!review || busy) return;
    busy = 'install';
    reviewError = '';
    try {
      await registry.run({ type: 'install', expectedRevision: registry.revision, stagingId: review.stagingId, codeHash: review.codeHash });
      toasts.success(review.source === 'development' ? $t('Plugin loaded for development') : review.update ? $t('Plugin updated') : $t('Plugin installed'), review.name);
      reviewOpen = false;
      review = undefined;
    } catch (cause) {
      reviewError = failure(cause);
    } finally {
      busy = '';
    }
  }

  function cancelReview(): void {
    const current = review;
    reviewOpen = false;
    review = undefined;
    // The host drops the staged copy; nothing was installed.
    if (current) void registry.run({ type: 'discard', stagingId: current.stagingId }).catch(() => undefined);
  }

  async function confirmRemove(): Promise<void> {
    if (!removing) return;
    if (await act(`remove:${removing.id}`, { type: 'remove', expectedRevision: registry.revision, id: removing.id }, 'Plugin removed')) {
      removeOpen = false;
      removing = undefined;
    }
  }
</script>

<div class="title-row">
  <h2>{$t('Plugins')}</h2>
  <div class="buttons">
    <Button size="sm" disabled={safeMode || !!busy} loading={busy === 'pick:folder'} onclick={() => void pick('folder')}>
      {#snippet leading()}<FolderOpen />{/snippet}
      {$t('Install from folder…')}
    </Button>
    <Button size="sm" disabled={safeMode || !!busy} loading={busy === 'pick:zip'} onclick={() => void pick('zip')}>
      {#snippet leading()}<FileArchive />{/snippet}
      {$t('Install from .zip…')}
    </Button>
    <Button size="sm" variant="ghost" disabled={safeMode || !!busy} loading={busy === 'pick:development'} onclick={() => void pick('development')}>
      {#snippet leading()}<Wrench />{/snippet}
      {$t('Load unpacked…')}
    </Button>
  </div>
</div>
<p class="lead">
  {$t('Plugins add commands, chat panels, themes, pipeline templates, pipeline nodes and ACP agents. You review every permission before a plugin is installed. Plugins are not a sandbox: install only plugins you trust.')}
</p>
{#if safeMode}
  <p class="notice" role="status">{$t('Safe mode: plugins are listed, but none is active and changes are off.')}</p>
{:else if registry.registry && !registry.registry.checked}
  <p class="notice" role="status">{$t('Checking installed plugins…')}</p>
{/if}
{#if registry.error}<p class="error" role="alert">{$t(registry.error)}</p>{/if}

{#if registry.loading && !registry.registry}
  <Skeleton lines={4} />
{:else if plugins.length === 0}
  <EmptyState title={$t('No plugins yet')} description={$t('Install a plugin from a folder or a .zip package, or load a folder you are developing. The PiUI repository has examples in examples/plugins.')} />
{:else}
  <div class="list">
    {#each plugins as plugin (plugin.id)}
      <PluginCard
        {plugin}
        {safeMode}
        busy={!!busy}
        onToggle={(enabled) => void act(`toggle:${plugin.id}`, { type: 'setEnabled', expectedRevision: registry.revision, id: plugin.id, enabled })}
        onSettings={() => {
          settingsFor = plugin;
          settingsOpen = true;
        }}
        onReload={() => void act(`reload:${plugin.id}`, { type: 'reload', expectedRevision: registry.revision, id: plugin.id }, 'Plugin reloaded')}
        onRestart={() => void act(`restart:${plugin.id}`, { type: 'restartBackend', id: plugin.id }, 'The backend starts again on next use')}
        onOfferMcp={(serverId, offered) =>
          void act(
            `mcp:${plugin.id}:${serverId}`,
            { type: 'setMcpOffered', expectedRevision: registry.revision, id: plugin.id, serverId, offered },
            offered ? 'New chats that can take it get this tool server' : 'New chats no longer get this tool server',
          )}
        onRemove={() => {
          removing = plugin;
          removeOpen = true;
        }}
      />
    {/each}
  </div>
{/if}

{#if review}
  <PluginTrustDialog bind:open={reviewOpen} {review} busy={busy === 'install'} error={reviewError} onConfirm={() => void confirmReview()} onCancel={cancelReview} />
{/if}

{#if settingsFor && settingsOpen}
  <PluginSettingsDialog bind:open={settingsOpen} plugin={settingsFor} />
{/if}

<Dialog
  bind:open={removeOpen}
  title={removing ? $t('Remove {0}?', [removing.name]) : ''}
  description={removing?.source === 'development'
    ? $t('PiUI forgets this plugin and its settings. Your folder is not touched.')
    : $t('PiUI stops the plugin, deletes its installed copy and its settings.')}
  size="sm"
  closeLabel={$t('Close')}
>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (removeOpen = false)} disabled={!!busy}>{$t('Cancel')}</Button>
    <Button variant="danger" loading={busy.startsWith('remove:')} onclick={() => void confirmRemove()}>{$t('Remove')}</Button>
  {/snippet}
</Dialog>

<style>
  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
  }
  h2 {
    margin: 0;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
  }
  .lead {
    margin: 0;
    color: var(--piui-text-muted);
  }
  .notice {
    margin: 0;
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
  }
  .error {
    margin: 0;
    color: var(--piui-danger-text);
  }
  .list {
    display: grid;
    gap: var(--piui-space-3);
  }
</style>
