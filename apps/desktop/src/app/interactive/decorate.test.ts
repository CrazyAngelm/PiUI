import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineBlock } from '../../host-api/types';
import type { IntelligentUiHost } from './renderer.js';

const mocks = vi.hoisted(() => ({ enhance: vi.fn(), dispose: vi.fn(), create: vi.fn(), locale: vi.fn() }));
vi.mock('./load', () => ({ createIntelligentUiScope: mocks.create, setIntelligentUiLocale: mocks.locale }));

const observers: { disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  observers.length = 0;
  mocks.create.mockReturnValue({ enhance: mocks.enhance, dispose: mocks.dispose });
  vi.stubGlobal('MutationObserver', class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor() { observers.push(this); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function block(kind: 'assistant' | 'user'): TimelineBlock { return { id: kind, kind, label: kind, text: 'widget', status: 'complete' }; }
const element = (): HTMLElement => ({ querySelector: vi.fn(() => ({})) }) as unknown as HTMLElement;

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

  it('omits send for read-only views and disposes the observer and mounted scope on abort', async () => {
    const { interactiveDecoration } = await import('./decorate');
    const abort = new AbortController();
    interactiveDecoration({ reply: () => undefined })(element(), block('assistant'), abort.signal);
    await vi.dynamicImportSettled();
    const host = mocks.enhance.mock.calls[0]![1] as IntelligentUiHost;
    expect(host).not.toHaveProperty('send');
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
    const host = mocks.enhance.mock.calls[0]![1] as IntelligentUiHost;
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
      vi.doUnmock('./load');
    }
  });
});
