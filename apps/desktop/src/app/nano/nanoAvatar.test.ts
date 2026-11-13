import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../../contracts/fixtures/nano-avatars-v1.json';
import type { NanoAvatarAnswerV1, NanoAvatarScopeV1 } from '../../../../../contracts/nano-avatars-v1';
import { parseAvatarManifest, type NanoAvatarClient } from '../../host-api/nanoAvatarClient';
import { NanoAvatar, type ReadyAvatar } from './nanoAvatar.svelte';
import { clipDuration, poseAt } from './avatarAnimation';

const scope: NanoAvatarScopeV1 = { protocol: 1, revision: 1, context: 'account-1', workspaceId: 'workspace-1' };
const manifest = parseAvatarManifest(fixture);
const answer: NanoAvatarAnswerV1 = { scope, avatar: { manifest, mediaBase64: 'AAAAAA==' } };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
function setup() {
  let current = scope;
  let listener: ((value: NanoAvatarScopeV1) => void) | undefined;
  const pending = deferred<NanoAvatarAnswerV1>();
  const close = vi.fn();
  const ready: ReadyAvatar = { manifest, bitmap: { width: 1536, height: 1872, close } as unknown as ImageBitmap };
  const client: NanoAvatarClient = {
    scope: vi.fn(async () => current),
    subscribe: vi.fn(async (handler) => { listener = handler; return () => { listener = undefined; }; }),
    load: vi.fn(() => pending.promise),
  };
  const decode = vi.fn(async () => ready);
  const store = new NanoAvatar(client, decode);
  return { client, store, close, decode, pending, ready,
    setScope(next: NanoAvatarScopeV1, publish = true) { current = next; if (publish) listener?.(next); } };
}

describe('ephemeral avatar custody', () => {
  it('shares one load, ignores credit-only revisions, and closes media on final disposal', async () => {
    const env = setup();
    const release = env.store.acquire();
    const releaseSecond = env.store.acquire();
    await vi.waitFor(() => expect(env.client.load).toHaveBeenCalledOnce());
    env.pending.resolve(answer);
    await vi.waitFor(() => expect(env.store.ready).toBe(env.ready));
    env.setScope({ ...scope, revision: 2 });
    expect(env.client.load).toHaveBeenCalledOnce();
    release();
    expect(env.close).not.toHaveBeenCalled();
    releaseSecond();
    expect(env.close).toHaveBeenCalledOnce();
    expect(env.store.ready).toBeUndefined();
  });

  it('rejects a late response after scope revocation without decoding it', async () => {
    const env = setup();
    const release = env.store.acquire();
    await vi.waitFor(() => expect(env.client.load).toHaveBeenCalledOnce());
    env.setScope({ protocol: 1, revision: 2, context: null, workspaceId: null });
    env.pending.resolve(answer);
    await env.pending.promise;
    expect(env.decode).not.toHaveBeenCalled();
    expect(env.store.ready).toBeUndefined();
    release();
  });

  it('reconciles revocation after decoding even before the event is delivered', async () => {
    const env = setup();
    const release = env.store.acquire();
    await vi.waitFor(() => expect(env.client.load).toHaveBeenCalledOnce());
    env.setScope({ protocol: 1, revision: 2, context: null, workspaceId: null }, false);
    env.pending.resolve(answer);
    await vi.waitFor(() => expect(env.close).toHaveBeenCalledOnce());
    expect(env.store.ready).toBeUndefined();
    release();
  });

  it('closes a bitmap decoded after the chat was disposed', async () => {
    const env = setup();
    const decoding = deferred<ReadyAvatar>();
    env.decode.mockImplementation(() => decoding.promise);
    const release = env.store.acquire();
    await vi.waitFor(() => expect(env.client.load).toHaveBeenCalledOnce());
    env.pending.resolve(answer);
    await vi.waitFor(() => expect(env.decode).toHaveBeenCalledOnce());
    release();
    decoding.resolve(env.ready);
    await vi.waitFor(() => expect(env.close).toHaveBeenCalledOnce());
    expect(env.store.ready).toBeUndefined();
  });
});

describe('descriptor animation', () => {
  it('plays the six wait frames normally before cycling only its held frames', () => {
    expect(clipDuration(manifest.clips.wait)).toBe(900);
    for (let frame = 0; frame < 6; frame++) {
      expect(poseAt(manifest.clips, 'wait', frame * 150)).toEqual({ row: 3, frame, animated: true });
    }
    expect(poseAt(manifest.clips, 'wait', 900).frame).toBe(0);
    expect(poseAt(manifest.clips, 'wait', 1999).frame).toBe(0);
    expect(poseAt(manifest.clips, 'wait', 2000).frame).toBe(5);
    expect(poseAt(manifest.clips, 'wait', 3100).frame).toBe(0);
  });

  it('returns finite done, error and wave clips to an animated idle row', () => {
    for (const [state, end] of [['done', 1400], ['error', 1120], ['wave', 1680]] as const) {
      expect(poseAt(manifest.clips, state, end - 1).row).toBe(manifest.clips[state].row);
      expect(poseAt(manifest.clips, state, end)).toEqual({ row: 0, frame: 0, animated: true });
      expect(poseAt(manifest.clips, state, end + 180).frame).toBe(1);
    }
  });

  it('uses expressive descriptor still frames when motion is reduced', () => {
    expect(poseAt(manifest.clips, 'done', 5000, true)).toEqual({ row: 4, frame: 2, animated: false });
    expect(poseAt(manifest.clips, 'error', 5000, true)).toEqual({ row: 5, frame: 4, animated: false });
    expect(poseAt(manifest.clips, 'wave', 5000, true)).toEqual({ row: 6, frame: 1, animated: false });
    expect(poseAt(manifest.clips, 'still', 10000)).toEqual({ row: 0, frame: 0, animated: false });
  });
});
