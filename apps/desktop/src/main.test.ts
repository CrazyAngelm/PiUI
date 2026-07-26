import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mount: vi.fn(),
}));

vi.mock('svelte', () => ({ mount: mocks.mount }));
vi.mock('./app/App.svelte', () => ({ default: 'PiUIApp' }));
vi.mock('./styles/reset.css', () => ({}));
vi.mock('./styles/tokens.css', () => ({}));
vi.mock('./styles/app.css', () => ({}));

afterEach(() => {
  mocks.mount.mockReset();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('desktop entrypoint', () => {
  it('mounts the Svelte 5 root instead of constructing it', async () => {
    const target = {} as HTMLElement;
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => target),
    });

    await import('./main');

    expect(mocks.mount).toHaveBeenCalledOnce();
    expect(mocks.mount).toHaveBeenCalledWith('PiUIApp', { target });
  });

  it('fails safely when the root element is missing', async () => {
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => null),
    });

    await expect(import('./main')).rejects.toThrow('PiUI could not find the application root.');
  });
});
