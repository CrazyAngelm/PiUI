import { describe, expect, it } from 'vitest';
import { ATTENTION_STORAGE_KEY, AttentionStore, DEFAULT_ATTENTION_SETTINGS, parseAttentionSettings } from './attention.svelte';

function memory(initial?: string): { getItem(key: string): string | null; setItem(key: string, value: string): void; value(): string | null } {
  let stored: string | null = initial ?? null;
  return {
    getItem: (key) => (key === ATTENTION_STORAGE_KEY ? stored : null),
    setItem: (key, value) => {
      if (key === ATTENTION_STORAGE_KEY) stored = value;
    },
    value: () => stored,
  };
}

describe('attention settings', () => {
  it('defaults to everything on, the chime at 60%', () => {
    expect(parseAttentionSettings(null)).toEqual({
      sound: true,
      soundId: 'chime',
      volume: 0.6,
      badge: true,
      flash: true,
      onFinished: true,
      onDecision: true,
      onFailed: true,
    });
    expect(new AttentionStore(memory()).settings).toEqual(DEFAULT_ATTENTION_SETTINGS);
  });

  it('reads a stored value and checks every field on its own', () => {
    const settings = parseAttentionSettings(JSON.stringify({ sound: false, soundId: 'bell', volume: 0.25, badge: 'yes', flash: false, onFinished: 1, onFailed: false, extra: true }));
    expect(settings).toEqual({ ...DEFAULT_ATTENTION_SETTINGS, sound: false, soundId: 'bell', volume: 0.25, flash: false, onFailed: false });
  });

  it('falls back to the defaults for broken text, a wrong shape, an unknown sound and a volume out of range', () => {
    expect(parseAttentionSettings('{')).toEqual(DEFAULT_ATTENTION_SETTINGS);
    expect(parseAttentionSettings('[1,2]')).toEqual(DEFAULT_ATTENTION_SETTINGS);
    expect(parseAttentionSettings('"text"')).toEqual(DEFAULT_ATTENTION_SETTINGS);
    expect(parseAttentionSettings(JSON.stringify({ soundId: 'airhorn' })).soundId).toBe('chime');
    expect(parseAttentionSettings(JSON.stringify({ volume: 7 })).volume).toBe(1);
    expect(parseAttentionSettings(JSON.stringify({ volume: -1 })).volume).toBe(0);
    expect(parseAttentionSettings(JSON.stringify({ volume: 'loud' })).volume).toBe(0.6);
  });

  it('persists a change and reads it back in a new store', () => {
    const storage = memory();
    const store = new AttentionStore(storage);
    store.update({ soundId: 'marimba', volume: 0.3, badge: false });
    expect(JSON.parse(storage.value() ?? '{}')).toMatchObject({ soundId: 'marimba', volume: 0.3, badge: false, sound: true });
    expect(new AttentionStore(storage).settings).toEqual(store.settings);
  });

  it('validates an update before it is kept', () => {
    const store = new AttentionStore(memory());
    store.update({ volume: 3, soundId: 'nope' as never });
    expect(store.settings.volume).toBe(1);
    expect(store.settings.soundId).toBe('chime');
  });

  it('works without a storage and when it refuses to write', () => {
    const none = new AttentionStore(undefined);
    expect(none.settings).toEqual(DEFAULT_ATTENTION_SETTINGS);
    const broken = new AttentionStore({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    });
    broken.update({ sound: false });
    expect(broken.settings.sound).toBe(false);
  });
});

describe('attention state', () => {
  const store = (): AttentionStore => new AttentionStore(memory());

  it('counts waiting chats, not events, and reports a chat reason', () => {
    const attention = store();
    expect(attention.count).toBe(0);
    attention.apply({ raised: [{ sessionId: 'a', kind: 'finished' }, { sessionId: 'b', kind: 'failed' }], cleared: [] });
    attention.apply({ raised: [{ sessionId: 'a', kind: 'finished' }], cleared: [] });
    expect(attention.count).toBe(2);
    expect(attention.kind('a')).toBe('finished');
    expect(attention.kind('b')).toBe('failed');
    expect(attention.kind('c')).toBeUndefined();
  });

  it('keeps the stronger reason and never weakens it', () => {
    const attention = store();
    attention.apply({ raised: [{ sessionId: 'a', kind: 'finished' }], cleared: [] });
    attention.apply({ raised: [{ sessionId: 'a', kind: 'decision' }], cleared: [] });
    attention.apply({ raised: [{ sessionId: 'a', kind: 'finished' }], cleared: [] });
    expect(attention.kind('a')).toBe('decision');
    expect(attention.count).toBe(1);
  });

  it('clears before it raises and ignores a clear of an unknown chat', () => {
    const attention = store();
    attention.apply({ raised: [{ sessionId: 'a', kind: 'decision' }], cleared: [] });
    attention.apply({ raised: [{ sessionId: 'a', kind: 'finished' }], cleared: ['a', 'ghost'] });
    expect(attention.kind('a')).toBe('finished');
    expect(attention.count).toBe(1);
  });

  it('returns what became unseen and leaves out the kinds the settings turn off', () => {
    const attention = store();
    attention.update({ onFinished: false });
    const news = attention.apply({ raised: [{ sessionId: 'a', kind: 'finished' }, { sessionId: 'b', kind: 'decision' }], cleared: [] });
    expect(news).toEqual([{ sessionId: 'b', kind: 'decision' }]);
    expect(attention.count).toBe(1);
    expect(attention.wants('finished')).toBe(false);
    expect(attention.wants('failed')).toBe(true);
  });

  it('remembers which chats are on screen and ignores an unchanged list', () => {
    const attention = store();
    attention.setVisible(['a']);
    const first = attention.visible;
    attention.setVisible(['a']);
    expect(attention.visible).toBe(first);
    attention.setVisible([]);
    expect(attention.visible.size).toBe(0);
  });

  it('clears everything', () => {
    const attention = store();
    attention.apply({ raised: [{ sessionId: 'a', kind: 'failed' }], cleared: [] });
    attention.clearAll();
    expect(attention.count).toBe(0);
  });
});
