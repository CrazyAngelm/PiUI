import { mount, unmount, tick } from 'svelte';
import { writable } from 'svelte/store';
import NativeConversationFixture from './NativeConversationFixture.svelte';
import { mountConversation } from '../../../packages/nano-ui/src/conversation';
import type { ConversationHandle, ConversationSnapshot } from '../../../contracts/conversation-presentation-v1';
import type { TimelineBlock } from '../src/host-api/types';
import ApprovalCard from '../src/app/shell/ApprovalCard.svelte';
import { WORKSPACE_CONTEXT } from '../src/app/shell/context';
import { fusionMembership } from '../src/app/fusion/fusionMembership.svelte';
import { toasts } from '../src/lib/ui/toast.svelte';
import type { WorkspaceStore } from '../src/app/workspaceStore.svelte';

// Presentation-only synthetic owners, inside the actual Tauri/WebView2. This
// never substitutes the app's native transport or contacts a provider/account.
let root: HTMLDivElement | undefined;
let native: ReturnType<typeof mount> | undefined;
const nativeBlocks = writable<TimelineBlock[]>([]);
let shared: ConversationHandle | undefined;
const identity = { location: 'cloud' as const, scopeId: 'synthetic-account', sessionId: 'synthetic-cloud' };
const calls: { kind: string; id?: string; decision?: string }[] = [];
let view: ConversationSnapshot;

export async function beginConversationProof() {
  root = document.createElement('div');
  root.dataset.conversationProof = 'synthetic';
  root.style.cssText = 'position:fixed;inset:16px;z-index:10000;display:grid;grid-template-columns:1fr 1fr;gap:16px;background:var(--piui-bg);padding:16px';
  const local = document.createElement('div');
  const cloud = document.createElement('div');
  local.dataset.nativeProof = 'true'; cloud.dataset.sharedProof = 'true';
  local.style.minHeight = cloud.style.minHeight = '0';
  root.append(local, cloud); document.body.append(root);
  nativeBlocks.set([
    { id: 'native-user', kind: 'user', text: 'Synthetic native question', status: 'complete' },
    { id: 'native-future', kind: 'unknown', label: 'Future native event', text: 'Native generic fallback', fallback: true, status: 'complete' },
    { id: 'native-answer', kind: 'assistant', text: 'Native streaming', status: 'streaming' },
  ]);
  native = mount(NativeConversationFixture, { target: local, props: { blocks: nativeBlocks } });
  calls.length = 0;
  view = {
    blocks: [{ id: 'user', kind: 'user', text: 'Shared question', status: 'complete' }, { id: 'answer', kind: 'assistant', text: 'Shared streaming', status: 'streaming' }],
    attachments: [{ id: 'opaque-notes', blockId: 'user', label: 'notes.txt' }],
    approvals: [{ id: 'approval', sessionId: identity.sessionId, kind: 'command', title: 'Synthetic approval', description: 'No native command is executed', decisions: ['approve-once', 'deny'] }],
    loading: false, connection: 'connected',
  };
  shared = mountConversation(cloud, { contractVersion: 1, language: 'en', agentLabel: 'Cloud fixture', snapshot: view, owner: {
    identity,
    openAttachment: async id => { calls.push({ kind: 'attachment', id }); },
    respond: async (id, decision) => { calls.push({ kind: 'approval', id, decision }); },
    reconnect: async () => { calls.push({ kind: 'reconnect' }); return { ...view, connection: 'connected', blocks: [{ id: 'recovered', kind: 'assistant', text: 'Recovered owner history', status: 'complete' }], approvals: [], attachments: [] }; },
  } });
  await tick();
  return conversationProofState();
}

export async function streamConversationProof() {
  nativeBlocks.update(blocks => blocks.map(block => block.id === 'native-answer' ? { ...block, text: 'Native streamed answer', status: 'complete' } : block));
  view = { ...view, blocks: view.blocks.map(block => block.id === 'answer' ? { ...block, text: 'Shared streamed answer', status: 'complete' } : block), approvals: [] };
  shared!.update(identity, view);
  await tick();
  return conversationProofState();
}

export async function disconnectConversationProof() {
  view = { ...view, connection: 'disconnected' };
  shared!.update(identity, view);
  await tick();
}

export async function conversationProofState() {
  await tick();
  return { native: root?.querySelector('[data-native-proof]')?.textContent ?? '', shared: root?.querySelector('[data-shared-proof]')?.textContent ?? '', calls: [...calls] };
}

export async function endConversationProof() {
  try { if (shared) await shared.dispose(); if (native) await unmount(native); }
  finally { root?.remove(); root = undefined; native = undefined; shared = undefined; }
  return !document.querySelector('[data-conversation-proof]');
}

export async function proveRetiredNativeApproval() {
  const sessionId = 'synthetic-retired-native-approval';
  const description = 'Synthetic retired response';
  const target = document.createElement('div'); document.body.append(target);
  let settle!: (value: boolean) => void;
  const response = new Promise<boolean>(resolve => { settle = resolve; });
  let called = false;
  const store = { approvalKey: (session: string, request: string) => `${session}:${request}`,
    approvalBusy: '', approvalErrors: { [`${sessionId}:approval`]: description },
    respond: () => { called = true; return response; } } as unknown as WorkspaceStore;
  fusionMembership.remember(sessionId);
  let component: ReturnType<typeof mount> | undefined;
  try {
    component = mount(ApprovalCard, { target, context: new Map([[WORKSPACE_CONTEXT, store]]), props: {
      session: { id: sessionId, workspaceId: 'synthetic', harness: 'codex', title: 'Retired fixture', status: 'running', updatedAt: '2026-11-13T00:00:00Z' },
      approval: { id: 'approval', sessionId, kind: 'command', title: 'Synthetic delayed approval', decisions: ['approve-once', 'deny'] },
    } });
    await tick(); target.querySelector('button')?.click(); await tick();
    if (!called) throw new Error('Native approval owner was not invoked.');
    await unmount(component); component = undefined;
    settle(false); await response; await tick();
    return !toasts.items.some(toast => toast.description === description);
  } finally {
    settle(false); if (component) await unmount(component);
    for (const toast of toasts.items.filter(toast => toast.description === description)) toasts.dismiss(toast.id);
    fusionMembership.forgetLead(sessionId); target.remove();
  }
}
