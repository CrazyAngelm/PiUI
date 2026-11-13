<script lang="ts">
  import type { Snippet } from 'svelte';
  import { language } from '../../../features/locale/language';
  import { readWorkspaceHistory } from '../../../host-api/workspaceHistory';
  import type { TimelineBlock } from '../../../host-api/types';
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
    searchOpen?: boolean;
    olderAvailable?: boolean;
    olderLoading?: boolean;
    onLoadOlder?: () => void;
    emptyText?: string;
    inserts?: readonly TimedInsert[];
    insert?: Snippet<[string]>;
  }
  let { searchOpen = $bindable(false), ...props }: Props = $props();
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
  <ConversationTranscript {...props} language={$language} readHistory={historyReader} nativeMarkers={true} {positionStore} bind:searchOpen />
{/key}
