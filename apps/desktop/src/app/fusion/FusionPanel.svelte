<script lang="ts" module>
  /** A destructive action the badge confirms in a dialog of its own. */
  export type FusionConfirm = { kind: 'reset' } | { kind: 'abandon'; roundId: string };
</script>

<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Square from '@lucide/svelte/icons/square';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import { tick } from 'svelte';
  import { t } from '../../features/locale/language';
  import { Badge, Button, Spinner, StatusDot } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import { FUSION_PERMISSION_CHOICES, fusionErrorText, pairKey, sidekickModelRequiresRestart } from './fusionPair';
  import type { FusionHarnessOption } from './FusionRolePicker.svelte';
  import type { FusionPairState } from './fusionPairState.svelte';
  import {
    briefOutcomeLabel,
    briefStateLabel,
    briefsNewestFirst,
    deliveryLabel,
    reportStatusLabel,
    roundDot,
    roundOutcomeLabel,
    roundStateLabel,
    sidekickStateDot,
    sidekickStateLabel,
  } from './fusionState';
  import type { FusionBriefV1, FusionPairV1, FusionRoleV1, FusionSidekickChangeKindV1 } from '../../host-api/fusionClient';

  interface Props {
    model: FusionPairState;
    safeMode: boolean;
    trusted: boolean;
    harnesses: readonly FusionHarnessOption[];
    onOpenSession: (sessionId: string) => void;
    onConfirm: (request: FusionConfirm) => void;
  }
  let { model, safeMode, trusted, harnesses, onOpenSession, onConfirm }: Props = $props();

  const INITIAL_BRIEFS = 8;
  const journal = $derived(model.state);
  let showAll = $state(false);
  let steerText = $state('');
  const steerable = $derived(journal ? journal.sidekick === 'working' || journal.sidekick === 'waitingApproval' : false);
  const sendSteer = async (): Promise<void> => {
    const text = steerText.trim();
    if (!text || locked) return;
    await model.act('steerSidekick', { type: 'steerSidekick', leadSessionId: model.leadSessionId, text });
    if (!model.error) steerText = '';
  };

  const briefs = $derived(journal ? briefsNewestFirst(journal) : []);
  const shownBriefs = $derived(showAll ? briefs : briefs.slice(0, INITIAL_BRIEFS));
  const working = $derived(journal ? ['working', 'waitingApproval', 'stopping'].includes(journal.sidekick) : false);
  const locked = $derived(safeMode || model.busy !== '');
  const uid = $props.id();
  const loadPicker = () => import('./FusionPairPicker.svelte');
  let editing = $state<FusionSidekickChangeKindV1>();
  let draft = $state<FusionPairV1>();
  let draftRevision = $state(0);
  let initialDraftKey = $state('');
  let ready = $state(false);
  let editor = $state<HTMLElement>();
  let editTrigger: HTMLElement | undefined;

  const changeReason = $derived(journal?.sidekickChangeBlock ?? (!trusted ? 'NOT_TRUSTED' : undefined));
  const replaceReason = $derived(changeReason ?? journal?.sidekickReplaceBlock);
  const reasonText = (code: string): string => fusionErrorText({ code });
  const current = $derived(journal?.sessions.find((session) => !session.retired));
  const canDetach = $derived(journal?.sidekickReplaceBlock === 'FUSION_SIDEKICK_ATTACHED');
  const losesContext = $derived(editing === 'replace' || Boolean(draft && current
    && sidekickModelRequiresRestart(draft.sidekick, journal?.sidekickCurrentModel)));
  const stale = $derived(Boolean(journal && journal.revision !== draftRevision));
  const editorReason = $derived((editing === 'replace' ? replaceReason : changeReason)
    ?? (stale ? 'CONFLICT' : undefined));

  async function edit(kind: FusionSidekickChangeKindV1, trigger: HTMLElement): Promise<void> {
    if (!journal) return;
    editTrigger = trigger;
    draft = journal.pair;
    if (kind === 'model' && !draft.sidekick.model && journal.sidekickCurrentModel) {
      draft = { ...draft, sidekick: { ...draft.sidekick, model: journal.sidekickCurrentModel } };
    }
    initialDraftKey = pairKey(draft);
    draftRevision = journal.revision;
    ready = false;
    editing = kind;
    await tick();
    editor?.focus();
  }

  async function closeEditor(): Promise<void> {
    editing = undefined;
    draft = undefined;
    await tick();
    editTrigger?.focus();
  }

  async function confirmChange(): Promise<void> {
    if (locked || !ready || !draft || !editing || editorReason) return;
    const ok = await model.act('changeSidekick', {
      type: 'changeSidekick', leadSessionId: model.leadSessionId,
      change: { revision: draftRevision, kind: editing, sidekick: draft.sidekick, allowContextLoss: losesContext },
    });
    if (ok) await closeEditor();
  }

  const permissionLabel = (role: FusionRoleV1): string =>
    $t(FUSION_PERMISSION_CHOICES.find((choice) => choice.value === role.permissionMode)?.label ?? role.permissionMode);
  const roleLine = (role: FusionRoleV1): string =>
    [role.model?.name ?? $t('Default model'), role.thinkingLevel, role.serviceTier === 'fast' ? $t('Fast mode') : '', permissionLabel(role)].filter(Boolean).join(' · ');
  const briefTone = (brief: FusionBriefV1): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' => {
    if (brief.state === 'active') return 'accent';
    if (brief.outcome === 'accepted') return 'success';
    if (brief.outcome === 'rejected') return 'danger';
    if (brief.state === 'stopped') return 'warning';
    return 'neutral';
  };
</script>

<div class="panel">
  <span class="panel__streak" aria-hidden="true"></span>
  <header class="panel__head">
    <h2>{$t('Fusion pair')}</h2>
    {#if model.loading && !journal}<Spinner size={14} />{/if}
  </header>

  {#if journal}
    <section class="roles" aria-label={$t('Pair')}>
      <div class="role">
        <span class="role__name">{$t('Lead')}</span>
        <span class="role__who">
          <HarnessMark kind={journal.pair.lead.harness} size={16} />
          <strong>{harnessMeta(journal.pair.lead.harness).label}</strong>
        </span>
        <span class="role__line">{roleLine(journal.pair.lead)}</span>
      </div>
      <div class="role">
        <span class="role__name">{$t('Sidekick')}</span>
        <span class="role__who">
          <HarnessMark kind={journal.pair.sidekick.harness} size={16} />
          <strong>{harnessMeta(journal.pair.sidekick.harness).label}</strong>
          <span class="role__state">
            <StatusDot status={sidekickStateDot(journal.sidekick)} />
            {$t(sidekickStateLabel(journal.sidekick))}
          </span>
        </span>
        <span class="role__line">{roleLine(journal.pair.sidekick)}</span>
      </div>
    </section>

    <dl class="stats" aria-label={$t('Statistics')}>
      <div><dt>{$t('Briefs')}</dt><dd>{journal.stats.briefs}</dd></div>
      <div><dt>{$t('Accepted')}</dt><dd>{journal.stats.accepted}</dd></div>
      <div><dt>{$t('Rejected')}</dt><dd>{journal.stats.rejected}</dd></div>
      <div><dt>{$t('Taken over')}</dt><dd>{journal.stats.takenOver}</dd></div>
      <div><dt>{$t('Rounds')}</dt><dd>{journal.stats.rounds}</dd></div>
    </dl>

    {#if journal.sidekick === 'waitingApproval'}
      {@const waiting = [...journal.sessions].reverse().find((session) => !session.retired)}
      <div class="uncertain" role="alert">
        <p>{$t('The sidekick is waiting for your approval in its conversation.')}</p>
        {#if waiting}
          <div class="actions">
            <Button size="sm" onclick={() => onOpenSession(waiting.sessionId)}>{$t('Open the sidekick conversation')}</Button>
          </div>
        {/if}
      </div>
    {/if}

    {#if journal.paused}
      <div class="uncertain" role="status">
        <p>{$t('The pair is stopped: no brief starts and no report reaches the lead until you resume it or write in the lead chat.')}</p>
        <div class="actions">
          <Button size="sm" disabled={locked} loading={model.busy === 'resumePair'} onclick={() => void model.act('resumePair', { type: 'resumePair', leadSessionId: model.leadSessionId })}>
            {$t('Resume pair')}
          </Button>
        </div>
      </div>
    {/if}

    {#if steerable}
      <form class="steer" onsubmit={(event) => { event.preventDefault(); void sendSteer(); }}>
        <label class="steer__label" for="fusion-steer">{$t('Correct the running round')}</label>
        <textarea id="fusion-steer" class="steer__input" rows="2" maxlength="8000" bind:value={steerText} disabled={locked}></textarea>
        <Button size="sm" type="submit" disabled={locked || !steerText.trim()} loading={model.busy === 'steerSidekick'}>{$t('Send to sidekick')}</Button>
      </form>
    {/if}

    <div class="actions" role="group" aria-label={$t('Pair actions')}>
      <Button size="sm" disabled={locked || (!working && !canDetach)} loading={model.busy === 'stopSidekick'} onclick={() => void model.act('stopSidekick', { type: 'stopSidekick', leadSessionId: model.leadSessionId })}>
        {#snippet leading()}<Square />{/snippet}
        {$t(working ? 'Stop sidekick' : 'Detach sidekick')}
      </Button>
      <Button size="sm" disabled={locked} loading={model.busy === 'stopPair'} onclick={() => void model.act('stopPair', { type: 'stopPair', leadSessionId: model.leadSessionId })}>
        {#snippet leading()}<OctagonX />{/snippet}
        {$t('Stop pair')}
      </Button>
      <Button size="sm" variant="danger" disabled={locked || journal.sidekick === 'none'} loading={model.busy === 'resetSidekick'} onclick={() => onConfirm({ kind: 'reset' })}>
        {#snippet leading()}<RotateCcw />{/snippet}
        {$t('Reset sidekick…')}
      </Button>
      <Button
        size="sm"
        disabled={locked || Boolean(changeReason) || editing !== undefined}
        aria-describedby={changeReason ? `${uid}-change-reason` : undefined}
        onclick={(event) => void edit('model', event.currentTarget)}
      >{$t('Change sidekick model')}</Button>
      <Button
        size="sm"
        disabled={locked || Boolean(replaceReason) || editing !== undefined}
        aria-describedby={replaceReason ? (changeReason ? `${uid}-change-reason` : `${uid}-replace-reason`) : undefined}
        onclick={(event) => void edit('replace', event.currentTarget)}
      >{$t('Replace sidekick')}</Button>
    </div>
    {#if changeReason}<p class="hint" id="{uid}-change-reason">{ $t(reasonText(changeReason)) }</p>
    {:else if replaceReason}<p class="hint" id="{uid}-replace-reason">{ $t(reasonText(replaceReason)) }</p>{/if}

    {#if editing && draft}
      <section class="sidekick-editor" bind:this={editor} tabindex="-1" aria-labelledby="{uid}-editor-title">
        <h3 id="{uid}-editor-title">{$t(editing === 'model' ? 'Change sidekick model' : 'Replace sidekick')}</h3>
        {#await loadPicker()}
          <Spinner size={14} />
        {:then { default: FusionPairPicker }}
          <FusionPairPicker workspaceId={journal.workspaceId} {trusted} {harnesses} disabled={locked} {editing} bind:pair={draft} bind:ready />
        {/await}
        {#if losesContext}
          <p class="hint">{$t('This starts a fresh sidekick conversation with no earlier context. The old conversation stays readable.')}</p>
        {/if}
        {#if editorReason && editorReason !== changeReason && editorReason !== replaceReason}
          <p class="hint" role="status">{$t(reasonText(editorReason))}</p>
        {/if}
        <div class="actions">
          <Button size="sm" variant="ghost" disabled={model.busy === 'changeSidekick'} onclick={() => void closeEditor()}>{$t('Cancel')}</Button>
          <Button
            size="sm"
            disabled={locked || !ready || Boolean(editorReason) || (editing === 'model' && pairKey(draft) === initialDraftKey)}
            loading={model.busy === 'changeSidekick'}
            onclick={() => void confirmChange()}
          >{$t(losesContext ? 'Start fresh sidekick' : 'Apply model settings')}</Button>
        </div>
      </section>
    {/if}
    <p class="hint">{$t('Stop the running round or detach the idle sidekick. Stop pair also stops the lead. Reset retires the sidekick conversation.')}</p>
    {#if safeMode}<p class="hint">{$t('Fusion actions are disabled in safe mode.')}</p>{/if}
  {:else if model.error}
    <p class="problem" role="alert">{$t(model.error)}</p>
    <Button size="sm" onclick={() => void model.refresh()}>{$t('Try again')}</Button>
  {:else}
    <p class="hint">{$t('Loading the pair…')}</p>
  {/if}

  {#if journal && model.error}<p class="problem" role="alert">{$t(model.error)}</p>{/if}

  {#if journal}
    <section class="briefs" aria-label={$t('Briefs')}>
      <h3>{$t('Briefs')}</h3>
      {#if briefs.length === 0}
        <p class="hint">{$t('No briefs yet. The lead sends one when it delegates work.')}</p>
      {:else}
        <ul class="list">
          {#each shownBriefs as brief (brief.briefId)}
            <li class="brief">
              <div class="brief__head">
                <span class="brief__id" title={brief.briefId}>{brief.briefId.slice(0, 8)}</span>
                <strong class="brief__title" title={brief.title}>{brief.title}</strong>
                <Badge tone={briefTone(brief)}>{$t(briefStateLabel(brief.state))}</Badge>
                {#if brief.outcome}<Badge tone={briefTone(brief)}>{$t(briefOutcomeLabel(brief.outcome))}</Badge>{/if}
              </div>
              <ul class="rounds">
                {#each brief.rounds as round (round.roundId)}
                  <li class="round">
                    <div class="round__head">
                      <StatusDot status={roundDot(round)} />
                      <span class="round__id" title={round.roundId}>{round.roundId.slice(0, 8)}</span>
                      <span>{round.kind === 'brief' ? $t('Brief') : $t('Follow-up')}</span>
                      <span class="round__sep" aria-hidden="true">·</span>
                      <span>{$t(roundStateLabel(round.state))}</span>
                      {#if round.outcome && round.state === 'finished'}<span class="round__sep" aria-hidden="true">·</span><span>{$t(roundOutcomeLabel(round.outcome))}</span>{/if}
                      {#if round.status}<span class="round__sep" aria-hidden="true">·</span><span>{$t(reportStatusLabel(round.status))}</span>{/if}
                      {#if round.takeOver}<Badge tone="warning">{$t('Taken over')}</Badge>{/if}
                    </div>
                    {#if round.delivery}<p class="round__delivery">{$t(deliveryLabel(round.delivery.state))}</p>{/if}
                    {#if round.preview}<p class="round__preview" title={round.preview}>{round.preview}</p>{/if}
                    {#if round.state === 'finished' && round.delivery?.state === 'uncertain'}
                      <div class="uncertain">
                        <p>{$t('The report may or may not have reached the lead. Check the lead chat for it, deliver it again, or dismiss it.')}</p>
                        <div class="actions">
                          <Button
                            size="sm"
                            disabled={locked}
                            loading={model.busy === `check:${round.roundId}`}
                            onclick={() => void model.act(`check:${round.roundId}`, { type: 'checkDelivery', leadSessionId: model.leadSessionId, roundId: round.roundId })}
                          >
                            {$t('Check lead chat')}
                          </Button>
                          <Button
                            size="sm"
                            disabled={locked}
                            loading={model.busy === `deliver:${round.roundId}`}
                            onclick={() => void model.act(`deliver:${round.roundId}`, { type: 'deliverAgain', leadSessionId: model.leadSessionId, roundId: round.roundId })}
                          >
                            {$t('Deliver again')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={locked}
                            loading={model.busy === `dismiss:${round.roundId}`}
                            onclick={() => void model.act(`dismiss:${round.roundId}`, { type: 'dismissReport', leadSessionId: model.leadSessionId, roundId: round.roundId })}
                          >
                            {$t('Dismiss')}
                          </Button>
                        </div>
                      </div>
                    {/if}
                    {#if round.state === 'uncertain'}
                      <div class="uncertain">
                        <p>{$t('Nano Desktop could not tell how this round ended. Check the sidekick conversation, then reconcile it or abandon it.')}</p>
                        <div class="actions">
                          <Button
                            size="sm"
                            disabled={locked}
                            loading={model.busy === `reconcile:${round.roundId}`}
                            onclick={() => void model.act(`reconcile:${round.roundId}`, { type: 'reconcileRound', leadSessionId: model.leadSessionId, roundId: round.roundId })}
                          >
                            {$t('Reconcile')}
                          </Button>
                          <Button size="sm" variant="danger" disabled={locked} onclick={() => onConfirm({ kind: 'abandon', roundId: round.roundId })}>
                            {$t('Abandon…')}
                          </Button>
                        </div>
                      </div>
                    {/if}
                  </li>
                {/each}
              </ul>
            </li>
          {/each}
        </ul>
        {#if briefs.length > INITIAL_BRIEFS}
          <Button size="sm" variant="ghost" onclick={() => (showAll = !showAll)} aria-expanded={showAll}>
            {showAll ? $t('Show fewer briefs') : $t('Show all {0} briefs', [briefs.length])}
          </Button>
        {/if}
      {/if}
    </section>

    {#if journal.sessions.length}
      <section class="sessions" aria-label={$t('Sidekick sessions')}>
        <h3>{$t('Sidekick sessions')}</h3>
        <ul class="list">
          {#each [...journal.sessions].reverse() as session (session.sessionId)}
            <li class="session">
              <HarnessMark kind={session.harness} size={16} />
              <span class="session__name">{harnessMeta(session.harness).label}</span>
              <Badge tone={session.retired ? 'neutral' : 'accent'}>{session.retired ? $t('Retired') : $t('Current')}</Badge>
              {#if session.retired && session.retiredReason}<span class="session__reason" title={session.retiredReason}>{session.retiredReason}</span>{/if}
              <span class="session__gap"></span>
              <Button size="sm" variant="ghost" onclick={() => onOpenSession(session.sessionId)} aria-label={$t('Open the sidekick conversation ({0})', [harnessMeta(session.harness).label])}>
                {#snippet leading()}<ExternalLink />{/snippet}
                {$t('Open')}
              </Button>
            </li>
          {/each}
        </ul>
        <p class="hint">{$t('The sidekick conversation is read-only: the lead gives it work through briefs.')}</p>
      </section>
    {/if}
  {/if}
</div>

<style>
  .steer {
    display: grid;
    gap: var(--piui-space-2);
  }
  .steer__label {
    font-size: var(--piui-text-sm);
    color: var(--piui-text-muted);
  }
  .steer__input {
    resize: vertical;
    font: inherit;
    padding: var(--piui-space-2);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface);
    color: inherit;
  }

  .panel {
    position: relative;
    display: grid;
    gap: var(--piui-space-3);
    padding: var(--piui-space-4) var(--piui-space-3) var(--piui-space-3);
    background: radial-gradient(120% 40% at 100% 0%, color-mix(in srgb, var(--piui-decoration-primary) 8%, transparent), transparent 60%);
  }
  .panel__streak {
    position: absolute;
    top: 0;
    left: 0;
    width: 62%;
    height: 2px;
    background: linear-gradient(90deg, var(--piui-decoration-primary), var(--piui-decoration-secondary) 55%, transparent);
    clip-path: var(--piui-decoration-line-shape);
    pointer-events: none;
  }
  .panel__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
  }
  h2,
  h3 {
    margin: 0;
  }
  h2 {
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
  }
  h3 {
    color: var(--piui-decoration-primary);
    font-size: 10px;
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .roles {
    display: grid;
    gap: var(--piui-space-2);
  }
  .role {
    display: grid;
    gap: 2px;
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-left: 3px solid var(--piui-decoration-primary);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-2);
  }
  .role:nth-child(2) {
    border-left-color: var(--piui-decoration-secondary);
  }
  .role__name {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .role__who {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .role__state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .role__line {
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: var(--piui-space-2);
    margin: 0;
  }
  .stats div {
    display: grid;
    gap: 2px;
    padding: 4px 6px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-xs);
    text-align: center;
  }
  .stats dt {
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stats dd {
    margin: 0;
    font-family: var(--piui-font-mono);
    font-weight: var(--piui-weight-semibold);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
  }
  .sidekick-editor {
    display: grid;
    gap: var(--piui-space-2);
  }
  .sidekick-editor h3 {
    margin: 0;
    font-size: var(--piui-text-sm);
  }
  .hint {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .problem {
    margin: 0;
    padding: 6px 10px;
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    font-size: var(--piui-text-sm);
  }
  .briefs,
  .sessions {
    display: grid;
    gap: var(--piui-space-2);
    padding-top: var(--piui-space-2);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .list,
  .rounds {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .brief {
    display: grid;
    gap: 4px;
    padding: var(--piui-space-2);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
  }
  .brief__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .brief__id,
  .round__id {
    flex: none;
    color: var(--piui-text-disabled);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .brief__title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rounds {
    gap: 4px;
    padding-left: var(--piui-space-3);
    border-left: 1px solid var(--piui-border-subtle);
  }
  .round {
    display: grid;
    gap: 2px;
    font-size: var(--piui-text-sm);
  }
  .round__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    color: var(--piui-text-muted);
  }
  .round__sep {
    color: var(--piui-text-disabled);
  }
  .round__delivery {
    margin: 0;
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
  .round__preview {
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    word-break: break-word;
  }
  .uncertain {
    display: grid;
    gap: var(--piui-space-2);
    margin-top: 4px;
    padding: var(--piui-space-2);
    border: 1px solid var(--piui-warning-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-warning-surface);
  }
  .uncertain p {
    margin: 0;
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .session {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .session__name {
    flex: none;
  }
  .session__reason {
    min-width: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session__gap {
    flex: 1;
  }
</style>
