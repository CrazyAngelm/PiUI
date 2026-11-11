import type { SessionStatus } from '../../../../../contracts/workspace-v15';

/**
 * The Nano pet's small sprite atlas (`assets/nano/atlas.small.webp`, 768x936):
 * 8 columns by 9 rows of 96x104 cells. Every row is one state; a row holds
 * that many frames. Copied from the NanoAgent web app's `pets/nano/atlas.small.webp`
 * together with the clip table of its `hermes-pets.js` (frame counts, frame
 * durations, repeats), which is the atlas descriptor: the atlas has no JSON of its own.
 */
export const NANO_PET_ATLAS = { columns: 8, rows: 9, cellWidth: 96, cellHeight: 104 } as const;

export const NANO_PET_STATES = ['idle', 'think', 'work', 'wait', 'done', 'error', 'wave', 'sleep', 'talk'] as const;
export type NanoPetState = (typeof NANO_PET_STATES)[number];

export interface NanoPetClip {
  /** Row of the atlas. */
  readonly row: number;
  /** Frames in the row (from column 0). */
  readonly frames: number;
  /** Milliseconds per frame. */
  readonly ms: number;
  /** Times a one-shot plays before the pet returns to its first frame; absent loops. */
  readonly repeat?: number;
}

export const NANO_PET_CLIPS: Readonly<Record<NanoPetState, NanoPetClip>> = {
  idle: { row: 0, frames: 6, ms: 180 },
  think: { row: 1, frames: 6, ms: 150 },
  work: { row: 2, frames: 6, ms: 120 },
  wait: { row: 3, frames: 6, ms: 150 },
  done: { row: 4, frames: 5, ms: 140, repeat: 2 },
  error: { row: 5, frames: 8, ms: 140, repeat: 1 },
  wave: { row: 6, frames: 4, ms: 140, repeat: 3 },
  sleep: { row: 7, frames: 6, ms: 400 },
  talk: { row: 8, frames: 4, ms: 110 },
};

/** An unknown state is a calm pet. */
export function clipFor(state: string): NanoPetClip {
  return Object.hasOwn(NANO_PET_CLIPS, state) ? NANO_PET_CLIPS[state as NanoPetState] : NANO_PET_CLIPS.idle;
}

/** Atlas row of a state, 0-based. */
export function rowFor(state: string): number {
  return clipFor(state).row;
}

/** The block facts the pet reads; a subset of the desktop timeline block. */
export interface PetBlock {
  readonly kind: string;
  readonly status: string;
}

export interface PetActivity {
  readonly status: SessionStatus;
  /** Pending approval requests of the chat. */
  readonly approvals: number;
  readonly blocks: readonly PetBlock[];
  /** A turn finished a moment ago (the wrapper times this). */
  readonly justFinished: boolean;
}

/**
 * What the pet does: waiting for an approval, thinking before the first token,
 * talking while text streams, working while a tool runs, a short cheer when a
 * turn finishes, a flinch on failure, asleep when the agent process is stopped.
 */
export function petStateFor(activity: PetActivity): NanoPetState {
  if (activity.approvals > 0) return 'wait';
  switch (activity.status) {
    case 'failed':
      return 'error';
    case 'closed':
      return 'sleep';
    case 'starting':
      return 'think';
    case 'running':
    case 'stopping': {
      const live = [...activity.blocks].reverse().find((block) => block.status === 'streaming');
      if (live?.kind === 'assistant') return 'talk';
      if (live?.kind === 'tool') return 'work';
      return 'think';
    }
    case 'idle': {
      const last = activity.blocks.at(-1);
      if (last !== undefined && (last.kind === 'error' || last.status === 'failed')) return 'error';
      return activity.justFinished ? 'done' : 'idle';
    }
    default: {
      const exhaustive: never = activity.status;
      return exhaustive;
    }
  }
}

const ACTIVE: readonly SessionStatus[] = ['starting', 'running', 'stopping'];

/** A turn ended between two statuses: the pet cheers for a moment. */
export function turnFinished(previous: SessionStatus | undefined, next: SessionStatus): boolean {
  return previous !== undefined && ACTIVE.includes(previous) && next === 'idle';
}

/** How long the cheer lasts: the `done` clip plays twice (1.4 s) and a beat. */
export const NANO_PET_DONE_MS = 1_800;

// ---- the "Show Nano avatar" setting ---------------------------------------

/** localStorage key of the setting; only `0` turns the avatar off. */
export const NANO_PET_STORAGE_KEY = 'piui.nano.pet';

export function parsePetEnabled(raw: string | null | undefined): boolean {
  return raw !== '0';
}

type PetStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): PetStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The stored choice; on by default, and a blocked or broken store keeps it on. */
export function readPetEnabled(storage: PetStorage | undefined = defaultStorage()): boolean {
  try {
    return parsePetEnabled(storage?.getItem(NANO_PET_STORAGE_KEY));
  } catch {
    return true;
  }
}

/** Stores the choice; failure only means it is not remembered. */
export function writePetEnabled(enabled: boolean, storage: PetStorage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(NANO_PET_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // An optional preference.
  }
}
