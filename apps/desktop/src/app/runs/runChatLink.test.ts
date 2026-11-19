import { describe, expect, it } from 'vitest';
import { MAX_RUN_CHAT_LINKS, chatOfRun, claimContinuation, releaseContinuation, rememberRunChat, rememberedRunChat } from './runChatLink';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}
const always = () => true;

describe('the chat of a run', () => {
  it('remembers the chat created for a run, per project', () => {
    const storage = memory();
    rememberRunChat('ws', 'run-1', 'chat-1', storage);
    expect(rememberedRunChat('ws', 'run-1', storage)).toBe('chat-1');
    expect(rememberedRunChat('other', 'run-1', storage)).toBeUndefined();
    rememberRunChat('ws', 'run-1', 'chat-2', storage);
    expect(rememberedRunChat('ws', 'run-1', storage)).toBe('chat-2');
  });

  it('keeps only the newest pairs', () => {
    const storage = memory();
    for (let index = 0; index < MAX_RUN_CHAT_LINKS + 5; index += 1) rememberRunChat('ws', `run-${index}`, `chat-${index}`, storage);
    expect(rememberedRunChat('ws', 'run-0', storage)).toBeUndefined();
    expect(rememberedRunChat('ws', `run-${MAX_RUN_CHAT_LINKS + 4}`, storage)).toBe(`chat-${MAX_RUN_CHAT_LINKS + 4}`);
  });

  it('treats unreadable or malformed storage as no link', () => {
    expect(rememberedRunChat('ws', 'run-1', memory({ 'piui.run.chat.v1': '{not json' }))).toBeUndefined();
    expect(rememberedRunChat('ws', 'run-1', memory({ 'piui.run.chat.v1': '[1]' }))).toBeUndefined();
    expect(rememberedRunChat('ws', 'run-1', memory({ 'piui.run.chat.v1': JSON.stringify({ 'ws:run-1': 5 }) }))).toBeUndefined();
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => rememberRunChat('ws', 'run-1', 'chat-1', refusing)).not.toThrow();
  });

  it('prefers the chat that started the run, then the remembered one, and only if the chat still exists', () => {
    const storage = memory();
    rememberRunChat('ws', 'run-1', 'remembered', storage);
    const started = { id: 'run-1', trigger: { kind: 'chat' as const, sessionId: 'starter' } };
    expect(chatOfRun('ws', started, always, storage)).toBe('starter');
    expect(chatOfRun('ws', started, (id) => id !== 'starter', storage)).toBe('remembered');
    expect(chatOfRun('ws', started, () => false, storage)).toBeUndefined();
    expect(chatOfRun('ws', { id: 'run-1' }, always, storage)).toBe('remembered');
    expect(chatOfRun('ws', { id: 'run-2', trigger: { kind: 'chat' as const } }, always, storage)).toBeUndefined();
  });
});

describe('claiming a run to continue', () => {
  it('lets one continuation per run proceed until it is released', () => {
    expect(claimContinuation('ws', 'run-1')).toBe(true);
    expect(claimContinuation('ws', 'run-1')).toBe(false);
    // Another run, and the same run id in another project, are separate.
    expect(claimContinuation('ws', 'run-2')).toBe(true);
    expect(claimContinuation('other', 'run-1')).toBe(true);
    releaseContinuation('ws', 'run-1');
    expect(claimContinuation('ws', 'run-1')).toBe(true);
    for (const [project, run] of [['ws', 'run-1'], ['ws', 'run-2'], ['other', 'run-1']] as const) releaseContinuation(project, run);
  });
});
