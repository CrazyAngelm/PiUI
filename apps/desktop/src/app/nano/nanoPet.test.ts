import { describe, expect, it } from 'vitest';


import {
  NANO_PET_STORAGE_KEY,
  parsePetEnabled,
  petStateFor,
  readPetEnabled,
  turnFinished,
  writePetEnabled,
  type PetActivity,
} from './nanoPet';

const quiet: PetActivity = { status: 'idle', approvals: 0, blocks: [], justFinished: false };

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
