<script lang="ts">
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import type { PluginReviewV1 } from '../../../../../contracts/plugins-v1';
  import { t } from '../../features/locale/language';
  import { Badge, Button, Dialog } from '../../lib/ui';
  import PluginBackendLimits from './PluginBackendLimits.svelte';
  import { commandLineText, formatBytes, PERMISSION_TEXT } from './permissions';

  /**
   * The trust review of a plugin package: who publishes it, which version,
   * every permission in plain words, the exact backend command line, what it
   * contributes and, for an update, what changed. Nothing is installed until
   * the person confirms here; the host installs exactly the reviewed code.
   */
  interface Props {
    open: boolean;
    review: PluginReviewV1;
    busy: boolean;
    error: string;
    onConfirm: () => void;
    onCancel: () => void;
  }
  let { open = $bindable(), review, busy, error, onConfirm, onCancel }: Props = $props();

  const development = $derived(review.source === 'development');
  const title = $derived(
    review.alreadyInstalled
      ? $t('{0} is already installed', [review.name])
      : development
        ? $t('Load {0} for development?', [review.name])
        : review.update
          ? $t('Update {0}?', [review.name])
          : $t('Install {0}?', [review.name]),
  );
  const added = $derived(new Set(review.update?.permissionsAdded ?? []));
  const contributions = $derived(
    [
      ...review.contributes.commands.map((title) => [$t('Command'), title] as const),
      ...review.contributes.panels.map((title) => [$t('Panel'), title] as const),
      ...review.contributes.themes.map((title) => [$t('Theme'), title] as const),
      ...review.contributes.templates.map((title) => [$t('Pipeline template'), title] as const),
      ...review.contributes.nodeTypes.map((title) => [$t('Pipeline node'), title] as const),
      ...(review.contributes.settings ? [[$t('Settings'), $t('Fields: {0}', [review.contributes.settings])] as const] : []),
    ],
  );
</script>

<Dialog
  bind:open
  {title}
  description={$t('From {0} · version {1}', [review.publisher, review.version])}
  size="lg"
  closeLabel={$t('Close')}
  onOpenChange={(next) => {
    if (!next && !busy) onCancel();
  }}
>
  <div class="review">
    {#if review.description}<p class="lead">{review.description}</p>{/if}

    <dl class="facts">
      <div><dt>{$t('ID')}</dt><dd><code>{review.id}</code></dd></div>
      <div><dt>{development ? $t('Runs from') : $t('Chosen package')}</dt><dd><code class="path">{review.location}</code></dd></div>
      {#if review.update}
        <div><dt>{$t('Installed version')}</dt><dd>{review.update.fromVersion}{#if review.update.codeChanged} <Badge tone="warning">{$t('Code changed')}</Badge>{/if}</dd></div>
      {/if}
      <div><dt>{$t('Package')}</dt><dd>{$t('Files: {0}, {1}', [review.files, formatBytes(review.bytes)])} · <span title={review.codeHash}>{$t('code {0}', [review.codeHash.slice(0, 12)])}</span></dd></div>
    </dl>

    <section aria-labelledby="plugin-permissions">
      <h3 id="plugin-permissions">{$t('Permissions')}</h3>
      {#if review.permissions.length}
        <ul class="permissions">
          {#each review.permissions as permission (permission)}
            <li>
              <span class="permission__label">
                {$t(PERMISSION_TEXT[permission].label)}
                {#if added.has(permission)}<Badge tone="warning">{$t('New')}</Badge>{/if}
              </span>
              <small>{$t(PERMISSION_TEXT[permission].detail)}</small>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{$t('This plugin asks for no permissions.')}</p>
      {/if}
      {#if review.update?.permissionsRemoved.length}
        <p class="muted">{$t('No longer asks for: {0}', [review.update.permissionsRemoved.map((permission) => $t(PERMISSION_TEXT[permission].label)).join('; ')])}</p>
      {/if}
    </section>

    {#if review.backend}
      <section aria-labelledby="plugin-backend">
        <h3 id="plugin-backend">{$t('Backend command')}</h3>
        <code class="command">{commandLineText(review.backend.commandLine)}</code>
        {#if !review.backend.nodeFound}
          <p class="warn">{$t('Node.js was not found. The backend cannot start until Node.js is installed.')}</p>
        {:else}
          <PluginBackendLimits limits={review.backend.limits} permissions={review.permissions} />
        {/if}
      </section>
    {/if}

    {#if contributions.length || review.contributes.acpAgents.length}
      <section aria-labelledby="plugin-contributions">
        <h3 id="plugin-contributions">{$t('Adds')}</h3>
        <ul class="contributions">
          {#each contributions as [kind, name], index (index)}
            <li><span class="kind">{kind}</span> {name}</li>
          {/each}
          {#each review.contributes.acpAgents as agent (agent.id)}
            <li><span class="kind">{$t('ACP agent')}</span> {agent.displayName} <code>{commandLineText(agent.commandLine)}</code></li>
          {/each}
        </ul>
        {#if review.contributes.acpAgents.length}
          <p class="muted">{$t('Each ACP agent still needs its own command-line trust in Settings → Harnesses before it runs.')}</p>
        {/if}
      </section>
    {/if}

    <p class="note" role="note">
      <ShieldAlert size={15} aria-hidden="true" />
      <span>
        {$t("Plugins are not a sandbox. PiUI limits a backend's files and programs with Node's permission model, stops its whole process tree and gives it no API keys, but deliberately malicious code can get around those limits. Panels run isolated. Install only plugins you trust.")}
        {#if development}{' '}{$t('Development mode runs the plugin from its folder: code changes load without a new review, permission changes need one.')}{/if}
      </span>
    </p>

    {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={onCancel} disabled={busy}>{review.alreadyInstalled ? $t('Close') : $t('Cancel')}</Button>
    {#if !review.alreadyInstalled}
      <Button variant="primary" loading={busy} onclick={onConfirm}>
        {development ? $t('Load for development') : review.update ? $t('Update') : $t('Install and enable')}
      </Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .review {
    display: grid;
    gap: var(--piui-space-4);
  }
  .lead {
    margin: 0;
    color: var(--piui-text-muted);
  }
  .facts {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
  }
  .facts div {
    display: grid;
    grid-template-columns: 140px minmax(0, 1fr);
    gap: var(--piui-space-3);
  }
  dt {
    color: var(--piui-text-muted);
  }
  dd {
    margin: 0;
    min-width: 0;
  }
  code {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-sm);
  }
  .path,
  .command {
    overflow-wrap: anywhere;
  }
  .command {
    display: block;
    margin-bottom: var(--piui-space-2);
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-code-surface);
  }
  h3 {
    margin: 0 0 var(--piui-space-2);
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  .permissions,
  .contributions {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .permissions li {
    display: grid;
    gap: 2px;
  }
  .permission__label {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
  }
  small,
  .muted {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .kind {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .kind::after {
    content: ':';
  }
  .note {
    display: flex;
    gap: var(--piui-space-2);
    margin: 0;
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-warning-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .note :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .warn {
    margin: var(--piui-space-2) 0 0;
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .error {
    margin: 0;
    color: var(--piui-danger-text);
  }
</style>
