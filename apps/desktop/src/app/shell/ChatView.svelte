<script lang="ts">
  import PanelRight from '@lucide/svelte/icons/panel-right';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Square from '@lucide/svelte/icons/square';
  import Trash from '@lucide/svelte/icons/trash-2';
  import SmilePlus from '@lucide/svelte/icons/smile-plus';
  import X from '@lucide/svelte/icons/x';
  import Power from '@lucide/svelte/icons/power';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { onDestroy, untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import { composerRequest } from '../../host-api/composerClient';
  import { statusLabel } from '../../features/workspace/workspaceState';
  import { Badge, Button, EmptyState, IconButton, Menu, Skeleton, Spinner, matchesShortcut, toasts } from '../../lib/ui';
  import type { ConversationMessageAction } from '../../../../../contracts/conversation-presentation-v1';
  import { readWorkspaceHistory } from '../../host-api/workspaceHistory';
  import { harnessMeta } from '../harnessMeta';
  import ApprovalCard from './ApprovalCard.svelte';
  import HarnessMark from './HarnessMark.svelte';
  import ChatDetails from './ChatDetails.svelte';
  import ChatComposer from '../chat/ChatComposer.svelte';
  import { macros } from '../macros/macros.svelte';
  import { echoBlocks, steerEchoes, waitingEchoes } from '../chat/steerEcho.svelte';
  import ExtensionSurface from '../chat/extensions/ExtensionSurface.svelte';
  import PluginComposerActions from '../plugins/PluginComposerActions.svelte';
  import { extensionSurfaces } from '../chat/extensions/extensionSurfaces.svelte';
  import Transcript from '../chat/transcript/Transcript.svelte';
  import { openLinkInHost } from '../chat/openChatLink';
  import { ChatFilesStore } from '../chat/files/chatFiles.svelte';
  import { createChatFilePlacer } from '../chat/files/placeChatFiles';
  import { errorMessage } from '../workspaceStore.svelte';
  import { sessionActivity } from '../chat/activity/sessionActivity';
  import SearchIcon from '@lucide/svelte/icons/search';
  import GitCompare from '@lucide/svelte/icons/git-compare';
  import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
  import Link2 from '@lucide/svelte/icons/link-2';
  import Send from '@lucide/svelte/icons/send';
  import { sessionLinks } from '../links/sessionLinks.svelte';
  import { composerInserts } from '../review/composerInserts.svelte';
  import { placements } from '../worktrees/placements.svelte';
  import { startHandoff } from '../handoff/startHandoff';
  import { startBranch } from '../branch/branchChat';
  import { announceBranch } from '../branch/branchFeedback';
  import { branchCutAfter, buildMessageControls, editDraft } from '../branch/messageActions';
  import { CopyFeedback } from '../branch/copyFeedback.svelte';
  import { useWorkspace } from './context';
  import ChatRunCard from '../chatPipelines/ChatRunCard.svelte';
  import { chatPipelines } from '../chatPipelines/chatPipelines.svelte';
  import ActiveCardChip from '../board/ActiveCardChip.svelte';
  import ChatBoardActivity from '../board/ChatBoardActivity.svelte';
  import { sessionNotices, sidekickToolNotice } from '../../features/workspace/sessionNotices';
  import FusionBadge from '../fusion/FusionBadge.svelte';
  import FusionNotice from '../fusion/FusionNotice.svelte';
  import SettingsNotice from '../chat/SettingsNotice.svelte';
  import SidekickOfBadge from '../fusion/SidekickOfBadge.svelte';
  import { fusionMembership } from '../fusion/fusionMembership.svelte';
  import NanoPetStatus from '../nano/NanoPetStatus.svelte';
  import { remoteMode } from '../nano/remoteMode';
  import type { InteractiveAppTarget, InteractiveReplyBlock } from '../interactive/decorate';
  import Mark from '../marks/Mark.svelte';
  import { marks } from '../marks/marks.svelte';

  // Loaded on first use; a script-level import lets the dev server see its dependencies.
  const loadReviewPanel = () => import('../review/ReviewPanel.svelte');

  interface Props {
    sessionId: string;
    onDelete: (sessionId: string) => void;
    /** False for a chat in a split pane that is not the selected one: no shortcuts, no page landmark. */
    active?: boolean;
    /** Present when several panes are open: closes this one (the tab stays). */
    onClosePane?: () => void;
  }
  let { sessionId, onDelete, active = true, onClosePane = undefined }: Props = $props();
  const store = useWorkspace();

  const session = $derived(store.catalog.sessions.find((item) => item.id === sessionId));
  const snapshot = $derived(store.snapshots[sessionId]);
  // The selected chat reports through the store's single fields, a chat in a pane through its own.
  const loadingNow = $derived(store.loadingFor(sessionId));
  const loadError = $derived(store.errorFor(sessionId));
  // A pane opened beside the selected chat loads itself.
  // It reads the derived `snapshot`, which changes only with this chat's own snapshot: `store.snapshots` is replaced on every
  // event of any chat, and a failed load would otherwise be asked again, and its error redrawn, each time.
  $effect(() => {
    if (!active && !snapshot) untrack(() => void store.showSession(sessionId));
  });
  // A narrow pane drops the inspector and the header extras instead of overflowing.
  let width = $state(0);
  let mainWidth = $state(0);
  const roomy = $derived(width === 0 || width >= 720);
  const compact = $derived(mainWidth !== 0 && mainWidth < 560);
  // A message steered into a running turn stays in the chat until the agent's runtime reports it.
  const turnActive = $derived(snapshot?.session.status === 'running' || snapshot?.session.status === 'stopping');
  const echoes = $derived(snapshot && turnActive ? waitingEchoes(steerEchoes.list(sessionId), snapshot.blocks) : []);
  const shownBlocks = $derived(snapshot ? (echoes.length ? [...snapshot.blocks, ...echoBlocks(echoes)] : snapshot.blocks) : []);
  $effect(() => {
    const current = snapshot;
    if (!current) return;
    const active = turnActive;
    untrack(() => steerEchoes.settle(sessionId, current.blocks, active));
  });
  // Files the agent wrote, read or returned (ADR-074). A remote browser and safe mode have none: the host refuses both.
  const chatFiles = remoteMode ? undefined : new ChatFilesStore();
  $effect(() => {
    const id = sessionId;
    chatFiles?.bind(store.safeMode ? '' : id);
  });
  $effect(() => {
    const blocks = snapshot?.blocks;
    void blocks?.length;
    void blocks?.[blocks.length - 1]?.status;
    void snapshot?.session.status;
    untrack(() => chatFiles?.scheduleRefresh());
  });
  onDestroy(() => chatFiles?.dispose());
  const running = $derived(session ? ['starting', 'running', 'stopping'].includes(session.status) : false);
  // Recomputed only when the turns, a block's status, the registry or the language change, not on every streamed token.
  const placeFiles = createChatFilePlacer();
  const fileCards = $derived(chatFiles ? placeFiles(shownBlocks, chatFiles.files, $t, running) : []);
  async function fileAction(action: 'open' | 'reveal' | 'save', id: string): Promise<void> {
    if (!chatFiles) return;
    try {
      if (action === 'save') {
        if (await chatFiles.save(id)) toasts.success($t('File saved'));
      } else if (action === 'reveal') await chatFiles.reveal(id);
      else await chatFiles.open(id);
    } catch (error) {
      toasts.error($t(errorMessage(error)));
    }
  }
  const workspace = $derived(store.catalog.workspaces.find((item) => item.id === session?.workspaceId));
  // Project chats (not pipeline members) can have an active board card (ADR-041).
  // A remote browser has no board: the card chip and activity stay out of its chats.
  const boardProject = $derived(!remoteMode && workspace !== undefined && !workspace.personal && !workspace.missing && !session?.runId ? workspace.id : undefined);
  const notices = $derived(sessionNotices(snapshot));
  // Fusion (ADR-043): a lead chat shows the pair badge, a sidekick chat is read-only.
  const fusion = $derived(fusionMembership.peek(sessionId));
  $effect(() => {
    void fusionMembership.load(sessionId);
  });
  const isSidekick = $derived(fusion?.role === 'sidekick');
  const isLead = $derived(fusion?.role === 'lead');
  // Linked chats (ADR-069): the menu offers "Send to chat…" only once this chat has links.
  $effect(() => {
    const id = sessionId;
    untrack(() => void sessionLinks.load(id));
  });
  const hasLinks = $derived((sessionLinks.peek(sessionId)?.length ?? 0) > 0);
  let linkDialog = $state<'link' | 'send' | undefined>(undefined);
  // Only the sidekick in use is the broker's: a retired one's chat may be deleted.
  const currentSidekick = $derived(fusionMembership.isCurrentSidekick(sessionId));
  // Pipeline runs started from this chat, shown among its messages by time.
  const chatPipeline = $derived(chatPipelines.chats[sessionId]);
  const runInserts = $derived((chatPipeline?.runs ?? []).map((entry) => ({ id: entry.runId, at: entry.startedAt })));
  $effect(() => {
    const id = sessionId;
    if (session && !session.runId) void chatPipelines.loadChat(id);
  });

  let detailsOpen = $state(readDetailsOpen());
  /** The review panel replaces the details panel while open (one inspector). */
  let reviewOpen = $state(false);
  let searchOpen = $state(false);
  let renaming = $state(false);
  let marking = $state(false);
  const sessionMark = $derived(marks.session(sessionId));
  let titleDraft = $state('');
  let titleInput = $state<HTMLInputElement | null>(null);

  const detailsShown = $derived(roomy && detailsOpen && !reviewOpen);
  /** What the agent runs now (ADR-072); the toolbar says so while the details panel is closed. */
  const runningWork = $derived(sessionActivity(snapshot).ongoing);

  function readDetailsOpen(): boolean {
    try {
      return localStorage.getItem('piui.shell.details') === '1';
    } catch {
      return false;
    }
  }
  function toggleDetails(): void {
    detailsOpen = reviewOpen ? true : !detailsOpen;
    reviewOpen = false;
    try {
      localStorage.setItem('piui.shell.details', detailsOpen ? '1' : '0');
    } catch {
      // Optional UI preference.
    }
  }
  function toggleReview(): void {
    reviewOpen = !reviewOpen;
  }

  function beginRename(): void {
    if (!session) return;
    titleDraft = session.title;
    renaming = true;
    queueMicrotask(() => titleInput?.select());
  }
  async function commitRename(): Promise<void> {
    if (!renaming || !session) return;
    renaming = false;
    if (titleDraft.trim() && titleDraft.trim() !== session.title) await store.rename(session.id, titleDraft);
  }

  function keydown(event: KeyboardEvent): void {
    if (!active) return;
    if (remoteMode && matchesShortcut(event, 'Mod+Shift+G')) return;
    if (roomy && matchesShortcut(event, 'Mod+Alt+B')) {
      event.preventDefault();
      toggleDetails();
    } else if (matchesShortcut(event, 'Mod+F')) {
      event.preventDefault();
      searchOpen = true;
    } else if (roomy && matchesShortcut(event, 'Mod+Shift+G')) {
      event.preventDefault();
      toggleReview();
    }
  }

  // Mirrors the composer-zone branches below: the composer is drawn only for a live,
  // promptable session outside safe mode. While it shows its own "Stop turn" the header
  // stays quiet, so a running turn has exactly one stop control.
  const composerShown = $derived(
    snapshot !== undefined && !store.safeMode && !isSidekick && !snapshot.session.runId && snapshot.session.status !== 'closed' && snapshot.capabilities.prompt.supported,
  );
  const composerStops = $derived(composerShown && (session?.status === 'running' || session?.status === 'stopping'));

  async function reply(text: string): Promise<boolean> {
    if (!composerShown || running) return false;
    try {
      await composerRequest({ type: 'send', sessionId, requestId: crypto.randomUUID(), text, mode: 'prompt' });
      return true;
    } catch {
      return false;
    }
  }

  // Why an answer's Send button is off, read live by the widgets; mirrors `composerShown` and `reply` above.
  const replyBlock = $derived<InteractiveReplyBlock | undefined>(
    store.safeMode ? 'safe-mode'
    : session?.status === 'closed' ? 'closed'
    : isSidekick || session?.runId ? 'read-only'
    : snapshot !== undefined && !snapshot.capabilities.prompt.supported ? 'no-prompt'
    : running ? 'busy'
    : undefined,
  );
  // The closed list of application actions an answer's button may request. A remote browser has none.
  async function appAction(target: InteractiveAppTarget): Promise<boolean> {
    if (remoteMode) return false;
    if (target === 'open_settings') store.navigate({ name: 'settings', section: 'general' });
    else if (target === 'open_schedule') store.navigate({ name: 'pipelines', section: 'schedules' });
    else if (target === 'open_agents') store.navigate({ name: 'pipelines', section: 'agents' });
    else store.goHome(session?.workspaceId);
    return true;
  }

  // Message controls: copy everywhere; edit and branch where this chat can start another one.
  const copied = new CopyFeedback();
  onDestroy(() => copied.dispose());
  let branching = $state(false);
  const branchable = $derived(!remoteMode && !isSidekick && !session?.runId);
  const messageControls = $derived(
    snapshot ? buildMessageControls(snapshot.blocks, { readOnly: !branchable, running, locked: store.safeMode || branching, copiedId: copied.id }) : [],
  );

  async function messageAction(id: string, action: ConversationMessageAction): Promise<void> {
    const current = snapshot;
    const block = current?.blocks.find((item) => item.id === id);
    if (!current || !block) return;
    if (action === 'copy') {
      await copied.copy(block, () => readWorkspaceHistory(current.session.id));
      return;
    }
    if ((action !== 'edit' && action !== 'branch') || !branchable || branching || store.safeMode) return;
    const cut = action === 'edit' ? { at: 'before' as const, blockId: id } : branchCutAfter(current.blocks, id);
    if (!cut) return;
    branching = true;
    try {
      // A long prompt is shown cut short: the draft is the whole message, read from the saved history like Copy does.
      let draft: string | undefined = '';
      if (action === 'edit') {
        draft = await editDraft(block, () => readWorkspaceHistory(current.session.id));
        if (draft === undefined) {
          toasts.error($t('The whole message could not be read. No branch was created.'));
          return;
        }
      }
      const result = await startBranch(store, current, cut, { open: 'here', translate: $t, ...(draft ? { draft } : {}) });
      if (!result.ok) {
        toasts.error($t(result.error));
        return;
      }
      if (result.error) toasts.error($t(result.error));
      announceBranch(result, $t, (id) => void store.openSession(id));
    } finally {
      branching = false;
    }
  }

  const statusTone = $derived(
    session?.status === 'failed' ? 'danger' : running ? 'accent' : session?.status === 'closed' ? 'neutral' : undefined,
  );
</script>

<svelte:window onkeydown={keydown} />

{#if session}
  <div class="chat" class:chat--details={roomy && detailsOpen && !reviewOpen} class:chat--review={roomy && reviewOpen} bind:clientWidth={width}>
    <section class="chat__main" aria-labelledby={active ? 'chat-title' : undefined} aria-label={active ? undefined : session.title} bind:clientWidth={mainWidth}>
      <header class="chat__head">
        <HarnessMark kind={session.harness} size={20} decorative={false} />
        {#if sessionMark}<Mark mark={sessionMark} size={18} />{/if}
        {#if renaming}
          <input
            bind:this={titleInput}
            bind:value={titleDraft}
            class="title-input"
            aria-label={$t('Chat title')}
            onblur={() => void commitRename()}
            onkeydown={(event) => {
              if (event.key === 'Enter') void commitRename();
              if (event.key === 'Escape') renaming = false;
            }}
          />
        {:else}
          <h1 id={active ? 'chat-title' : undefined} ondblclick={beginRename} title={session.title}>{session.title}</h1>
        {/if}
        {#if statusTone && !compact}
          <Badge tone={statusTone}>
            {#if running}<Spinner size={10} />{/if}
            {$t(statusLabel(session.status))}
          </Badge>
        {/if}
        {#if workspace && !compact}
          <span class="chat__meta">{workspace.personal ? $t('Personal chats') : workspace.name}</span>
        {/if}
        {#if boardProject}
          <ActiveCardChip workspaceId={boardProject} sessionId={session.id} harness={session.harness} {notices} />
        {/if}
        {#if fusion?.role === 'lead'}
          {#key session.id}<FusionBadge leadSessionId={session.id} />{/key}
        {:else if fusion?.role === 'sidekick'}
          <SidekickOfBadge leadSessionId={fusion.leadSessionId} />
        {/if}
        <div class="chat__actions">
          {#if snapshot && !remoteMode}
            <NanoPetStatus status={session.status} approvals={snapshot.approvals.length} blocks={snapshot.blocks} safeMode={store.safeMode} />
          {/if}
          {#if running && !composerStops}
            <!-- Fusion stops through the broker: a lead stops the pair, a sidekick stops its round (the store routes it). -->
            <Button
              size="sm"
              variant="ghost"
              onclick={() => void store.interrupt(session.id)}
              loading={store.interruptBusy}
              disabled={isSidekick && !fusion?.leadSessionId}
              aria-label={isSidekick ? $t('Stop sidekick') : isLead ? $t('Stop lead and sidekick') : undefined}
            >
              {#snippet leading()}<Square />{/snippet}
              {$t('Stop')}
            </Button>
          {/if}
          <IconButton label={$t('Search this chat')} shortcut="Mod+F" active={searchOpen} onclick={() => (searchOpen = !searchOpen)}><SearchIcon /></IconButton>
          {#if !remoteMode && roomy}
            <IconButton label={$t('Review changes')} shortcut="Mod+Shift+G" active={reviewOpen} onclick={toggleReview}><GitCompare /></IconButton>
          {/if}
          {#if roomy}
            <span class="chat__details-toggle">
              <IconButton label={$t('Details')} shortcut="Mod+Alt+B" active={detailsOpen && !reviewOpen} onclick={toggleDetails}><PanelRight /></IconButton>
              {#if runningWork > 0 && !detailsShown}<span class="chat__running-dot" aria-hidden="true"></span>{/if}
              <span class="visually-hidden" role="status">{runningWork > 0 ? $t('{0} running in this chat', [runningWork]) : ''}</span>
            </span>
          {/if}
          <Menu
            align="end"
            items={[
              { label: $t('Rename'), icon: Pencil, onSelect: beginRename },
              { label: $t('Mark…'), icon: SmilePlus, onSelect: () => (marking = true) },
              { label: $t('Refresh from history'), icon: RefreshCw, onSelect: () => void store.reconcileSession(session.id) },
              ...(snapshot && !session.runId && !remoteMode
                ? [{ label: $t('Continue in another harness…'), icon: ArrowRightLeft, disabled: store.safeMode, onSelect: () => void startHandoff(store, snapshot, $t) }]
                : []),
              ...(!session.runId && !isSidekick && !remoteMode
                ? [
                    { label: $t('Link chat…'), icon: Link2, disabled: store.safeMode, onSelect: () => (linkDialog = 'link') },
                    ...(hasLinks ? [{ label: $t('Send to chat…'), icon: Send, disabled: store.safeMode, onSelect: () => (linkDialog = 'send') }] : []),
                  ]
                : []),
              ...(session.status !== 'closed'
                ? [{ label: currentSidekick ? $t('Stop sidekick process and its round') : $t('Stop agent process'), icon: Power, disabled: store.sessionActionBusy, onSelect: () => void store.close(session.id) }]
                : []),
              { type: 'separator' as const },
              ...(!session.runId && !currentSidekick && !remoteMode
                ? [{ label: $t('Delete chat…'), icon: Trash, danger: true, disabled: running || store.safeMode, onSelect: () => onDelete(session.id) }]
                : []),
            ]}
          >
            {#snippet trigger(props)}
              <IconButton label={$t('Chat actions')} tooltip={false} {...props}><Ellipsis /></IconButton>
            {/snippet}
          </Menu>
          {#if linkDialog === 'link'}
            {#await import('../links/LinkChatDialog.svelte') then dialog}
              <dialog.default sessionId={session.id} onClose={() => (linkDialog = undefined)} />
            {/await}
          {:else if linkDialog === 'send'}
            {#await import('../links/SendToChatDialog.svelte') then dialog}
              <dialog.default sessionId={session.id} onClose={() => (linkDialog = undefined)} />
            {/await}
          {/if}
          {#if marking}
            {#await import('../marks/MarkPicker.svelte') then picker}
              <picker.default target={{ kind: 'session', id: session.id }} onClose={() => (marking = false)} />
            {/await}
          {/if}
          {#if onClosePane}
            <IconButton label={$t('Close pane')} onclick={() => onClosePane?.()}><X /></IconButton>
          {/if}
        </div>
      </header>

      {#if loadError}
        <div class="banner" role="alert">
          <span>{$t(loadError)}</span>
          <Button size="sm" variant="ghost" onclick={() => void store.reconcileSession(session.id)}>{$t('Check status')}</Button>
        </div>
      {/if}

      {#if snapshot}
          <Transcript
            blocks={shownBlocks}
            interactive={!store.safeMode}
            onReply={reply}
            {replyBlock}
            onApp={remoteMode ? undefined : appAction}
            onOpenLink={remoteMode ? undefined : openLinkInHost}
            {messageControls}
            onMessageAction={messageAction}
            attachments={fileCards}
            resolveAttachment={chatFiles?.resolve}
            mediaGate={chatFiles?.gate}
            onOpenAttachment={chatFiles ? (id) => fileAction('open', id) : undefined}
            onDownloadAttachment={chatFiles ? (id) => fileAction('save', id) : undefined}
            onRevealAttachment={chatFiles ? (id) => fileAction('reveal', id) : undefined}
            loading={loadingNow}
            sessionKey={snapshot.session.id}
            historySessionId={snapshot.session.id}
            agentLabel={harnessMeta(snapshot.session.harness).label}
            answerHarness={snapshot.session.harness}
            {running}
            bind:searchOpen
            inserts={runInserts}
            emptyText={fusion?.role === 'sidekick' ? $t('No briefs yet. The lead sends one when it delegates work.') : undefined}
          >
            {#snippet insert(runId)}
              {@const entry = chatPipeline?.runs.find((item) => item.runId === runId)}
              {#if entry}
                <ChatRunCard {entry} workspaceId={snapshot.session.workspaceId} sessionId={snapshot.session.id} safeMode={store.safeMode} onOpenRun={(id) => store.openRun(snapshot.session.workspaceId, id)} />
              {/if}
            {/snippet}
          </Transcript>
          <div class="composer-zone">
            {#each snapshot.approvals as approval (approval.id)}
              <ApprovalCard {approval} session={snapshot.session} />
            {/each}
            <FusionNotice code={sidekickToolNotice(notices)} />
            <SettingsNotice {notices} />
            {#if boardProject}
              <ChatBoardActivity workspaceId={boardProject} sessionId={snapshot.session.id} blocks={snapshot.blocks} />
            {/if}
            <ExtensionSurface sessionId={snapshot.session.id} status={snapshot.session.status} placement="above" agentLabel={harnessMeta(snapshot.session.harness).label} />
            {#if store.safeMode}
              <p class="notice">{$t('Runtime actions are disabled in safe mode. Your draft is preserved.')}</p>
            {:else if fusion?.role === 'sidekick'}
              <!-- The broker owns the sidekick's turns; the host refuses Send for it (NOT_SUPPORTED). -->
              <p class="notice">
                {$t('This is the sidekick of a Fusion chat. Its lead gives it work through briefs, so you cannot message it here. Talk to the lead chat instead.')}
                {#if fusion.leadSessionId}
                  {@const leadId = fusion.leadSessionId}
                  <Button size="sm" variant="ghost" onclick={() => void store.openSession(leadId)}>{$t('Open lead chat')}</Button>
                {/if}
              </p>
            {:else if snapshot.session.status === 'closed' && placements.get(session.id)?.worktree?.state === 'removed'}
              <p class="notice">{$t("This chat's worktree was removed. Its history stays readable; start a new chat to keep working.")}</p>
            {:else if snapshot.session.status === 'closed'}
              <p class="notice">
                {#if !snapshot.capabilities.prompt.supported && snapshot.capabilities.prompt.reason === 'This chat is open in another Codex process.'}
                  {$t('Another Codex process is using this chat. You can read its history here. Resume after the other process releases it.')}
                {:else}
                  {$t('The agent process is stopped. The transcript stays readable.')}
                {/if}
                <Button size="sm" variant="ghost" disabled={loadingNow} onclick={() => void (active ? store.openSession(session.id) : store.showSession(session.id))}>{$t('Resume')}</Button>
              </p>
            {:else if session.runId}
              <!-- Run members follow their run's saved settings (ADR-044). -->
              <p class="notice">
                {$t('This agent is part of a pipeline run and follows its saved settings. You can stop it or answer its requests here.')}
                <Button size="sm" variant="ghost" onclick={() => store.openRun(session.workspaceId, session.runId)}>{$t('Part of a pipeline run')}</Button>
              </p>
            {:else if !snapshot.capabilities.prompt.supported}
              <p class="notice">{snapshot.capabilities.prompt.reason ? $t(snapshot.capabilities.prompt.reason) : $t('{0} is read-only in this mode.', [harnessMeta(session.harness).label])}</p>
            {:else}
              {#if !remoteMode}
                <PluginComposerActions sessionId={snapshot.session.id} harness={snapshot.session.harness} />
              {/if}
              <!-- Extension-prepared text remounts the composer with the new draft. -->
              {#key `${snapshot.session.id}:${extensionSurfaces.composerEpoch(snapshot.session.id)}:${composerInserts.epoch(snapshot.session.id)}`}
                <ChatComposer
                  {snapshot}
                  draft={store.draftFor(snapshot.session.id)}
                  updateDraft={(text: string) => store.updateDraft(snapshot.session.id, text)}
                  images={store.attachmentsFor(snapshot.session.id)}
                  updateImages={(images) => store.updateAttachments(snapshot.session.id, images)}
                  refresh={() => void store.reconcileSession(snapshot.session.id)}
                  interrupt={() => store.interrupt(snapshot.session.id)}
                  interruptBusy={store.interruptBusy}
                  safeMode={store.safeMode}
                  {active}
                  onEditMacro={(id) => { macros.requestEdit(id); store.navigate({ name: 'settings', section: 'macros' }); }}
                />
              {/key}
            {/if}
            <ExtensionSurface sessionId={snapshot.session.id} status={snapshot.session.status} placement="below" agentLabel={harnessMeta(snapshot.session.harness).label} />
          </div>
        {:else if loadingNow}
          <div class="loading"><Skeleton lines={6} /></div>
        {:else}
          <EmptyState title={$t('The chat could not be opened')} description={loadError ? $t(loadError) : undefined}>
            {#snippet actions()}
              <Button size="sm" onclick={() => void (active ? store.openSession(session.id) : store.showSession(session.id))} disabled={store.safeMode}>{$t('Try again')}</Button>
            {/snippet}
          </EmptyState>
        {/if}
    </section>

    {#if !roomy}
      <!-- A narrow pane has no room for an inspector. -->
    {:else if reviewOpen}
      <!-- Loaded on first use; keyed so each chat gets its own review state. -->
      {#await loadReviewPanel() then review}
        {#key session.id}
          <review.default sessionId={session.id} status={session.status} onClose={toggleReview} />
        {/key}
      {/await}
    {:else if detailsOpen && snapshot}
      <ChatDetails {snapshot} managed={isSidekick || Boolean(snapshot.session.runId)} onClose={toggleDetails} onReview={toggleReview} />
    {/if}
  </div>
{:else}
  <EmptyState title={$t('This chat is no longer available')} description={$t('It may have been deleted.')}>
    {#snippet actions()}
      <Button size="sm" onclick={() => store.goHome()}>{$t('New chat')}</Button>
    {/snippet}
  </EmptyState>
{/if}

<style>
  .chat {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }
  .chat--details {
    grid-template-columns: minmax(0, 1fr) var(--piui-panel-width);
  }
  .chat--review {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .chat__main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .chat__head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-3) 0 var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  h1 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: text;
  }
  .title-input {
    min-width: 200px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--piui-focus);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    outline: none;
  }
  .chat__meta {
    min-width: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chat__actions {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
  }
  .chat__details-toggle {
    position: relative;
    display: inline-flex;
  }
  .chat__running-dot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--piui-accent);
    pointer-events: none;
  }
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
    margin: var(--piui-space-2) var(--piui-space-4) 0;
    padding: 6px 6px 6px 12px;
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
  }
  .loading {
    padding: var(--piui-space-8);
  }
  .composer-zone {
    display: grid;
    gap: var(--piui-space-2);
    width: min(var(--piui-chat-column-width), 100%);
    margin: 0 auto;
    padding: 0 var(--piui-chat-inline-padding) var(--piui-space-3);
    flex: none;
  }
  .notice {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--piui-space-2);
    margin: 0;
    padding: var(--piui-space-3);
    border: 1px dashed var(--piui-border);
    border-radius: var(--piui-radius-md);
    color: var(--piui-text-muted);
    text-align: center;
  }
</style>
