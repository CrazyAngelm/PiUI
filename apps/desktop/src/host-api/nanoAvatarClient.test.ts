import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../contracts/fixtures/nano-avatars-v1.json';
import { createNanoAvatarClient, parseAvatarManifest, parseAvatarScope } from './nanoAvatarClient';
import type { HostInvoke } from './transport';

describe('avatar IPC v1', () => {
  it('passes only the opaque context and no media URL or credentials', async () => {
    const scope = { protocol: 1, revision: 1, context: 'opaque', workspaceId: 'workspace' };
    const invoke = vi.fn(async () => ({ scope, avatar: null })) as unknown as HostInvoke;
    const client = createNanoAvatarClient(invoke, async () => () => {});
    expect(await client.load('opaque')).toEqual({ scope, avatar: null });
    expect(invoke).toHaveBeenCalledWith('nano_avatar_load_v1', { request: { context: 'opaque' } });
  });
  it('refuses unsupported renderer, geometry, hashes, frame ranges, and inconsistent scopes', () => {
    expect(parseAvatarManifest(fixture)).toEqual(fixture);
    expect(() => parseAvatarManifest({ ...fixture, renderer: 'html' })).toThrow();
    expect(() => parseAvatarManifest({ ...fixture, atlas: { ...fixture.atlas, columns: 7 } })).toThrow();
    expect(() => parseAvatarManifest({ ...fixture, media: { ...fixture.media, sha256: 'abc' } })).toThrow();
    expect(() => parseAvatarManifest({ ...fixture, clips: { ...fixture.clips, idle: { ...fixture.clips.idle, frames: 9 } } })).toThrow();
    expect(() => parseAvatarScope({ protocol: 1, revision: 1, context: 'old', workspaceId: null })).toThrow();
  });
});
