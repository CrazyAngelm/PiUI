import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { pluginsRegistryFixture } from '../../../../contracts/fixtures/plugins-v1';
import { createPluginsClient, pluginsError, PluginsError } from './pluginsClient';

vi.mock('./transport', () => ({ hostInvoke: vi.fn(), hostListen: vi.fn(), desktopAvailable: true }));

describe('plugins v1 contract', () => {
  it('matches the shared Rust golden JSON with compile-time checked fields', () => {
    const data: unknown = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/plugins-v1.json', import.meta.url), 'utf8'));
    expect(pluginsRegistryFixture).toEqual(data);
  });

  it('carries metadata only: no path of a backend, environment value, credential or plugin output', () => {
    const forbidden = new Set(['env', 'environment', 'apiKey', 'token', 'credentials', 'auth', 'output', 'stderr', 'stdout', 'root', 'path']);
    function check(value: unknown): void {
      if (Array.isArray(value)) {
        for (const item of value) check(item);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          expect(forbidden.has(key), key).toBe(false);
          check(item);
        }
      }
    }
    check(pluginsRegistryFixture);
  });
});

describe('plugins v1 client', () => {
  it('uses the versioned routes and returns registry, command results and templates', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'plugins_v1') return { registry: pluginsRegistryFixture, review: null };
      if (command === 'plugin_command_v1') return { protocol: 1, text: 'Prepared', notice: 'Done', extra: 'dropped' };
      return { protocol: 1, text: '{"format":"piui-system"}' };
    });
    const client = createPluginsClient(invoke as never, vi.fn() as never);
    expect(await client.run({ type: 'list' })).toEqual({ registry: pluginsRegistryFixture, review: null });
    expect(invoke).toHaveBeenLastCalledWith('plugins_v1', { command: { type: 'list' } });

    // The WebView never sends a path: `pick` names only the kind of source.
    await client.run({ type: 'pick', source: 'zip' });
    expect(invoke).toHaveBeenLastCalledWith('plugins_v1', { command: { type: 'pick', source: 'zip' } });

    const request = { pluginId: 'example.hello', commandId: 'say-hello', origin: 'palette' as const };
    expect(await client.runCommand(request)).toEqual({ protocol: 1, text: 'Prepared', notice: 'Done' });
    expect(invoke).toHaveBeenLastCalledWith('plugin_command_v1', { request });

    expect(await client.template({ pluginId: 'example.pack', templateId: 'review' })).toBe('{"format":"piui-system"}');
    expect(invoke).toHaveBeenLastCalledWith('plugin_template_v1', { request: { pluginId: 'example.pack', templateId: 'review' } });
  });

  it('keeps host codes, fixed messages, problems and a bounded detail; hides anything else', async () => {
    const problem = { code: 'field', message: '“{0}” is required.', subject: 'greeting' };
    const failed = createPluginsClient((async () => {
      throw { code: 'INVALID_SETTINGS', message: 'These settings are not valid.', recoverable: true, problems: [problem, { code: 'x', message: 'bad\nline' }] };
    }) as never, vi.fn() as never);
    await expect(failed.run({ type: 'list' })).rejects.toMatchObject({ code: 'INVALID_SETTINGS', message: 'These settings are not valid.', problems: [problem] });

    const backend = pluginsError({ code: 'BACKEND_FAILED', message: 'The plugin reported an error.', detail: `line\none${'x'.repeat(3000)}` });
    expect(backend.detail?.startsWith('line one')).toBe(true);
    expect(backend.detail?.length).toBe(2048);

    for (const cause of [{ code: 'EXPLODED', message: 'stack trace' }, 'Command plugins_v1 not found', undefined, null]) {
      const mapped = pluginsError(cause);
      expect(mapped).toBeInstanceOf(PluginsError);
      expect(mapped.code).toBe('UNAVAILABLE');
      expect(mapped.message).toBe('PiUI could not read the plugin list.');
    }
    // A known code with native text keeps the code but never the text.
    expect(pluginsError({ code: 'CONFLICT', message: 'line\nbreak' })).toMatchObject({ code: 'CONFLICT', message: 'PiUI could not read the plugin list.' });

    const invalid = createPluginsClient((async () => ({ registry: { protocol: 2 } })) as never, vi.fn() as never);
    await expect(invalid.run({ type: 'list' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const noText = createPluginsClient((async () => ({ protocol: 1 })) as never, vi.fn() as never);
    await expect(noText.template({ pluginId: 'a.b', templateId: 'c' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(noText.runCommand({ pluginId: 'a.b', commandId: 'c', origin: 'composer' })).resolves.toEqual({ protocol: 1 });
  });

  it('forwards only well-formed change events', async () => {
    let deliver: ((payload: unknown) => void) | undefined;
    const listen = vi.fn(async (_channel: string, handler: (payload: unknown) => void) => {
      deliver = handler;
      return () => undefined;
    });
    const client = createPluginsClient(vi.fn() as never, listen as never);
    const changes: unknown[] = [];
    await client.listen((change) => changes.push(change));
    expect(listen).toHaveBeenCalledWith('piui://plugins-v1', expect.any(Function));
    deliver?.({ protocol: 1, revision: 3 });
    deliver?.({ protocol: 2, revision: 4 });
    deliver?.({ protocol: 1, revision: 1.5 });
    deliver?.('noise');
    expect(changes).toEqual([{ protocol: 1, revision: 3 }]);
  });
});
