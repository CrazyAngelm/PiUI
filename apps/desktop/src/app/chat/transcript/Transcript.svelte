<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import { chatFilesSource } from '../../interactive/chatFilesSource';
  import type { MediaGate } from '../files/mediaGate';
  import { interactiveDecoration, type InteractiveAppTarget, type InteractiveReplyBlock } from '../../interactive/decorate';
  import { language } from '../../../features/locale/language';
  import { readWorkspaceHistory } from '../../../host-api/workspaceHistory';
  import type { TimelineBlock } from '../../../host-api/types';
  import type { ConversationAttachment, ConversationMedia, ConversationMessageAction, ConversationMessageControls } from '../../../../../../contracts/conversation-presentation-v1';
  import { toasts } from '../../../lib/ui';
  import type { TimedInsert } from '../../chatPipelines/interleave';
  import { pluginRegistry } from '../../plugins/pluginRegistry.svelte';
  import ConversationTranscript from '../../../shared/conversation/ConversationTranscript.svelte';
  import { setConversationPresentation } from '../../../shared/conversation/context';
  import NativeToolRenderer from './NativeToolRenderer.svelte';

  interface Props {
    blocks: TimelineBlock[];
    loading: boolean;
    sessionKey: string;
    historySessionId?: string;
    agentLabel: string;
    /** The chat's harness; only a Codex answer has its service markup removed. */
    answerHarness?: string;
    /** The agent is working: the last turn stays open instead of folding its activity. */
    running?: boolean;
    searchOpen?: boolean;
    olderAvailable?: boolean;
    olderLoading?: boolean;
    onLoadOlder?: () => void;
    emptyText?: string;
    inserts?: readonly TimedInsert[];
    insert?: Snippet<[string]>;
    interactive?: boolean;
    onReply?: (text: string) => Promise<boolean>;
    /** Why an answer's Send button is off right now (read live); nothing while a reply can be posted. */
    replyBlock?: InteractiveReplyBlock | undefined;
    /** Runs a button action of an answer from the closed application list; omitted where the view has none. */
    onApp?: (target: InteractiveAppTarget) => Promise<boolean>;
    messageControls?: readonly ConversationMessageControls[];
    onMessageAction?: (id: string, action: ConversationMessageAction) => Promise<void>;
    /** Files the agent produced, placed with the answer of their turn (ADR-074). */
    attachments?: readonly ConversationAttachment[];
    resolveAttachment?: (id: string) => Promise<ConversationMedia>;
    /** The chat's media budget and transfer queue, shared by its cards, galleries and widgets (ADR-074). */
    mediaGate?: MediaGate;
    onOpenAttachment?: (id: string) => Promise<void>;
    onDownloadAttachment?: (id: string) => Promise<void>;
    onRevealAttachment?: (id: string) => Promise<void>;
    /** Opens an http(s) link of a message in the system browser through the host. Resolve false when it cannot: the link is copied instead. */
    onOpenLink?: (url: string) => Promise<boolean>;
  }
  let { searchOpen = $bindable(false), interactive = false, onReply = undefined, replyBlock = undefined, onApp = undefined, onOpenLink = undefined, running = false, ...props }: Props = $props();
  const decorateMessage = untrack(() => interactive) ? interactiveDecoration({
    reply: () => onReply,
    replyBlock: () => replyBlock,
    ...(untrack(() => onApp) === undefined ? {} : { app: async (target: InteractiveAppTarget) => (await onApp?.(target)) ?? false }),
    // A link of an answer opens through the host, which asks the person first; without a route it is copied.
    ...(untrack(() => onOpenLink) === undefined ? {} : { openLink: async (url: string) => (await onOpenLink?.(url)) ?? false }),
    files: chatFilesSource(() => props.historySessionId),
    gate: untrack(() => props.mediaGate),
    notify: (message: string) => { toasts.show({ title: message }); },
  }) : undefined;
  // Answers read these live (the Send button's reason, the reply operation); tell them when one changes.
  $effect(() => {
    void [running, replyBlock, onReply];
    decorateMessage?.refresh();
  });
  setConversationPresentation({
    notify(level, message) { toasts[level](message); },
    // The host owns opening addresses (AGENTS.md); with no route a link is copied for the reader.
    openLink: async (url) => (await onOpenLink?.(url)) ?? false,
    renderer(block) {
      const match = pluginRegistry.renderer(block.toolName);
      return match ? { key: match.plugin.id + ':' + match.renderer.id, title: match.renderer.title, source: match.plugin.name, component: NativeToolRenderer } : undefined;
    },
  });
  const historyReader = $derived(props.historySessionId ? (() => {
    const id = props.historySessionId!;
    return () => readWorkspaceHistory(id);
  })() : undefined);
  // Native reading metadata retains its existing key and storage owner. The
  // shared browser surface receives no store, including for temporary chats.
  // `anchor` names the block at the top of the view and the distance into it (older saves have only `top`).
  type SavedView = { top: number; following: boolean; anchor?: { id: string; offset: number } };
  const positionStore = {
    read(key: string): SavedView | undefined {
      const value = JSON.parse(localStorage.getItem(`piui.conversation.view.${key}`) ?? 'null');
      if (!value || !Number.isFinite(value.top) || typeof value.following !== 'boolean') return undefined;
      const anchor = value.anchor;
      const valid = anchor && typeof anchor.id === 'string' && Number.isFinite(anchor.offset);
      return { top: value.top, following: value.following, ...(valid ? { anchor: { id: anchor.id, offset: anchor.offset } } : {}) };
    },
    write(key: string, value: SavedView): void {
      localStorage.setItem(`piui.conversation.view.${key}`, JSON.stringify(value));
    },
  };
</script>

{#key props.sessionKey}
  <ConversationTranscript {...props} {running} language={$language} readHistory={historyReader} nativeMarkers={true} {positionStore} {decorateMessage} richMarkdown={false} bind:searchOpen />
{/key}
