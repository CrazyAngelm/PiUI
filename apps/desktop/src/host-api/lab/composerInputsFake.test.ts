import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ComposerAttachmentsResult,
  ComposerCatalogResult,
  ComposerFilesResult,
  ComposerInputsResult,
  ComposerPreviewResult,
  ComposerSnapshot,
  WorkspaceResult,
} from './labContracts';
import type { LabHost } from './labHost';
import { LAB_SCREENSHOT_PNG, labHoldsImage, labPendingImage } from './composerInputsFake';
import { DEMO_PROJECTS } from './scenarios/demoChats';
import { labUuid } from './labRandom';
import { labHost, rejection, snapshotOf } from './labTestKit';

function inputs<T extends ComposerInputsResult>(host: LabHost, command: Record<string, unknown>): Promise<T> {
  return host.invoke<T>('workspace_composer_inputs_v1', { command });
}

function sessionId(host: LabHost, title: string): string {
  const session = [...host.state.sessions.values()].find((candidate) => candidate.title === title);
  if (session === undefined) throw new Error(`No session ${title}`);
  return session.id;
}

async function openChat(host: LabHost, title: string): Promise<string> {
  const id = sessionId(host, title);
  const result = await host.invoke<WorkspaceResult>('workspace_command_v15', { command: { type: 'openSession', sessionId: id } });
  expect(result.type).toBe('session');
  return id;
}

const code = async (promise: Promise<unknown>): Promise<unknown> => ((await rejection(promise)) as { code?: unknown }).code;
const TEXT = btoa('plain text, not an image');

describe('UI Lab composer inputs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('picks a screenshot and a project file reference, previews and discards the image', async () => {
    const host = labHost();
    const picked = await inputs<ComposerAttachmentsResult>(host, { type: 'pick', workspaceId: DEMO_PROJECTS.piui });
    expect(picked.images).toEqual([{ id: expect.any(String), name: 'lab-screenshot.png', mimeType: 'image/png', size: 156 }]);
    expect(picked.files).toEqual([{ name: 'lab-spec.pdf', reference: '@docs/lab-spec.pdf', inProject: true }]);
    const [image] = picked.images;
    const preview = await inputs<ComposerPreviewResult>(host, { type: 'preview', attachmentId: image?.id });
    expect(preview).toEqual({ type: 'preview', protocol: 1, attachmentId: image?.id, mimeType: 'image/png', data: LAB_SCREENSHOT_PNG });
    await inputs(host, { type: 'discard', attachmentIds: [image?.id] });
    expect(await code(inputs(host, { type: 'preview', attachmentId: image?.id }))).toBe('ATTACHMENT_UNAVAILABLE');
  });

  it('accepts only sniffed, bounded pasted images for trusted projects', async () => {
    const host = labHost();
    const paste = (data: string, workspaceId: string = DEMO_PROJECTS.piui) =>
      inputs<ComposerAttachmentsResult>(host, { type: 'paste', workspaceId, name: 'C:\\clip\\image.png', data });
    const pasted = await paste(LAB_SCREENSHOT_PNG);
    expect(pasted.images[0]?.name).toBe('image.png');
    expect((await paste(TEXT)).rejected).toEqual([{ name: 'image.png', reason: 'not-an-image' }]);
    expect((await paste('A'.repeat(6_666_672))).rejected).toEqual([{ name: 'image.png', reason: 'too-large' }]);
    expect(await code(paste('not base64!'))).toBe('INVALID_ARGUMENT');
    expect(await code(paste(LAB_SCREENSHOT_PNG, DEMO_PROJECTS.legacy))).toBe('NOT_TRUSTED');
    // Missing fields fail argument decoding, like a Tauri command.
    expect(String(await rejection(inputs(host, { type: 'paste', workspaceId: DEMO_PROJECTS.piui, name: 'x.png' })))).toMatch(/data/);
  });

  it('lists names of a trusted project only, narrowed by a subsequence query', async () => {
    const host = labHost();
    const all = await inputs<ComposerFilesResult>(host, { type: 'files', workspaceId: DEMO_PROJECTS.piui, query: '' });
    expect(all.files).toContain('src/app/chat/ChatComposer.svelte');
    expect(all.truncated).toBe(false);
    const narrowed = await inputs<ComposerFilesResult>(host, { type: 'files', workspaceId: DEMO_PROJECTS.piui, query: '@chat/composer' });
    expect(narrowed.files).toEqual(['src/app/chat/ChatComposer.svelte']);
    expect(await code(inputs(host, { type: 'files', workspaceId: DEMO_PROJECTS.legacy, query: '' }))).toBe('NOT_TRUSTED');
    expect(await code(inputs(host, { type: 'files', workspaceId: DEMO_PROJECTS.piui, query: 'x'.repeat(300) }))).toBe('INVALID_ARGUMENT');
    // The browser lab never observes OS drops.
    expect(await code(inputs(host, { type: 'drop', workspaceId: DEMO_PROJECTS.piui, dropId: labUuid('drop') }))).toBe('DROP_EXPIRED');
  });

  it('reports each harness catalog for live sessions only', async () => {
    const host = labHost();
    const codex = await openChat(host, 'Route host calls through one transport');
    const catalog = await inputs<ComposerCatalogResult>(host, { type: 'catalog', sessionId: codex });
    expect(catalog.commands).toEqual([]);
    expect(catalog.skills.map((skill) => skill.mention)).toEqual(['$test-runner']);
    const claude = await openChat(host, 'Map pipeline editor shortcuts');
    const claudeCatalog = await inputs<ComposerCatalogResult>(host, { type: 'catalog', sessionId: claude });
    expect(claudeCatalog.commands.map((command) => command.name)).toContain('review');
    expect(claudeCatalog.skills).toEqual([]);
    expect(await code(inputs(host, { type: 'catalog', sessionId: sessionId(host, 'Audit legacy auth module') }))).toBe('NOT_TRUSTED');
  });

  it('delivers a queued image once, lists it in the user block and releases it', async () => {
    const host = labHost();
    const id = await openChat(host, 'Route host calls through one transport');
    const picked = await inputs<ComposerAttachmentsResult>(host, { type: 'pick', workspaceId: DEMO_PROJECTS.piui });
    const image = picked.images[0];
    if (!image) throw new Error('No image');
    const requestId = labUuid('test:image-send');
    const queued = await host.invoke<ComposerSnapshot>('workspace_composer_v19', {
      command: { type: 'send', sessionId: id, requestId, text: 'What is wrong here?', mode: 'prompt', attachments: [image.id] },
    });
    expect(queued.capabilities.images).toBe(true);
    expect(queued.queue.items[0]?.attachments).toEqual([image]);
    expect(labPendingImage(host.state, image.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5);
    const running = await snapshotOf(host, id);
    expect(running.blocks.some((block) => block.kind === 'user' && block.text === 'What is wrong here?\n\n[image]')).toBe(true);
    expect(labHoldsImage(host.state, image.id)).toBe(false);
    // A retried request id is not sent twice and claims nothing.
    await host.invoke('workspace_composer_v19', {
      command: { type: 'send', sessionId: id, requestId, text: 'What is wrong here?', mode: 'prompt', attachments: [image.id] },
    });
  });

  it('refuses images a session cannot take and unknown image ids before queueing', async () => {
    const host = labHost();
    const prime = await openChat(host, 'Streaming markdown renderer spike');
    const picked = await inputs<ComposerAttachmentsResult>(host, { type: 'pick', workspaceId: DEMO_PROJECTS.piui });
    const image = picked.images[0];
    const send = (session: string, attachments: string[]) => host.invoke<ComposerSnapshot>('workspace_composer_v19', {
      command: { type: 'send', sessionId: session, requestId: labUuid(`test:${attachments.join()}`), text: 'look', mode: 'prompt', attachments },
    });
    expect(await code(send(prime, [image?.id ?? '']))).toBe('IMAGES_UNSUPPORTED');
    expect(labPendingImage(host.state, image?.id ?? '')).toEqual(image);
    const codex = await openChat(host, 'Route host calls through one transport');
    expect(await code(send(codex, [labUuid('never-attached')]))).toBe('ATTACHMENT_UNAVAILABLE');
    expect(await code(send(codex, Array.from({ length: 7 }, (_, index) => labUuid(`many:${index}`))))).toBe('INVALID_ARGUMENT');
  });

  it('refuses every composer input in safe mode', async () => {
    const host = labHost('safe');
    expect(await code(inputs(host, { type: 'files', workspaceId: DEMO_PROJECTS.piui, query: '' }))).toBe('SAFE_MODE');
    expect(await code(inputs(host, { type: 'pick', workspaceId: DEMO_PROJECTS.piui }))).toBe('SAFE_MODE');
  });
});
