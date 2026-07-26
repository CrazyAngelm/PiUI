import { describe, expect, it } from 'vitest';
import { host, isHostConflict, toSafeHostError } from './client';

describe('safe host errors', () => {
  it('preserves only the recognized conflict code from structured host failures', () => {
    const error = toSafeHostError('Fake runtime start', {
      code: 'CONFLICT',
      message: 'D:/private/project should never reach the WebView',
    });

    expect(isHostConflict(error)).toBe(true);
    expect(error.message).toContain('project folder changed');
    expect(error.message).not.toContain('D:/private/project');
  });

  it('recognizes a JSON-serialized conflict but keeps unknown host payloads generic', () => {
    expect(isHostConflict(toSafeHostError('Session scan', '{"code":"CONFLICT"}'))).toBe(true);

    const error = toSafeHostError('Session scan', {
      code: 'IO_ERROR',
      message: 'C:/secret/session.jsonl',
    });
    expect(isHostConflict(error)).toBe(false);
    expect(error.message).toBe('Session scan could not be completed. Open diagnostics for a safe error code.');
  });

  it('round-trips only the typed PiUI display preferences in the browser mock', async () => {
    const before = (await host.bootstrap()).preferences;
    const updated = await host.updatePreferences({
      theme: 'light',
      density: 'compact',
      reducedMotion: 'reduce',
      fontSize: 'large',
      chatWidth: 'focused',
    });
    expect(updated).toEqual({
      theme: 'light',
      density: 'compact',
      reducedMotion: 'reduce',
      fontSize: 'large',
      chatWidth: 'focused',
    });
    expect((await host.bootstrap()).preferences).toEqual(updated);
    await host.updatePreferences(before);
  });

  it('keeps the browser mock navigable through the projectless Chats surface', async () => {
    await expect(host.listPersonalSessions()).resolves.toEqual([]);
    await expect(host.startPersonalChat()).rejects.toThrow('live Pi runtime');
  });

  it('toggles only an opaque global extension id in the browser mock', async () => {
    const before = await host.listExtensions();
    const target = before[0];
    expect(target).toBeDefined();
    const updated = await host.setExtensionEnabled(target!.id, !target!.enabled);
    expect(updated.find((extension) => extension.id === target!.id)?.enabled).toBe(!target!.enabled);
    await host.setExtensionEnabled(target!.id, target!.enabled);
  });

});
