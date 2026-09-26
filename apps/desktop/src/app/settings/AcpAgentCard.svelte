<script lang="ts">
  import type { AcpAgentEntryV1 } from '../../../../../contracts/harness-registry-v1';
  import { acpHarnessId } from '../../../../../contracts/harness-identity-v2';
  import { t } from '../../features/locale/language';
  import { Badge, Button } from '../../lib/ui';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import {
    canChooseSecrets, canConfirmVersion, canRemove, canTrust, commandLineText, environmentGroups, stateBadge, versionNote,
  } from './acpAgents';
  import type { AcpAgentRow, HarnessesStore } from './harnessesStore.svelte';

  interface Props {
    row: AcpAgentRow;
    store: HarnessesStore;
    onTrust: (agent: AcpAgentEntryV1) => void;
    onConfirmVersion: (agent: AcpAgentEntryV1) => void;
    onSecrets: (agent: AcpAgentEntryV1) => void;
    onRemove: (agent: AcpAgentEntryV1) => void;
  }
  let { row, store, onTrust, onConfirmVersion, onSecrets, onRemove }: Props = $props();
  // Buttons keep their visible text as the accessible name; the agent name describes them.
  const uid = $props.id();
  const titleId = `${uid}-title`;

  const RESTRICTIONS = [
    ['loadSession', 'Reopening chats'],
    ['models', 'Model choice'],
    ['modes', 'Session modes'],
    ['mcpHttp', 'PiUI coordination tool'],
  ] as const;

  const agent = $derived(row.agent);
  const harness = $derived(acpHarnessId(agent.descriptor.id));
  const name = $derived(agent.descriptor.displayName);
  const badge = $derived(stateBadge(agent.state, store.safeMode));
  const version = $derived(versionNote(agent));
  const environment = $derived(environmentGroups(agent));
  const restricted = $derived(RESTRICTIONS.filter(([key]) => agent.descriptor.capabilities?.[key] === false).map(([, label]) => label));
  const hint = $derived(row.status?.signInHint ?? agent.descriptor.authHint);
  const locked = $derived(store.safeMode || store.busy !== '');
  const error = $derived(store.agentErrors[agent.descriptor.id]);
</script>

<li class="card">
  <HarnessMark kind={harness} size={28} />
  <div class="card__main">
    <div class="card__title">
      <strong id={titleId}>{name}</strong>
      <Badge>{agent.source === 'built-in' ? $t('Ships with PiUI') : agent.source === 'plugin' ? $t('From plugin {0}', [agent.plugin?.name ?? '']) : $t('Added by you')}</Badge>
      {#if agent.version}<span class="muted">v{agent.version}</span>{/if}
      <Badge tone={badge.tone}>{$t(badge.label)}</Badge>
    </div>
    {#if agent.reason && !(store.safeMode && agent.state === 'checking')}<p class="muted">{$t(agent.reason)}</p>{/if}
    <dl class="facts">
      <div><dt>{$t('Identity')}</dt><dd><code>{harness}</code></dd></div>
      {#if agent.commandLine}
        <div><dt>{$t('Command')}</dt><dd><code>{commandLineText(agent.commandLine)}</code></dd></div>
      {:else}
        <div><dt>{$t('Program')}</dt><dd><code>{agent.descriptor.command.program}</code></dd></div>
      {/if}
      {#if version}<div><dt>{$t('Version')}</dt><dd>{$t(version[0], version[1])}</dd></div>{/if}
      {#if row.status?.verifiedVersions}<div><dt>{$t('Tested with PiUI')}</dt><dd>{row.status.verifiedVersions}</dd></div>{/if}
      {#if hint}
        <div>
          <dt>{$t('Sign-in')}</dt>
          <dd>
            {$t(hint)}
            {#if agent.authMethods.length > 0}<span class="muted">{$t('The agent offers: {0}.', [agent.authMethods.join(', ')])}</span>{/if}
          </dd>
        </div>
      {/if}
      {#if environment.plain.length + environment.allowed.length + environment.withheld.length > 0}
        <div>
          <dt>{$t('Environment')}</dt>
          <dd class="stack">
            {#if environment.plain.length > 0}<span>{$t('Passed from your environment: {0}', [environment.plain.join(', ')])}</span>{/if}
            {#if environment.allowed.length > 0}<span>{$t('Secrets you allowed: {0}', [environment.allowed.join(', ')])}</span>{/if}
            {#if environment.withheld.length > 0}<span class="muted">{$t('Secrets not passed: {0}', [environment.withheld.join(', ')])}</span>{/if}
          </dd>
        </div>
      {/if}
      {#if restricted.length > 0}
        <div><dt>{$t('Switched off')}</dt><dd>{restricted.map((label) => $t(label)).join(', ')}</dd></div>
      {/if}
      {#if agent.descriptor.docsUrl}<div><dt>{$t('Documentation')}</dt><dd><code>{agent.descriptor.docsUrl}</code></dd></div>{/if}
    </dl>
    {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
    <div class="actions">
      {#if canTrust(agent)}
        <Button size="sm" disabled={locked} onclick={() => onTrust(agent)} aria-describedby={titleId}>{$t('Review and trust…')}</Button>
      {/if}
      {#if canConfirmVersion(agent)}
        <Button size="sm" disabled={locked} onclick={() => onConfirmVersion(agent)} aria-describedby={titleId}>{$t('Confirm version…')}</Button>
      {/if}
      {#if canChooseSecrets(agent)}
        <Button size="sm" disabled={locked} onclick={() => onSecrets(agent)} aria-describedby={titleId}>{$t('Secret variables…')}</Button>
      {/if}
      <Button
        size="sm"
        variant="ghost"
        disabled={locked}
        loading={store.busy === `check:${harness}`}
        onclick={() => void store.check(harness)}
        aria-describedby={titleId}
      >{$t('Check again')}</Button>
      {#if canRemove(agent)}
        <Button size="sm" variant="ghost" disabled={locked} onclick={() => onRemove(agent)} aria-describedby={titleId}>{$t('Remove…')}</Button>
      {/if}
    </div>
  </div>
</li>

<style>
  .card {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-3);
    padding: var(--piui-space-3) var(--piui-space-4);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .card__main {
    display: grid;
    flex: 1;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .card__title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 28px;
  }
  p {
    margin: 0;
  }
  .facts {
    display: grid;
    gap: 4px;
    margin: 0;
    font-size: var(--piui-text-sm);
  }
  .facts div {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    gap: var(--piui-space-3);
  }
  .facts dt {
    color: var(--piui-text-muted);
  }
  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .stack {
    display: grid;
    gap: 2px;
  }
  code {
    font-family: var(--piui-font-mono);
    font-size: 0.95em;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .error {
    color: var(--piui-danger-text);
  }
</style>
