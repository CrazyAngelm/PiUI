import { SvelteMap } from 'svelte/reactivity';
import { strongerKind, type AttentionKind, type AttentionVerdict } from './attentionRules';
import { SOUND_IDS, type SoundId } from './sounds';

/** Per-device notification settings (ADR-065). */
export interface AttentionSettings {
  sound: boolean;
  soundId: SoundId;
  /** 0..1 */
  volume: number;
  /** The number on the taskbar button. */
  badge: boolean;
  /** Flash the taskbar button while the window is not in front. */
  flash: boolean;
  onFinished: boolean;
  onDecision: boolean;
  onFailed: boolean;
}

export const ATTENTION_STORAGE_KEY = 'piui.attention.v1';

export const DEFAULT_ATTENTION_SETTINGS: Readonly<AttentionSettings> = {
  sound: true,
  soundId: 'chime',
  volume: 0.6,
  badge: true,
  flash: true,
  onFinished: true,
  onDecision: true,
  onFailed: true,
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Settings from stored text: every field is checked on its own, a bad or missing one is its default. */
export function parseAttentionSettings(raw: string | null | undefined): AttentionSettings {
  const defaults = DEFAULT_ATTENTION_SETTINGS;
  let value: unknown;
  try {
    value = raw === null || raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const stored = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const soundId = (SOUND_IDS as readonly unknown[]).includes(stored.soundId) ? (stored.soundId as SoundId) : defaults.soundId;
  const volume = typeof stored.volume === 'number' && Number.isFinite(stored.volume) ? Math.min(Math.max(stored.volume, 0), 1) : defaults.volume;
  return {
    sound: flag(stored.sound, defaults.sound),
    soundId,
    volume,
    badge: flag(stored.badge, defaults.badge),
    flash: flag(stored.flash, defaults.flash),
    onFinished: flag(stored.onFinished, defaults.onFinished),
    onDecision: flag(stored.onDecision, defaults.onDecision),
    onFailed: flag(stored.onFailed, defaults.onFailed),
  };
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Which chats are waiting to be seen, and the notification settings. The
 * controller feeds it verdicts of `evaluateAttention`; the sidebar reads
 * `kind(sessionId)` for a chat's dot.
 */
export class AttentionStore {
  settings = $state<AttentionSettings>({ ...DEFAULT_ATTENTION_SETTINGS });
  /** Chat id -> why it waits. */
  readonly unseen = new SvelteMap<string, AttentionKind>();
  /** Chats on screen now. */
  visible = $state.raw<ReadonlySet<string>>(new Set());
  private storage: StorageLike | undefined;

  constructor(storage: StorageLike | undefined = browserStorage()) {
    this.storage = storage;
    this.settings = parseAttentionSettings(this.read());
  }

  /** Chats waiting to be seen. */
  get count(): number {
    return this.unseen.size;
  }

  /** Why the chat waits, or undefined when it does not. */
  kind(sessionId: string): AttentionKind | undefined {
    return this.unseen.get(sessionId);
  }

  /** The shell says which chats are on screen. */
  setVisible(ids: readonly string[]): void {
    const same = ids.length === this.visible.size && ids.every((id) => this.visible.has(id));
    if (!same) this.visible = new Set(ids);
  }

  /** Whether a reason is switched on in the settings. */
  wants(kind: AttentionKind): boolean {
    switch (kind) {
      case 'finished':
        return this.settings.onFinished;
      case 'decision':
        return this.settings.onDecision;
      case 'failed':
        return this.settings.onFailed;
      default: {
        const never: never = kind;
        return never;
      }
    }
  }

  /**
   * Applies a verdict: clears first, then raises the reasons the settings want.
   * Returns the chats that became newly unseen or got a stronger reason.
   */
  apply(verdict: AttentionVerdict): { sessionId: string; kind: AttentionKind }[] {
    for (const id of verdict.cleared) this.unseen.delete(id);
    const news: { sessionId: string; kind: AttentionKind }[] = [];
    for (const { sessionId, kind } of verdict.raised) {
      if (!this.wants(kind)) continue;
      const known = this.unseen.get(sessionId);
      const next = known === undefined ? kind : strongerKind(known, kind);
      this.unseen.set(sessionId, next);
      news.push({ sessionId, kind: next });
    }
    return news;
  }

  /** Nothing is waiting any more (the person turned every reason off, or tests). */
  clearAll(): void {
    this.unseen.clear();
  }

  update(patch: Partial<AttentionSettings>): void {
    this.settings = parseAttentionSettings(JSON.stringify({ ...this.settings, ...patch }));
    try {
      this.storage?.setItem(ATTENTION_STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // A full or blocked storage keeps the setting for this run only.
    }
  }

  private read(): string | null {
    try {
      return this.storage?.getItem(ATTENTION_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }
}

export const attention = new AttentionStore();
