<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import type { AcpAgentEntryV1 } from '../../../../../contracts/harness-registry-v1';
  import { acpHarnessId } from '../../../../../contracts/harness-identity-v3';
  import { t } from '../../features/locale/language';
  import { Button, StatusDot } from '../../lib/ui';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import {
    canChooseSecrets, canRemove, canTrust, commandLineText, environmentGroups, versionBadge, versionNote,
  } from './acpAgents';
  import { canConnectAgent, connectIsPrimary, rowStatus } from './harnessConnect.svelte';
  import type { AcpAgentRow, HarnessesStore } from './harnessesStore.svelte';

  /**
   * One ACP agent as a row (ADR-034): the status and the next decision stay
   * visible; identity, command, environment and the rest sit under Details.
   * Signing in is the Connect dialog (ADR-054).
   */
  interface Props {
    row: AcpAgentRow;
    store: HarnessesStore;
    onConnect: (agent: AcpAgentEntryV1) => void;
    onTrust: (agent: AcpAgentEntryV1) => void;
    onRemove: (agent: AcpAgentEntryV1) => void;
    /** Review the secret variables the agent may receive; offered even when it is not installed. */
    onSecrets: (agent: AcpAgentEntryV1) => void;
  }
  let { row, store, onConnect, onTrust, onRemove, onSecrets }: Props = $props();
  // Buttons keep their visible text as the accessible name; the agent name describes them.
  const uid = $props.id();
  const titleId = `${uid}-title`;

  const RESTRICTIONS = [
    ['loadSession', 'Reopening chats'],
    ['models', 'Model choice'],
    ['modes', 'Session modes'],
    ['mcpHttp', 'Nano Desktop coordination tool'],
  ] as const;

  const agent = $derived(row.agent);
  const harness = $derived(acpHarnessId(agent.descriptor.id));
  const name = $derived(agent.descriptor.displayName);
  const status = $derived(rowStatus(agent.state, store.safeMode));
  const version = $derived(versionNote(agent));
  const advisory = $derived(versionBadge(agent.versionStatus));
  const environment = $derived(environmentGroups(agent));
  const restricted = $derived(RESTRICTIONS.filter(([key]) => agent.descriptor.capabilities?.[key] === false).map(([, label]) => label));
  const locked = $derived(store.safeMode || store.busy !== '');
  const error = $derived(store.agentErrors[agent.descriptor.id]);
  const source = $derived(agent.source === 'built-in' ? 'Ships with Nano Desktop' : agent.source === 'plugin' ? undefined : 'Added by you');
</script>

<li class="row">
  <div class="row__line">
    <HarnessMark kind={harness} size={24} />
    <div class="row__name">
      <strong id={titleId}>{name}</strong>
      {#if agent.version}<span class="muted">v{agent.version}</span>{/if}
      {#if advisory}<span class="muted">{$t(advisory.label)}</span>{/if}
    </div>
    <span class="state" class:state--attention={!status.ready && status.dot === 'waiting'} class:state--danger={status.dot === 'failed'}>
      {#if status.ready}
        <StatusDot status={status.dot} label={$t(status.label)} />
      {:else}
        <StatusDot status={status.dot} />
        <span>{$t(status.label)}</span>
      {/if}
    </span>
    {#if canTrust(agent)}
      <Button size="sm" variant="primary" disabled={locked} onclick={() => onTrust(agent)} aria-describedby={titleId}>{$t('Review and trust…')}</Button>
    {/if}
    {#if canConnectAgent(agent)}
      <Button
        size="sm"
        variant={connectIsPrimary(agent.state) ? 'primary' : 'secondary'}
        disabled={locked}
        onclick={() => onConnect(agent)}
        aria-describedby={titleId}
      >{$t('Connect')}</Button>
    {/if}
  </div>
  {#if agent.reason && !(store.safeMode && agent.state === 'checking')}<p class="row__reason muted">{$t(agent.reason)}</p>{/if}
  {#if error}<p class="row__reason problem" role="alert">{$t(error)}</p>{/if}
  <details class="row__details">
    <summary><ChevronRight size={12} />{$t('Details')}</summary>
    {#if source}<p class="muted source">{$t(source)}</p>{:else if agent.plugin}<p class="muted source">{$t('From plugin {0}', [agent.plugin.name])}</p>{/if}
    <dl class="facts">
      <div><dt>{$t('Identity')}</dt><dd><code>{harness}</code></dd></div>
      {#if agent.commandLine}
        <div><dt>{$t('Command')}</dt><dd><code>{commandLineText(agent.commandLine)}</code></dd></div>
      {:else}
        <div><dt>{$t('Program')}</dt><dd><code>{agent.descriptor.command.program}</code></dd></div>
      {/if}
      {#if version}<div><dt>{$t('Version')}</dt><dd>{$t(version[0], version[1])}</dd></div>{/if}
      {#if row.status?.verifiedVersions}<div><dt>{$t('Tested with Nano Desktop')}</dt><dd>{row.status.verifiedVersions}</dd></div>{/if}
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
    <div class="actions">
      <Button
        size="sm"
        variant="ghost"
        disabled={locked}
        loading={store.busy === `check:${harness}`}
        onclick={() => void store.check(harness)}
        aria-describedby={titleId}
      >{$t('Check again')}</Button>
      {#if canChooseSecrets(agent)}
        <Button size="sm" variant="ghost" disabled={locked} onclick={() => onSecrets(agent)} aria-describedby={titleId}>{$t('Secret variables…')}</Button>
      {/if}
      {#if canRemove(agent)}
        <Button size="sm" variant="ghost" disabled={locked} onclick={() => onRemove(agent)} aria-describedby={titleId}>{$t('Remove…')}</Button>
      {/if}
    </div>
  </details>
</li>

<style>
  .row {
    display: grid;
    gap: var(--piui-space-1);
    padding: var(--piui-space-3) var(--piui-space-4);
  }
  .row__line {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    min-height: 32px;
  }
  .row__name {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--piui-space-1) var(--piui-space-2);
    min-width: 0;
  }
  .row__name strong {
    font-weight: var(--piui-weight-medium);
  }
  .row__name .muted {
    font-size: var(--piui-text-sm);
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .state--attention {
    color: var(--piui-warning-text);
  }
  .state--danger {
    color: var(--piui-danger-text);
  }
  .row__reason,
  .row__details {
    margin: 0 0 0 calc(24px + var(--piui-space-3));
    font-size: var(--piui-text-sm);
  }
  p {
    margin: 0;
  }
  .source {
    margin-top: var(--piui-space-2);
  }
  summary {
    display: inline-flex;
    align-items: center;
    gap: var(--piui-space-1);
    border-radius: var(--piui-radius-sm);
    color: var(--piui-text-muted);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    color: var(--piui-text);
  }
  summary:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 2px;
  }
  summary :global(svg) {
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  details[open] > summary :global(svg) {
    transform: rotate(90deg);
  }
  .facts {
    display: grid;
    gap: 4px;
    margin: var(--piui-space-2) 0;
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
    margin-left: calc(var(--piui-space-2) * -1);
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .problem {
    color: var(--piui-danger-text);
  }
</style>
