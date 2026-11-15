import { describe, expect, it, vi } from 'vitest';
import { createInteractiveAnswersClient } from './interactiveAnswersClient';

describe('interactive answers host contract v1', () => {
  it('uses the typed settings and update routes', async () => {
    const settings = { protocol: 1, enabled: true, readOnly: false };
    const invoke = vi.fn().mockResolvedValue(settings);
    const client = createInteractiveAnswersClient(invoke);
    expect(await client.settings()).toEqual(settings);
    expect(invoke).toHaveBeenLastCalledWith('interactive_answers_settings_v1', { request: {} });
    expect(await client.update({ enabled: false })).toEqual(settings);
    expect(invoke).toHaveBeenLastCalledWith('interactive_answers_update_v1', { request: { enabled: false } });
  });
  it.each([null, {}, { protocol: 2, enabled: true, readOnly: false }, { protocol: 1, enabled: 'true', readOnly: false }, { protocol: 1, enabled: true }])('rejects a malformed answer: %s', async answer => {
    const client = createInteractiveAnswersClient(vi.fn().mockResolvedValue(answer));
    await expect(client.settings()).rejects.toMatchObject({ code: 'io' });
    await expect(client.update({ enabled: true })).rejects.toMatchObject({ code: 'io' });
  });
  it.each([{ code: 'read-only' }, '{"code":"read-only","detail":"private"}'])('maps read-only failures without exposing host text', async cause => {
    const client = createInteractiveAnswersClient(vi.fn().mockRejectedValue(cause));
    await expect(client.update({ enabled: true })).rejects.toMatchObject({ code: 'read-only', message: 'Runtime actions are disabled in safe mode.' });
  });
  it('maps unknown host failures to fixed copy', async () => {
    const client = createInteractiveAnswersClient(vi.fn().mockRejectedValue(new Error('private host details')));
    await expect(client.settings()).rejects.toMatchObject({ code: 'io', message: 'The setting could not be saved. Nothing was changed.' });
  });
});
