import type { SessionStatus } from '../../../../../contracts/workspace-v15';

export type NanoPetState = Exclude<import('../../../../../contracts/nano-avatars-v1').NanoAvatarClipIdV1, 'still'>;

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
