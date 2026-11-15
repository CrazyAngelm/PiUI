import { describe, expect, it } from 'vitest';
import { nanoRemoteViewerSocketPath } from '../../../../contracts/nano-remote-v1';
import type { ClosedReason, ConnectionState } from './connection';
import { GATE_WORDS, gateText, groupCode, retryText, spokenCode } from './gateCopy';
import { viewForState, type GateView } from './gateView';
import { RETRY_SECONDS, createAttemptCounter, parseLaunch, retryDelay, viewerSocketUrl, type AttemptStorage } from './launch';

describe('parseLaunch', () => {
  it('reads the device, language and theme from the fragment', () => {
    expect(parseLaunch('#device=dev_abc123&lang=en&theme=dark')).toEqual({ device: 'dev_abc123', language: 'en', theme: 'dark' });
    expect(parseLaunch('device=dev_abc123&theme=light')).toEqual({ device: 'dev_abc123', language: 'ru', theme: 'light' });
  });

  it('defaults to Russian and the system theme, and ignores unknown values', () => {
    expect(parseLaunch('#device=dev_abc123')).toEqual({ device: 'dev_abc123', language: 'ru', theme: 'system' });
    expect(parseLaunch('#device=dev_abc123&lang=fr&theme=sepia')).toEqual({ device: 'dev_abc123', language: 'ru', theme: 'system' });
  });

  it('refuses a missing or malformed device id', () => {
    expect(parseLaunch('')).toBeUndefined();
    expect(parseLaunch('#lang=en')).toBeUndefined();
    expect(parseLaunch('#device=abc')).toBeUndefined();
    expect(parseLaunch('#device=dev_')).toBeUndefined();
    expect(parseLaunch('#device=dev_a/b')).toBeUndefined();
    expect(parseLaunch('#device=dev_a b')).toBeUndefined();
    expect(parseLaunch('#device=dev_..%2F..')).toBeUndefined();
    expect(parseLaunch(`#device=dev_${'a'.repeat(37)}`)).toBeUndefined();
    expect(parseLaunch(`#device=dev_${'a'.repeat(36)}`)?.device).toBe(`dev_${'a'.repeat(36)}`);
  });
});

describe('viewerSocketUrl', () => {
  it('stays on the page origin and the contract path', () => {
    expect(viewerSocketUrl({ protocol: 'https:', host: 'nano.example' }, 'dev_abc')).toBe('wss://nano.example/api/hermes/remote/devices/dev_abc/socket');
    expect(viewerSocketUrl({ protocol: 'http:', host: '127.0.0.1:8787' }, 'dev_abc')).toBe('ws://127.0.0.1:8787/api/hermes/remote/devices/dev_abc/socket');
    expect(viewerSocketUrl({ protocol: 'https:', host: 'nano.example' }, 'dev_abc')).toContain(nanoRemoteViewerSocketPath('dev_abc'));
  });
});

describe('retry schedule', () => {
  it('reloads after 2, 5, 15 and 30 seconds for losses, then waits for the person', () => {
    expect(RETRY_SECONDS).toEqual([2, 5, 15, 30]);
    for (const reason of ['restart', 'network', 'device-offline', 'idle'] as const) {
      expect([0, 1, 2, 3, 4].map((attempt) => retryDelay(reason, attempt))).toEqual([2, 5, 15, 30, undefined]);
    }
  });

  it('never retries what needs a decision', () => {
    for (const reason of ['kicked', 'disabled', 'signed-out', 'quit', 'denied', 'protocol', 'unauthorized', 'limited', 'too-big', 'local'] as const) {
      expect(retryDelay(reason, 0)).toBeUndefined();
    }
  });

  it('counts attempts in the tab storage and survives a broken storage', () => {
    const data = new Map<string, string>();
    const storage: AttemptStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
    const counter = createAttemptCounter(storage);
    expect(counter.read()).toBe(0);
    counter.increment();
    counter.increment();
    expect(counter.read()).toBe(2);
    counter.reset();
    expect(counter.read()).toBe(0);

    const broken: AttemptStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    const safe = createAttemptCounter(broken);
    safe.increment();
    safe.reset();
    expect(safe.read()).toBe(0);
    expect(createAttemptCounter(undefined).read()).toBe(0);
  });
});

describe('gate views', () => {
  const welcome = {
    k: 'welcome',
    proto: 1,
    device: { id: 'dev_a', name: 'PC' },
    app: { version: '0.3.1' },
    grant: 'once',
    shell: { workspace: 15, composer: 19, settings: 16, history: 1, models: 19 },
    commands: [],
    channels: [],
  } as const;

  it('maps every connection state', () => {
    expect(viewForState({ kind: 'connecting' })).toEqual({ kind: 'connecting' });
    expect(viewForState({ kind: 'approval', code: '908621', deviceName: 'PC', expiresIn: 120 })).toEqual({ kind: 'approval', code: '908621', deviceName: 'PC' });
    expect(viewForState({ kind: 'denied', reason: 'busy' })).toEqual({ kind: 'denied', reason: 'busy' });
    expect(viewForState({ kind: 'welcomed', welcome })).toBeUndefined();
    expect(viewForState({ kind: 'closed', reason: 'local' })).toBeUndefined();
    expect(viewForState({ kind: 'closed', reason: 'denied' })).toEqual({ kind: 'denied', reason: 'denied' });
    expect(viewForState({ kind: 'closed', reason: 'device-offline' })).toEqual({ kind: 'offline' });
    expect(viewForState({ kind: 'closed', reason: 'kicked' })).toEqual({ kind: 'disconnected', reason: 'kicked' });
  });

  const reasons: ClosedReason[] = ['kicked', 'disabled', 'signed-out', 'quit', 'denied', 'protocol', 'unauthorized', 'device-offline', 'idle', 'replaced', 'limited', 'too-big', 'restart', 'network'];

  it('has a title in both languages for every view', () => {
    const views: GateView[] = [
      { kind: 'connecting' },
      { kind: 'approval', code: '908621', deviceName: 'PC' },
      { kind: 'denied', reason: 'denied' },
      { kind: 'denied', reason: 'timeout' },
      { kind: 'denied', reason: 'busy' },
      { kind: 'offline' },
      { kind: 'versions' },
      { kind: 'unsupported' },
      ...reasons.map((reason) => viewForState({ kind: 'closed', reason } as ConnectionState)).filter((view): view is GateView => view !== undefined),
    ];
    for (const view of views) {
      for (const language of ['en', 'ru'] as const) {
        const text = gateText(view, language);
        expect(text.title.length).toBeGreaterThan(0);
        expect(text.detail === undefined || text.detail.length > 0).toBe(true);
      }
    }
  });

  it('keeps both languages complete and the Russian copy on the product name', () => {
    expect(Object.keys(GATE_WORDS.ru).sort()).toEqual(Object.keys(GATE_WORDS.en).sort());
    for (const words of Object.values(GATE_WORDS)) for (const value of Object.values(words)) expect(value).not.toMatch(/Гермес|Hermes/);
    expect(gateText({ kind: 'approval', code: '908621', deviceName: 'PC' }, 'ru').title).toBe('Подтвердите подключение на компьютере');
    expect(gateText({ kind: 'offline' }, 'ru').title).toBe('Компьютер не в сети');
    expect(gateText({ kind: 'denied', reason: 'denied' }, 'ru').title).toBe('Подключение отклонено');
    expect(gateText({ kind: 'disconnected', reason: 'disabled' }, 'ru').title).toBe('Доступ отключён на компьютере');
    expect(GATE_WORDS.ru.reconnect).toBe('Переподключиться');
    expect(GATE_WORDS.ru.code).toBe('Код');
  });

  it('offers Reconnect where the person can act and not while waiting', () => {
    expect(gateText({ kind: 'connecting' }, 'en').reconnect).toBe(false);
    expect(gateText({ kind: 'approval', code: '908621', deviceName: 'PC' }, 'en').reconnect).toBe(false);
    expect(gateText({ kind: 'versions' }, 'en').reconnect).toBe(true);
    expect(gateText({ kind: 'offline' }, 'en').reconnect).toBe(true);
  });

  it('groups and speaks the code, and words the countdown', () => {
    expect(groupCode('908621')).toBe('908 621');
    expect(groupCode('12')).toBe('12');
    expect(spokenCode('908621')).toBe('9 0 8 6 2 1');
    expect(retryText(5, 'en')).toBe('Reconnecting in 5 s…');
    expect(retryText(5, 'ru')).toBe('Переподключение через 5 с…');
  });
});
