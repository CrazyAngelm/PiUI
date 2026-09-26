<script lang="ts">
  import Terminal from '@lucide/svelte/icons/terminal';
  import FilePen from '@lucide/svelte/icons/file-pen';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import MessageCircleQuestion from '@lucide/svelte/icons/message-circle-question';
  import Plug from '@lucide/svelte/icons/plug';
  import { tick, untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import type { ApprovalDecision, WorkspaceApproval, WorkspaceSession } from '../../../../../contracts/workspace-v15';
  import {
    encodeFormAnswer,
    formIssues,
    initialDraft,
    type ApprovalFieldIssue,
    type ApprovalFormDraft,
  } from '../../host-api/approvalForms';
  import { Button, Textarea, toasts } from '../../lib/ui';
  import ApprovalForm from './ApprovalForm.svelte';
  import HarnessMark from './HarnessMark.svelte';
  import { useWorkspace } from './context';

  interface Props {
    approval: WorkspaceApproval;
    session: WorkspaceSession;
    /** Show which chat the request came from (Inbox); hidden inside the chat itself. */
    showOrigin?: boolean;
    originLabel?: string;
    onOpen?: () => void;
  }
  let { approval, session, showOrigin = false, originLabel = '', onOpen }: Props = $props();
  const store = useWorkspace();
  const key = $derived(store.approvalKey(session.id, approval.id));
  const busy = $derived(store.approvalBusy === key);
  const error = $derived(store.approvalErrors[key] ?? '');
  // Native choice list (e.g. Pi `select` dialogs); absent for other requests.
  const options = $derived(approval.options ?? []);
  // Native form request (a Codex MCP elicitation); absent for other requests.
  const form = $derived(approval.form);
  let input = $state('');
  // Keyed per approval by the parent list: the form seeds its draft once.
  let draft = $state<ApprovalFormDraft>(untrack(() => (approval.form ? initialDraft(approval.form) : {})));
  let issues = $state.raw<Record<string, ApprovalFieldIssue>>({});
  const idPrefix = $derived(`approval-${session.id}-${approval.id}`.replace(/[^A-Za-z0-9_-]/g, '-'));

  const icons = { command: Terminal, 'file-change': FilePen, permission: KeyRound, input: MessageCircleQuestion };
  const Icon = $derived(form ? Plug : (icons[approval.kind] ?? KeyRound));
  const kindLabel = $derived(
    form
      ? $t('MCP server {0}', [form.server])
      : approval.kind === 'command'
        ? $t('Run a command')
        : approval.kind === 'file-change'
          ? $t('Change files')
          : approval.kind === 'input'
            ? $t('Answer a question')
            : $t('Permission request'),
  );

  function label(decision: ApprovalDecision): string {
    // MCP requests answer with the protocol's accept, decline or dismiss.
    switch (decision) {
      case 'approve-once':
        return form ? $t('Accept') : approval.kind === 'input' ? $t('Send answer') : $t('Allow once');
      case 'approve-session':
        return $t('Allow for this chat');
      case 'deny':
        return form ? $t('Decline') : $t('Deny');
      case 'cancel':
        return $t('Dismiss');
    }
  }

  function edit(fieldId: string, value: string | boolean): void {
    draft = { ...draft, [fieldId]: value };
    if (issues[fieldId]) {
      const { [fieldId]: _fixed, ...rest } = issues;
      issues = rest;
    }
  }

  async function decide(decision: ApprovalDecision, text: string | undefined = undefined): Promise<void> {
    let answer = text ?? (approval.kind === 'input' && !form ? input : undefined);
    if (form && decision === 'approve-once') {
      issues = formIssues(form, draft);
      const invalid = form.fields.find((field) => issues[field.id]);
      if (invalid) {
        // Move keyboard focus to the first value that cannot be sent.
        await tick();
        document.getElementById(`${idPrefix}-${invalid.id}`)?.focus();
        return;
      }
      answer = encodeFormAnswer(form, draft);
    }
    const ok = await store.respond(session.id, approval, decision, answer);
    if (!ok) toasts.error($t('Could not send the decision'), store.approvalErrors[key]);
  }
</script>

<article class="approval" aria-label={kindLabel}>
  <header>
    <span class="approval__icon"><Icon size={15} /></span>
    <span class="approval__kind">{kindLabel}</span>
    {#if showOrigin}
      <button type="button" class="approval__origin" onclick={onOpen} title={$t('Open chat')}>
        <HarnessMark kind={session.harness} size={16} />
        <span>{originLabel}</span>
      </button>
    {/if}
  </header>
  <h3>{approval.title}</h3>
  {#if approval.description}<p class="approval__desc">{approval.description}</p>{/if}

  {#if form}
    {#if form.limitation === 'input-unsupported'}
      <p class="approval__note">{$t('This request needs a value PiUI cannot show, so it can only be declined.')}</p>
    {:else if form.limitation === 'optional-fields-omitted'}
      <p class="approval__note">{$t('Some optional values cannot be entered here and are left empty.')}</p>
    {/if}
    {#if form.fields.length}
      <ApprovalForm {form} {draft} {issues} {idPrefix} disabled={busy} onchange={edit} />
    {/if}
  {:else if options.length}
    <div class="options" role="group" aria-label={$t('Choices')}>
      {#each options as option (option.id)}
        <Button size="sm" disabled={busy || store.approvalBusy !== ''} onclick={() => void decide('approve-once', option.id)}>{option.label}</Button>
      {/each}
    </div>
  {:else if approval.inputLabel}
    <Textarea bind:value={input} minRows={2} maxRows={8} aria-label={approval.inputLabel} placeholder={approval.inputLabel} disabled={busy} />
  {/if}

  {#if error}<p class="approval__error" role="alert">{error}</p>{/if}

  <footer>
    {#each approval.decisions as decision (decision)}
      {#if !(options.length && !form && decision === 'approve-once')}
        <Button
          size="sm"
          variant={decision === 'approve-once' ? 'primary' : decision === 'deny' ? 'danger' : 'ghost'}
          loading={busy && decision === 'approve-once'}
          disabled={store.approvalBusy !== '' || (decision === 'approve-once' && approval.kind === 'input' && !form && !options.length && !input.trim())}
          onclick={() => void decide(decision)}
        >
          {label(decision)}
        </Button>
      {/if}
    {/each}
  </footer>
</article>

<style>
  .approval {
    display: grid;
    gap: var(--piui-space-2);
    padding: var(--piui-space-3) var(--piui-space-4);
    border: 1px solid var(--piui-warning-border);
    border-radius: var(--piui-radius-md);
    background: color-mix(in srgb, var(--piui-warning-surface) 60%, var(--piui-surface-1));
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .approval__icon {
    display: inline-flex;
    color: var(--piui-warning);
  }
  .approval__kind {
    color: var(--piui-warning-text);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .approval__origin {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-left: auto;
    padding: 2px 6px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .approval__origin:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .approval__origin span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  h3 {
    margin: 0;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    word-break: break-word;
  }
  .approval__desc {
    margin: 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .approval__note {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .approval__error {
    margin: 0;
    color: var(--piui-danger);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
</style>
