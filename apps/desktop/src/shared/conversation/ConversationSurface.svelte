<script lang="ts">
  import { useTranslation } from '../../features/locale/context';
  import { providePortalTarget } from '../../lib/ui/portalContext';
  import { Button } from '../../lib/ui';
  import { Tooltip } from 'bits-ui';
  import { conversationKey, type ConversationController } from './conversationController.svelte';
  import { setConversationPresentation } from './context';
  import ConversationTranscript from './ConversationTranscript.svelte';
  import ApprovalRequest from './ApprovalRequest.svelte';

  let { controller, language, agentLabel, portalTarget, printMode = false, announceMessages = false }: { controller: ConversationController; language: 'en' | 'ru'; agentLabel: string; portalTarget: HTMLElement; printMode?: boolean; announceMessages?: boolean } = $props();
  const t = useTranslation();
  const mountId = $props.id();
  providePortalTarget(() => portalTarget);
  let notice = $state('');
  let noticeError = $state(false);
  let searchOpen = $state(false);
  let transcript = $state<ConversationTranscript>();
  export async function scrollToEnd(force: boolean, smooth: boolean): Promise<boolean> {
    return !printMode && !!(await transcript?.scrollToEnd(force, smooth));
  }
  setConversationPresentation({ notify(level, message) { notice = message; noticeError = level === 'error'; } });
  $effect(() => { controller.generation; notice = ''; searchOpen = false; });
  const owner = $derived(controller.owner!);
  const snapshot = $derived(controller.snapshot!);
  const attachmentPorts = $derived(controller.bindAttachments());
</script>

{#if !controller.retired}
<Tooltip.Provider>
<section class="conversation" class:conversation--print={printMode} aria-label={$t('Conversation messages')} data-owner={owner.identity.location}>
  {#if !printMode}
  <header>
    <Button size="sm" variant="ghost" onclick={() => (searchOpen = !searchOpen)}>{$t('Search this chat')}</Button>
    {#if snapshot.connection !== 'connected'}
      <span role="status">{$t(snapshot.connection === 'reconnecting' || controller.reconnecting ? 'Reconnecting…' : 'Disconnected')}</span>
      {#if owner.reconnect}<Button size="sm" variant="ghost" disabled={controller.reconnecting} onclick={() => void controller.reconnect()}>{$t('Reconnect')}</Button>{/if}
    {:else if snapshot.historyFailed && owner.reconnect}
      <Button size="sm" variant="ghost" disabled={controller.reconnecting} onclick={() => void controller.reconnect()}>{$t('Retry history')}</Button>
    {/if}
  </header>
  {/if}
  {#if controller.error}<p role="alert">{$t(controller.error)}</p>{/if}
  {#key controller.generation}
    <ConversationTranscript bind:this={transcript} {printMode} {announceMessages} blocks={snapshot.blocks} loading={snapshot.loading} sessionKey={conversationKey(owner.identity)} nativeMarkers={owner.identity.location === 'native'} {agentLabel} {language} bind:searchOpen readHistory={!printMode && owner.readHistory ? controller.readHistory : undefined} attachments={snapshot.attachments} onOpenAttachment={!printMode && owner.openAttachment ? attachmentPorts.open : undefined}
      resolveAttachment={owner.resolveAttachment ? attachmentPorts.resolve : undefined} onDownloadAttachment={owner.downloadAttachment ? attachmentPorts.download : undefined}
      messagePresentation={snapshot.presentation} decorateMessage={owner.decorateMessage ? controller.bindMessageDecoration() : undefined}
      decorateMessageHeader={owner.decorateMessageHeader ? controller.bindMessageDecoration('header') : undefined}
      olderAvailable={snapshot.olderAvailable} olderLoading={snapshot.olderLoading || controller.olderLoading} onLoadOlder={owner.loadOlder ? controller.bindLoadOlder() : undefined}
      messageControls={snapshot.messageControls} onMessageAction={owner.actOnMessage ? controller.bindMessageActions() : undefined}
      busyMessageActions={controller.busyMessageActions} messageActionErrors={controller.messageActionErrors} />
    {#if !printMode}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Long approvals have their own keyboard-scrollable region.) -->
    <div class="approvals" role="region" aria-label={$t('Approval requests')} tabindex="0">
      {#each snapshot.approvals as approval (approval.id)}
        <ApprovalRequest {approval} decisions={approval.decisions} idPrefix={`${mountId}-conversation-${controller.generation}-${encodeURIComponent(approval.id)}`} busy={controller.busyApproval === approval.id} disabled={!owner.respond || !!controller.busyApproval || snapshot.connection !== 'connected'} error={$t(controller.approvalErrors[approval.id] ?? '')} onRespond={(decision, answer) => controller.respond(approval.id, decision, answer)} />
      {/each}
    </div>
    {/if}
  {/key}
  {#if notice}<p role={noticeError ? 'alert' : 'status'}>{notice}</p>{/if}
</section>
</Tooltip.Provider>
{/if}

<style>
  .conversation { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .conversation--print { display: block; height: auto; }
  header { display: flex; align-items: center; gap: var(--piui-space-2); padding: var(--piui-space-2); }
  header span { margin-left: auto; color: var(--piui-text-muted); }
  .approvals { display: grid; flex-shrink: 1; min-height: 0; overflow-y: auto; gap: var(--piui-space-2); padding: 0 var(--piui-space-4); }
  p { padding: 0 var(--piui-space-4); color: var(--piui-text-muted); }
  p[role='alert'] { color: var(--piui-danger); }
</style>
