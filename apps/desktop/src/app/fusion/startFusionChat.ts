import { composerRequest } from '../../host-api/composerClient';
import type { ComposerImage } from '../../host-api/composerInputsClient';
import { FusionError, fusionHost, type FusionPairV1, type FusionRefusalV1, type FusionRoleNameV1 } from '../../host-api/fusionClient';
import type { WorkspaceStore } from '../workspaceStore.svelte';
import { fusionMembership } from './fusionMembership.svelte';

/** What starting a Fusion chat needs from the workspace store. */
export type FusionChatHost = Pick<WorkspaceStore, 'loadCatalog' | 'openSession' | 'updateDraft' | 'updateAttachments'>;

export interface FusionStartRequest {
  workspaceId: string;
  pair: FusionPairV1;
  /** The first message for the lead; empty starts the chat without one. */
  text: string;
  images?: readonly ComposerImage[];
}

export type FusionStartResult =
  /** The host refused the pair; nothing was started. */
  | { kind: 'refused'; refusal: FusionRefusalV1; role: FusionRoleNameV1 }
  /** The chat exists and is open. `error` is set when only the first message failed (it stays as the chat draft). */
  | { kind: 'started'; sessionId: string; error?: string };

/**
 * Creates a Fusion chat the way the composer creates an ordinary chat: the
 * host creates the lead session (and its broker), then the typed first
 * message goes to that session through the durable composer outbox and the
 * chat opens. Host errors throw a `FusionError`.
 */
export async function startFusionChat(store: FusionChatHost, request: FusionStartRequest): Promise<FusionStartResult> {
  const created = await fusionHost.request({ type: 'createChat', workspaceId: request.workspaceId, pair: request.pair });
  if (created.type === 'pairCheck') {
    if (created.ok) throw new FusionError('unknown');
    return { kind: 'refused', refusal: created.refusal, role: created.role };
  }
  if (created.type !== 'created') throw new FusionError('unknown');

  const sessionId = created.leadSessionId;
  fusionMembership.remember(sessionId);
  // The chat exists from here on; opening it must not fail the start.
  try {
    await store.loadCatalog(request.workspaceId);
    await store.openSession(sessionId, { navigate: false });
  } catch {
    // The catalog and the sidebar catch up through session events.
  }

  const images = request.images ?? [];
  if (!request.text.trim()) return { kind: 'started', sessionId };
  try {
    await composerRequest({
      type: 'send',
      sessionId,
      requestId: crypto.randomUUID(),
      text: request.text,
      mode: 'prompt',
      ...(images.length ? { attachments: images.map((image) => image.id) } : {}),
    });
  } catch (cause) {
    // Keep the unsent text and images as the chat draft so nothing is lost.
    store.updateDraft(sessionId, request.text);
    store.updateAttachments(sessionId, images);
    return { kind: 'started', sessionId, error: cause instanceof Error ? cause.message : 'The first message could not be sent.' };
  }
  return { kind: 'started', sessionId };
}
