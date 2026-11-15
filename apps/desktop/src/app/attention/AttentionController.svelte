<script lang="ts">
  import { untrack } from 'svelte';
  import { attentionHost, type AttentionClient } from '../../host-api/attentionClient';
  import { fusionMembership } from '../fusion/fusionMembership.svelte';
  import { sessionLinks } from '../links/sessionLinks.svelte';
  import { useWorkspace } from '../shell/context';
  import { attention } from './attention.svelte';
  import { evaluateAttention, snapshotOf, type AttentionSnapshot, type RuleApproval, type RuleSession } from './attentionRules';
  import { playSound } from './sounds';

  /** Reports are batched: several events in one burst are one call. */
  const REPORT_DELAY_MS = 150;

  interface Props {
    client?: AttentionClient;
  }
  let { client = attentionHost }: Props = $props();

  const store = useWorkspace();

  const readFocus = (): boolean => document.visibilityState === 'visible' && document.hasFocus();
  let focused = $state(readFocus());

  $effect(() => {
    const update = (): void => {
      focused = readFocus();
    };
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  });

  let previous: AttentionSnapshot | undefined;
  let flashPending = false;
  let reported = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const wantedCount = (): number => (attention.settings.badge ? attention.count : 0);

  async function flush(): Promise<void> {
    timer = undefined;
    const count = wantedCount();
    const flash = flashPending;
    flashPending = false;
    if (count === reported && !flash) return;
    reported = count;
    // A refusal leaves the host's badge unknown: the next change reports again.
    if ((await client.set({ count, flash })) !== undefined) reported = -1;
  }

  function schedule(): void {
    timer ??= setTimeout(() => void flush(), REPORT_DELAY_MS);
  }

  function observe(sessions: readonly RuleSession[], approvals: readonly RuleApproval[], loaded: readonly string[], shown: readonly string[], isFocused: boolean): void {
    attention.setVisible(shown);
    const current = snapshotOf(sessions, approvals, loaded);
    const verdict = evaluateAttention(previous, current, {
      sessions,
      visible: attention.visible,
      focused: isFocused,
      unseen: attention.unseen,
      isSidekick: (id) => fusionMembership.peek(id)?.role === 'sidekick',
      isAgentChild: (id) => sessionLinks.isAgentChild(id),
    });
    previous = current;
    const raised = attention.apply(verdict);
    if (raised.length > 0) {
      // One sound per burst, however many chats changed in this tick.
      if (attention.settings.sound) void playSound(attention.settings.soundId, attention.settings.volume);
      if (attention.settings.flash && !isFocused) flashPending = true;
    }
    schedule();
  }

  // The sessions, the approvals, what is on screen and the focus are the inputs; the rest is untracked.
  $effect(() => {
    // The first catalog read is not an observation: chats that were already there raise nothing.
    if (store.catalogLoading) return;
    const sessions: RuleSession[] = store.catalog.sessions.map((session) => ({ id: session.id, status: session.status, runId: session.runId }));
    const approvals: RuleApproval[] = store.inboxApprovals.map((item) => ({ id: item.approval.id, sessionId: item.session.id }));
    // A chat's snapshot arrives after the catalog: the requests it brings are not news.
    const loaded = Object.keys(store.snapshots);
    const route = store.route;
    // Every chat in a pane counts as seen, not only the selected one.
    const shown = route.name === 'chat' ? [route.sessionId, ...store.shownSessions] : [];
    const isFocused = focused;
    untrack(() => observe(sessions, approvals, loaded, shown, isFocused));
  });

  // Turning the badge on or off, or clearing a chat, changes the number without a new observation.
  $effect(() => {
    void wantedCount();
    untrack(schedule);
  });

  $effect(() => () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  });
</script>
