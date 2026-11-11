import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import NanoPet from './NanoPet.svelte';
import {
  NANO_PET_ATLAS,
  NANO_PET_CLIPS,
  NANO_PET_STATES,
  NANO_PET_STORAGE_KEY,
  clipFor,
  parsePetEnabled,
  petStateFor,
  readPetEnabled,
  rowFor,
  turnFinished,
  writePetEnabled,
  type PetActivity,
} from './nanoPet';

const quiet: PetActivity = { status: 'idle', approvals: 0, blocks: [], justFinished: false };

describe('Nano pet atlas', () => {
  it('has one row per state and fits the 8 by 9 atlas', () => {
    expect(NANO_PET_STATES.map(rowFor)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(NANO_PET_ATLAS).toEqual({ columns: 8, rows: 9, cellWidth: 96, cellHeight: 104 });
    for (const state of NANO_PET_STATES) {
      const clip = NANO_PET_CLIPS[state];
      expect(clip.row, state).toBeLessThan(NANO_PET_ATLAS.rows);
      expect(clip.frames, state).toBeGreaterThanOrEqual(1);
      expect(clip.frames, state).toBeLessThanOrEqual(NANO_PET_ATLAS.columns);
      expect(clip.ms, state).toBeGreaterThan(0);
    }
  });

  it('uses the frame counts of the NanoAgent clips', () => {
    expect(Object.fromEntries(NANO_PET_STATES.map((state) => [state, NANO_PET_CLIPS[state].frames]))).toEqual({
      idle: 6, think: 6, work: 6, wait: 6, done: 5, error: 8, wave: 4, sleep: 6, talk: 4,
    });
    expect([NANO_PET_CLIPS.done.repeat, NANO_PET_CLIPS.error.repeat, NANO_PET_CLIPS.wave.repeat]).toEqual([2, 1, 3]);
    expect(NANO_PET_CLIPS.idle.repeat).toBeUndefined();
  });

  it('treats an unknown or inherited state name as rest', () => {
    expect(clipFor('dancing')).toBe(NANO_PET_CLIPS.idle);
    expect(clipFor('constructor')).toBe(NANO_PET_CLIPS.idle);
    expect(clipFor('__proto__')).toBe(NANO_PET_CLIPS.idle);
    expect(rowFor('talk')).toBe(8);
  });
});

describe('Nano pet activity mapping', () => {
  it('rests while the chat is idle', () => {
    expect(petStateFor(quiet)).toBe('idle');
    expect(petStateFor({ ...quiet, blocks: [{ kind: 'assistant', status: 'complete' }] })).toBe('idle');
  });

  it('thinks before the first token and while the model reasons', () => {
    expect(petStateFor({ ...quiet, status: 'starting' })).toBe('think');
    expect(petStateFor({ ...quiet, status: 'running', blocks: [{ kind: 'user', status: 'complete' }] })).toBe('think');
    expect(petStateFor({ ...quiet, status: 'running', blocks: [{ kind: 'thinking', status: 'streaming' }] })).toBe('think');
  });

  it('talks while text streams and works while a tool runs', () => {
    expect(petStateFor({ ...quiet, status: 'running', blocks: [{ kind: 'assistant', status: 'streaming' }] })).toBe('talk');
    expect(petStateFor({ ...quiet, status: 'running', blocks: [{ kind: 'assistant', status: 'complete' }, { kind: 'tool', status: 'streaming' }] })).toBe('work');
    expect(petStateFor({ ...quiet, status: 'stopping', blocks: [{ kind: 'tool', status: 'streaming' }] })).toBe('work');
    // The newest streaming block decides.
    expect(petStateFor({ ...quiet, status: 'running', blocks: [{ kind: 'tool', status: 'streaming' }, { kind: 'assistant', status: 'streaming' }] })).toBe('talk');
  });

  it('waits for an approval above everything else', () => {
    for (const status of ['idle', 'running', 'failed', 'closed'] as const) {
      expect(petStateFor({ ...quiet, status, approvals: 1 }), status).toBe('wait');
    }
  });

  it('flinches on failure and sleeps when the process is stopped', () => {
    expect(petStateFor({ ...quiet, status: 'failed' })).toBe('error');
    expect(petStateFor({ ...quiet, blocks: [{ kind: 'error', status: 'complete' }] })).toBe('error');
    expect(petStateFor({ ...quiet, blocks: [{ kind: 'assistant', status: 'failed' }] })).toBe('error');
    expect(petStateFor({ ...quiet, status: 'closed' })).toBe('sleep');
  });

  it('cheers only right after a turn finished', () => {
    expect(petStateFor({ ...quiet, justFinished: true })).toBe('done');
    expect(petStateFor({ ...quiet, status: 'running', justFinished: true })).toBe('think');
    expect(turnFinished('running', 'idle')).toBe(true);
    expect(turnFinished('starting', 'idle')).toBe(true);
    expect(turnFinished('stopping', 'idle')).toBe(true);
    expect(turnFinished(undefined, 'idle')).toBe(false);
    expect(turnFinished('idle', 'idle')).toBe(false);
    expect(turnFinished('running', 'failed')).toBe(false);
    expect(turnFinished('closed', 'idle')).toBe(false);
  });
});

describe('Show Nano avatar setting', () => {
  const memory = (initial: string | null) => {
    let value = initial;
    return {
      getItem: (key: string) => (key === NANO_PET_STORAGE_KEY ? value : null),
      setItem: (key: string, next: string) => {
        if (key === NANO_PET_STORAGE_KEY) value = next;
      },
      get value() {
        return value;
      },
    };
  };

  it('is on by default and only an explicit 0 turns it off', () => {
    expect(NANO_PET_STORAGE_KEY).toBe('piui.nano.pet');
    expect(parsePetEnabled(null)).toBe(true);
    expect(parsePetEnabled(undefined)).toBe(true);
    expect(parsePetEnabled('1')).toBe(true);
    expect(parsePetEnabled('junk')).toBe(true);
    expect(parsePetEnabled('0')).toBe(false);
  });

  it('round-trips through storage', () => {
    const storage = memory(null);
    expect(readPetEnabled(storage)).toBe(true);
    writePetEnabled(false, storage);
    expect(storage.value).toBe('0');
    expect(readPetEnabled(storage)).toBe(false);
    writePetEnabled(true, storage);
    expect(readPetEnabled(storage)).toBe(true);
  });

  it('survives a blocked or missing store', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readPetEnabled(broken)).toBe(true);
    expect(() => writePetEnabled(false, broken)).not.toThrow();
    expect(readPetEnabled(undefined)).toBe(true);
    expect(() => writePetEnabled(false, undefined)).not.toThrow();
  });
});

describe('NanoPet component', () => {
  it('is decoration with the row, frames and size of its state', () => {
    const body = render(NanoPet, { props: { state: 'talk', size: 40 } }).body;
    expect(body).toContain('aria-hidden="true"');
    expect(body).toContain('data-state="talk"');
    expect(body).toContain('--pet-row: 8');
    expect(body).toContain('--pet-frames: 4');
    expect(body).toContain('--pet-ms: 110');
    expect(body).toContain('--pet-size: 40');
    expect(body).toContain('--pet-repeat: infinite');
  });

  it('plays one-shots a fixed number of times', () => {
    expect(render(NanoPet, { props: { state: 'done' } }).body).toContain('--pet-repeat: 2');
    expect(render(NanoPet, { props: { state: 'error' } }).body).toContain('--pet-frames: 8');
  });
});
