<script lang="ts">
  import Blocks from '@lucide/svelte/icons/blocks';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import Trash from '@lucide/svelte/icons/trash-2';
  import type { PluginEntryV1 } from '../../../../../contracts/plugins-v1';
  import { t } from '../../features/locale/language';
  import { Badge, Button, Switch } from '../../lib/ui';
  import { BACKEND_STATE_TEXT, commandLineText, LOG_TEXT, PERMISSION_TEXT } from './permissions';

  /** One plugin in Settings → Plugins. */
  interface Props {
    plugin: PluginEntryV1;
    safeMode: boolean;
    busy: boolean;
    onToggle: (enabled: boolean) => void;
    onSettings: () => void;
    onReload: () => void;
    onRestart: () => void;
    onRemove: () => void;
  }
  let { plugin, safeMode, busy, onToggle, onSettings, onReload, onRestart, onRemove }: Props = $props();

  // "Label: count" needs no plural forms in either language.
  const counts = $derived(
    (
      [
        [plugin.contributes.commands.length, 'Commands: {0}'],
        [plugin.contributes.panels.length, 'Panels: {0}'],
        [plugin.contributes.themes.length, 'Themes: {0}'],
        [plugin.contributes.templates.length, 'Templates: {0}'],
        [plugin.contributes.nodeTypes.length, 'Pipeline nodes: {0}'],
        [plugin.contributes.acpAgents.length, 'ACP agents: {0}'],
      ] as const
    )
      .filter(([count]) => count > 0)
      .map(([count, text]) => $t(text, [count])),
  );
  const status = $derived(
    plugin.problems.length
      ? { tone: 'danger' as const, label: $t('Needs attention') }
      : plugin.active
        ? { tone: 'success' as const, label: $t('Active') }
        : plugin.enabled
          ? { tone: 'neutral' as const, label: safeMode ? $t('Off in safe mode') : $t('Checking') }
          : { tone: 'neutral' as const, label: $t('Disabled') },
  );
  const restartable = $derived(plugin.backend?.state === 'crashed' || plugin.backend?.state === 'crash-loop');
  // An agent whose id another agent already has is not added (the other one wins).
  const clashes = $derived(plugin.active ? plugin.contributes.acpAgents.filter((agent) => !agent.registered) : []);
</script>

<article class="card" aria-labelledby="plugin-{plugin.id}">
  <div class="head">
    <span class="icon" aria-hidden="true"><Blocks size={18} /></span>
    <div class="title">
      <h3 id="plugin-{plugin.id}">{plugin.name}</h3>
      <span class="meta">{plugin.publisher} · {$t('version {0}', [plugin.version])}</span>
    </div>
    <div class="badges">
      {#if plugin.source === 'development'}<Badge tone="warning">{$t('Development')}</Badge>{/if}
      <Badge tone={status.tone}>{status.label}</Badge>
    </div>
    <Switch
      label={$t('Enable {0}', [plugin.name])}
      hideLabel
      checked={plugin.enabled}
      disabled={safeMode || busy}
      onCheckedChange={(checked) => onToggle(checked)}
    />
  </div>

  {#if plugin.description}<p class="description">{plugin.description}</p>{/if}
  {#if plugin.source === 'development' && plugin.folder}
    <p class="dev">{$t('Runs from {0}. Code changes load with Reload; permission changes need a new review.', [plugin.folder])}</p>
  {/if}

  {#if plugin.problems.length}
    <ul class="problems" aria-label={$t('Problems')}>
      {#each plugin.problems as problem, index (index)}
        <li>{$t(problem.message, [problem.subject ?? ''])}{#if problem.detail} {$t(problem.detail)}{/if}</li>
      {/each}
    </ul>
  {/if}

  {#if counts.length}<p class="counts">{counts.join(' · ')}</p>{/if}
  {#each clashes as agent (agent.id)}
    <p class="muted">{$t('The ACP agent “{0}” was not added: another agent already uses its ID.', [agent.displayName])}</p>
  {/each}

  <details class="more">
    <summary>{$t('Permissions and backend')}</summary>
    <div class="more__body">
      {#if plugin.permissions.length}
        <ul class="permissions">
          {#each plugin.permissions as permission (permission)}
            <li>{$t(PERMISSION_TEXT[permission].label)}</li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{$t('This plugin asks for no permissions.')}</p>
      {/if}
      {#if plugin.backend}
        <p class="backend">
          <strong>{$t('Backend')}:</strong> {$t(BACKEND_STATE_TEXT[plugin.backend.state])}
          {#if plugin.backend.restarts}<span class="muted">· {$t('Restarts: {0}', [plugin.backend.restarts])}</span>{/if}
        </p>
        <code class="command">{commandLineText(plugin.backend.commandLine)}</code>
      {/if}
      <p class="muted" title={plugin.codeHash}>{$t('Code {0}', [plugin.codeHash.slice(0, 12)])}</p>
      {#if plugin.log.length}
        <h4>{$t('Activity')}</h4>
        <ol class="log">
          {#each [...plugin.log].reverse().slice(0, 8) as entry, index (index)}
            <li><time datetime={entry.at}>{new Date(entry.at).toLocaleString()}</time> {$t(LOG_TEXT[entry.event])}</li>
          {/each}
        </ol>
      {/if}
    </div>
  </details>

  <div class="actions">
    {#if plugin.contributes.settings.length}
      <Button size="sm" variant="ghost" disabled={!plugin.active || busy} onclick={onSettings}>
        {#snippet leading()}<SlidersHorizontal />{/snippet}
        {$t('Settings…')}
      </Button>
    {/if}
    {#if plugin.source === 'development'}
      <Button size="sm" variant="ghost" disabled={safeMode || busy} onclick={onReload}>
        {#snippet leading()}<RefreshCw />{/snippet}
        {$t('Reload')}
      </Button>
    {/if}
    {#if restartable}
      <Button size="sm" variant="ghost" disabled={safeMode || busy || !plugin.active} onclick={onRestart}>
        {#snippet leading()}<RotateCcw />{/snippet}
        {$t('Restart backend')}
      </Button>
    {/if}
    <Button size="sm" variant="ghost" disabled={safeMode || busy} onclick={onRemove}>
      {#snippet leading()}<Trash />{/snippet}
      {$t('Remove…')}
    </Button>
  </div>
</article>

<style>
  .card {
    display: grid;
    gap: var(--piui-space-3);
    padding: var(--piui-space-4);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
  }
  .icon {
    display: inline-flex;
    color: var(--piui-text-muted);
  }
  .title {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  h3 {
    margin: 0;
    overflow: hidden;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  h4 {
    margin: var(--piui-space-2) 0 0;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  .meta,
  .counts,
  .muted,
  .dev {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .badges {
    display: flex;
    gap: var(--piui-space-1);
  }
  .description {
    margin: 0;
  }
  .problems {
    display: grid;
    gap: var(--piui-space-1);
    margin: 0;
    padding: var(--piui-space-2) var(--piui-space-3) var(--piui-space-2) var(--piui-space-6);
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    font-size: var(--piui-text-sm);
  }
  .more summary {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    cursor: pointer;
  }
  .more summary:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 2px;
  }
  .more__body {
    display: grid;
    gap: var(--piui-space-2);
    padding-top: var(--piui-space-2);
  }
  .permissions,
  .log {
    display: grid;
    gap: 2px;
    margin: 0;
    padding-left: var(--piui-space-5);
    font-size: var(--piui-text-sm);
  }
  .log time {
    color: var(--piui-text-muted);
  }
  .backend {
    margin: 0;
    font-size: var(--piui-text-sm);
  }
  .command {
    display: block;
    padding: var(--piui-space-2);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-code-surface);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-sm);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-1);
  }
</style>
