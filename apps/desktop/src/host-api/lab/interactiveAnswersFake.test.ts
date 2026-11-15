import { describe, expect, it } from 'vitest';
import { interactiveAnswersHandlers } from './interactiveAnswersFake';

describe('interactive answers Lab preference', () => {
  it('defaults on and persists changes when the host is recreated', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const handlers = interactiveAnswersHandlers({ safeMode: false }, storage);
    expect(handlers.interactive_answers_settings_v1!({ request: {} })).toEqual({ protocol: 1, enabled: true, readOnly: false });
    expect(handlers.interactive_answers_update_v1!({ request: { enabled: false } })).toEqual({ protocol: 1, enabled: false, readOnly: false });
    expect(interactiveAnswersHandlers({ safeMode: false }, storage).interactive_answers_settings_v1!({ request: {} })).toEqual({ protocol: 1, enabled: false, readOnly: false });
  });
  it('shows safe mode as off and read-only and refuses updates', () => {
    const handlers = interactiveAnswersHandlers({ safeMode: true });
    expect(handlers.interactive_answers_settings_v1!({ request: {} })).toEqual({ protocol: 1, enabled: false, readOnly: true });
    expect(() => handlers.interactive_answers_update_v1!({ request: { enabled: true } })).toThrowError();
  });
  it('rejects unknown fields and keeps its value when persistence fails', () => {
    const handlers = interactiveAnswersHandlers({ safeMode: false }, { getItem: () => null, setItem: () => { throw new Error('io'); } });
    expect(() => handlers.interactive_answers_update_v1!({ request: { enabled: false, extra: true } })).toThrowError();
    expect(() => handlers.interactive_answers_update_v1!({ request: { enabled: false } })).toThrowError();
    expect(handlers.interactive_answers_settings_v1!({ request: {} })).toMatchObject({ enabled: true });
  });
});
