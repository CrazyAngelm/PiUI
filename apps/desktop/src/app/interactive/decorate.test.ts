import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineBlock } from '../../host-api/types';
import type { IntelligentUiHost } from './renderer.js';

const mocks = vi.hoisted(() => ({ enhance: vi.fn(), dispose: vi.fn(), refresh: vi.fn(), rebuild: vi.fn(), create: vi.fn(), locale: vi.fn() }));
vi.mock('./load', () => ({ createIntelligentUiScope: mocks.create, setIntelligentUiLocale: mocks.locale }));

const observers: { disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  observers.length = 0;
  mocks.create.mockReturnValue({ enhance: mocks.enhance, dispose: mocks.dispose, refresh: mocks.refresh, rebuild: mocks.rebuild });
  vi.stubGlobal('MutationObserver', class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor() { observers.push(this); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function block(kind: 'assistant' | 'user'): TimelineBlock { return { id: kind, kind, label: kind, text: 'widget', status: 'complete' }; }
const element = (): HTMLElement => ({ querySelector: vi.fn(() => ({})) }) as unknown as HTMLElement;
const lastHost = (): IntelligentUiHost => mocks.enhance.mock.calls[0]![1] as IntelligentUiHost;

describe('lazy interactive message decoration without DOM', () => {
  it('does not mount user messages or messages without widget fences', async () => {
    const { interactiveDecoration } = await import('./decorate');
    const decorate = interactiveDecoration({ reply: () => undefined });
    expect(decorate(element(), block('user'), new AbortController().signal)).toBeUndefined();
    const plain = { querySelector: vi.fn(() => null) } as unknown as HTMLElement;
    const decoration = decorate(plain, block('assistant'), new AbortController().signal);
    await vi.dynamicImportSettled();
    expect(mocks.create).not.toHaveBeenCalled();
    decoration?.dispose();
  });

  it('names a read-only view through sendBlock and disposes the observer and mounted scope on abort', async () => {
    const { interactiveDecoration } = await import('./decorate');
    const abort = new AbortController();
    interactiveDecoration({ reply: () => undefined })(element(), block('assistant'), abort.signal);
    await vi.dynamicImportSettled();
    const host = lastHost();
    expect(host.sendBlock!()).toBe('Sending is not available here');
    expect(await host.send!('Choose A', null)).toBe(false);
    expect(host).not.toHaveProperty('openLink');
    expect(host).not.toHaveProperty('app');
    expect(host).not.toHaveProperty('resolveFile');
    expect(mocks.locale).toHaveBeenCalledWith('en-US');
    abort.abort();
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('composes sends through the current reply operation and reports refusal', async () => {
    const post = vi.fn().mockResolvedValue(true);
    let reply: ((text: string) => Promise<boolean>) | undefined = post;
    const { interactiveDecoration } = await import('./decorate');
    const decoration = interactiveDecoration({ reply: () => reply })(element(), block('assistant'), new AbortController().signal);
    await vi.dynamicImportSettled();
    const host = lastHost();
    expect(await host.send!('Choose A', '{"rows":[1]}')).toBe(true);
    expect(post).toHaveBeenCalledWith('Choose A\n\n```json\n{"rows":[1]}\n```');
    expect(await host.send!('Choose A', '{invalid')).toBe(false);
    reply = undefined;
    expect(await host.send!('Choose A', null)).toBe(false);
    expect(post).toHaveBeenCalledOnce();
    decoration?.dispose();
  });

  it('does not adopt a widget after its message was disposed during the lazy load', async () => {
    const { interactiveDecoration } = await import('./decorate');
    const decoration = interactiveDecoration({ reply: () => undefined })(element(), block('assistant'), new AbortController().signal);
    decoration?.dispose();
    await vi.dynamicImportSettled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('leaves code untouched after an import failure and allows a later update to retry', async () => {
    vi.doMock('./load', () => { throw new Error('lazy chunk unavailable'); });
    const { interactiveDecoration } = await import('./decorate');
    const decoration = interactiveDecoration({ reply: () => undefined })(element(), block('assistant'), new AbortController().signal);
    try {
      await vi.dynamicImportSettled();
      expect(mocks.create).not.toHaveBeenCalled();
      vi.resetModules();
      vi.doMock('./load', () => ({ createIntelligentUiScope: mocks.create, setIntelligentUiLocale: mocks.locale }));
      decoration?.update(block('assistant'));
      await vi.dynamicImportSettled();
      expect(mocks.create).toHaveBeenCalledOnce();
    } finally {
      decoration?.dispose();
      // doUnmock would drop the file-level mock for every later test; put the shared one back.
      vi.doMock('./load', () => ({ createIntelligentUiScope: mocks.create, setIntelligentUiLocale: mocks.locale }));
    }
  });

  it('reads the reason a reply is off live, and refuses to post while it holds', async () => {
    const post = vi.fn().mockResolvedValue(true);
    let reason: 'busy' | 'closed' | 'safe-mode' | 'no-prompt' | undefined;
    const { interactiveDecoration } = await import('./decorate');
    const decoration = interactiveDecoration({ reply: () => post, replyBlock: () => reason })(element(), block('assistant'), new AbortController().signal);
    await vi.dynamicImportSettled();
    const host = lastHost();
    expect(host.sendBlock!()).toBeNull();
    reason = 'busy';
    expect(host.sendBlock!()).toBe('The agent is still answering. Send is available when it finishes.');
    expect(await host.send!('Go', null)).toBe(false);
    reason = 'closed';
    expect(host.sendBlock!()).toBe('This chat is closed.');
    reason = 'safe-mode';
    expect(host.sendBlock!()).toBe('Safe mode is on. Answers cannot send messages.');
    reason = 'no-prompt';
    expect(host.sendBlock!()).toBe('This agent cannot take a new message here.');
    expect(post).not.toHaveBeenCalled();
    reason = undefined;
    expect(await host.send!('Go', null)).toBe(true);
    decoration?.dispose();
  });

  it('tells every mounted answer when the view state changed', async () => {
    const { interactiveDecoration } = await import('./decorate');
    const decorate = interactiveDecoration({ reply: () => undefined });
    // One at a time: two concurrent first imports of the mocked module do not both receive the mock.
    const first = decorate(element(), block('assistant'), new AbortController().signal);
    await vi.dynamicImportSettled();
    const second = decorate(element(), block('assistant'), new AbortController().signal);
    await vi.dynamicImportSettled();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    decorate.refresh();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    first?.dispose();
    decorate.refresh();
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
    second?.dispose();
  });

  it('rebuilds mounted answers, keeping their state, when the language changes', async () => {
    const { interactiveDecoration } = await import('./decorate');
    const { language } = await import('../../features/locale/language');
    const decoration = interactiveDecoration({ reply: () => undefined })(element(), block('assistant'), new AbortController().signal);
    await vi.dynamicImportSettled();
    const before = mocks.enhance.mock.calls.length;
    language.set('ru');
    try {
      expect(mocks.rebuild).toHaveBeenCalledOnce();
      expect(mocks.enhance.mock.calls.length).toBe(before + 1);
      expect(mocks.locale).toHaveBeenLastCalledWith('ru-RU');
    } finally {
      language.set('en');
      decoration?.dispose();
    }
  });

  it('adds the link, application and file operations only where the view provides them', async () => {
    const openLink = vi.fn().mockResolvedValue(true);
    const app = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    const files = { resolve: vi.fn().mockResolvedValue(null), preview: vi.fn() };
    const { interactiveDecoration } = await import('./decorate');
    const decoration = interactiveDecoration({ reply: () => undefined, openLink, app, notify, files })(element(), block('assistant'), new AbortController().signal);
    await vi.dynamicImportSettled();
    const host = lastHost();
    expect(await host.openLink!('https://example.com/')).toBe(true);
    expect(await host.app!('new_chat')).toBe(true);
    expect(await host.app!('connect_telegram')).toBe(false);
    expect(app).toHaveBeenCalledOnce();
    expect(app).toHaveBeenCalledWith('new_chat');
    expect(host.notify).toBe(notify);
    expect(await host.resolveFile!('clip.mp4')).toBeNull();
    expect(files.resolve).toHaveBeenCalledWith('clip.mp4');
    decoration?.dispose();
  });

  it('copies the address when the host cannot open a link, and leaves a declined link alone', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const notify = vi.fn();
    const openLink = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('host')).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { interactiveDecoration } = await import('./decorate');
    const decoration = interactiveDecoration({ reply: () => undefined, openLink, notify })(element(), block('assistant'), new AbortController().signal);
    await vi.dynamicImportSettled();
    const host = lastHost();
    expect(await host.openLink!('https://example.com/a')).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith('https://example.com/a');
    expect(notify).toHaveBeenLastCalledWith('Link copied. Open it in your browser.');
    expect(await host.openLink!('https://example.com/b')).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith('https://example.com/b');
    // Neither the host nor the clipboard worked: the renderer reports the failure itself.
    writeText.mockRejectedValueOnce(new Error('denied'));
    notify.mockClear();
    expect(await host.openLink!('https://example.com/c')).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    // The person answered the host's question (Yes or No): nothing is copied.
    writeText.mockClear();
    expect(await host.openLink!('https://example.com/d')).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    decoration?.dispose();
  });

  it('keeps one blob URL per file and revokes it when the message is disposed', async () => {
    const createObjectURL = vi.fn(() => 'blob:one');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(function URLStub() {}, { createObjectURL, revokeObjectURL }));
    const file = { id: 'f1', blockId: '', name: 'a.png', kind: 'image', mediaType: 'image/png', size: 3, origin: 'written', openable: true, previewable: true, revealable: true };
    const files = { resolve: vi.fn().mockResolvedValue(file), preview: vi.fn().mockResolvedValue({ mediaType: 'image/png', data: 'AQID' }) };
    const { interactiveDecoration } = await import('./decorate');
    const decoration = interactiveDecoration({ reply: () => undefined, files })(element(), block('assistant'), new AbortController().signal);
    await vi.dynamicImportSettled();
    const host = lastHost();
    expect(await host.resolveFile!('a.png')).toBe('blob:one');
    expect(await host.resolveFile!('a.png')).toBe('blob:one');
    expect(files.preview).toHaveBeenCalledOnce();
    decoration?.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:one');
  });
});
