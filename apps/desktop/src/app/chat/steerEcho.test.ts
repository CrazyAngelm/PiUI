import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../host-api/types';
import { echoBlocks, steerEchoes, userBlockIds, waitingEchoes, type SteerEcho } from './steerEcho.svelte';

const user = (id: string, text: string): TimelineBlock => ({ id, kind: 'user', label: 'You', text, status: 'complete' });
const tool = (id: string): TimelineBlock => ({ id, kind: 'tool', toolName: 'bash', status: 'complete' });
const echo = (id: string, text: string, known: readonly string[] = [], images = 0): SteerEcho => ({ id, text, images, known: new Set(known) });

describe('steer echoes', () => {
  it('keeps an echo until the runtime reports a new user message with its text', () => {
    const sent = [echo('r1', 'Keep it short', ['u1'])];
    // The same words in a message the chat already had are not this message.
    expect(waitingEchoes(sent, [user('u1', 'Keep it short'), tool('t1')])).toBe(sent);
    expect(waitingEchoes(sent, [user('u1', 'Keep it short'), tool('t1'), user('u2', 'Something else')])).toBe(sent);
    expect(waitingEchoes(sent, [user('u1', 'Keep it short'), tool('t1'), user('u2', 'Keep it short')])).toEqual([]);
  });

  it('only a user message settles an echo', () => {
    const sent = [echo('r1', 'bash')];
    expect(waitingEchoes(sent, [{ id: 'a1', kind: 'assistant', text: 'bash', status: 'complete' }, tool('t1')])).toBe(sent);
  });

  it('recognises a reported message with image markers and re-wrapped whitespace', () => {
    expect(waitingEchoes([echo('r1', 'Look at  this\n', [], 2)], [user('u1', 'Look at this\n\n[image]\n[image]')])).toEqual([]);
  });

  it('settles equal messages one by one, the oldest first', () => {
    const sent = [echo('r1', 'continue'), echo('r2', 'continue')];
    expect(waitingEchoes(sent, [user('u1', 'continue')]).map((item) => item.id)).toEqual(['r2']);
    expect(waitingEchoes(sent, [user('u1', 'continue'), user('u2', 'continue')])).toEqual([]);
  });

  it('shows an echo as a pending user message with its images', () => {
    expect(echoBlocks([echo('r1', 'Look', [], 2), echo('r2', 'Plain')])).toEqual([
      { id: 'piui-steer-echo:r1', kind: 'user', label: 'You', text: 'Look\n\n[image]\n[image]', status: 'streaming' },
      { id: 'piui-steer-echo:r2', kind: 'user', label: 'You', text: 'Plain', status: 'streaming' },
    ]);
  });

  it('collects the ids of user messages only', () => {
    expect([...userBlockIds([user('u1', 'a'), tool('t1'), user('u2', 'b')])]).toEqual(['u1', 'u2']);
  });

  it('remembers a message once and forgets it for good when it is reported', () => {
    steerEchoes.add('s1', echo('r1', 'Keep it short'));
    steerEchoes.add('s1', echo('r1', 'Keep it short'));
    steerEchoes.add('s1', echo('r2', 'And add a test'));
    expect(steerEchoes.list('s1').map((item) => item.id)).toEqual(['r1', 'r2']);
    expect(steerEchoes.list('other')).toEqual([]);

    steerEchoes.settle('s1', [tool('t1')], true);
    expect(steerEchoes.list('s1')).toHaveLength(2);
    steerEchoes.settle('s1', [tool('t1'), user('u1', 'Keep it short')], true);
    expect(steerEchoes.list('s1').map((item) => item.id)).toEqual(['r2']);
    // The reported message left the loaded part of the chat: its echo stays gone.
    steerEchoes.settle('s1', [tool('t2')], true);
    expect(steerEchoes.list('s1').map((item) => item.id)).toEqual(['r2']);
  });

  it('drops every echo of a chat once no turn runs', () => {
    steerEchoes.add('s2', echo('r1', 'Never read'));
    steerEchoes.settle('s2', [], false);
    expect(steerEchoes.list('s2')).toEqual([]);
  });
});
