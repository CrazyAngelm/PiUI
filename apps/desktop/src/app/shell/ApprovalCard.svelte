<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '../../features/locale/language';
  import type { WorkspaceApproval, WorkspaceSession } from '../../../../../contracts/workspace-v15';
  import { toasts } from '../../lib/ui';
  import { fusionMembership } from '../fusion/fusionMembership.svelte';
  import HarnessMark from './HarnessMark.svelte';
  import { useWorkspace } from './context';
  import ApprovalRequest from '../../shared/conversation/ApprovalRequest.svelte';

  interface Props {
    approval: WorkspaceApproval;
    session: WorkspaceSession;
    showOrigin?: boolean;
    originLabel?: string;
    onOpen?: () => void;
  }
  let { approval, session, showOrigin = false, originLabel = '', onOpen }: Props = $props();
  const store = useWorkspace();
  let disposed = false;
  onDestroy(() => { disposed = true; });
  const key = $derived(store.approvalKey(session.id, approval.id));
  const busy = $derived(store.approvalBusy === key);
  const error = $derived(store.approvalErrors[key] ?? '');
  $effect(() => { void fusionMembership.load(session.id); });
  const standingApprovalRefused = $derived(Boolean(session.runId) || fusionMembership.isSidekick(session.id));
  const decisions = $derived(standingApprovalRefused ? approval.decisions.filter(decision => decision !== 'approve-session') : approval.decisions);
  const idPrefix = $derived(('approval-' + session.id + '-' + approval.id).replace(/[^A-Za-z0-9_-]/g, '-'));
</script>

<ApprovalRequest {approval} {idPrefix} {busy} {error} {decisions} disabled={store.approvalBusy !== ''} onRespond={async (decision, answer) => {
  const sessionId = session.id;
  const request = approval;
  const ok = await store.respond(sessionId, request, decision, answer);
  if (!disposed && !ok && session.id === sessionId && approval.id === request.id) toasts.error($t('Could not send the decision'), store.approvalErrors[store.approvalKey(sessionId, request.id)]);
}}>
  {#snippet origin()}
    {#if showOrigin}
      <button type="button" class="approval__origin" onclick={onOpen} title={$t('Open chat')}>
        <HarnessMark kind={session.harness} size={16} /><span>{originLabel}</span>
      </button>
    {/if}
  {/snippet}
</ApprovalRequest>

<style>
  .approval__origin { display: inline-flex; align-items: center; gap: 6px; min-width: 0; margin-left: auto; padding: 2px 6px; border: 0; border-radius: var(--piui-radius-sm); background: transparent; color: var(--piui-text-muted); font-size: var(--piui-text-sm); }
  .approval__origin:hover { background: var(--piui-hover); color: var(--piui-text); }
  .approval__origin span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
