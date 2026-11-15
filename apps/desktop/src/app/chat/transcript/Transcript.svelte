<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import { interactiveDecoration } from '../../interactive/decorate';
  import { language } from '../../../features/locale/language';
  import { readWorkspaceHistory } from '../../../host-api/workspaceHistory';
  import type { TimelineBlock } from '../../../host-api/types';
  import type { ConversationMessageAction, ConversationMessageControls } from '../../../../../../contracts/conversation-presentation-v1';
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
    messageControls?: readonly ConversationMessageControls[];
    onMessageAction?: (id: string, action: ConversationMessageAction) => Promise<void>;
  }
  let { searchOpen = $bindable(false), interactive = false, onReply = undefined, running = false, ...props }: Props = $props();
  const decorateMessage = untrack(() => interactive) ? interactiveDecoration({ reply: () => onReply }) : undefined;
  setConversationPresentation({
    notify(level, message) { toasts[level](message); },
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
  const positionStore = {
    read(key: string): { top: number; following: boolean } | undefined {
      const value = JSON.parse(localStorage.getItem(`piui.conversation.view.${key}`) ?? 'null');
      return value && Number.isFinite(value.top) && typeof value.following === 'boolean' ? value : undefined;
    },
    write(key: string, value: { top: number; following: boolean }): void {
      localStorage.setItem(`piui.conversation.view.${key}`, JSON.stringify(value));
    },
  };
</script>

{#key props.sessionKey}
  <ConversationTranscript {...props} {running} language={$language} readHistory={historyReader} nativeMarkers={true} {positionStore} {decorateMessage} richMarkdown={false} bind:searchOpen />
{/key}
