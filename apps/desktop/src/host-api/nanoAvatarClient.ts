import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import { NANO_AVATAR_CLIPS, NANO_AVATAR_EVENT_V1, NANO_AVATAR_MAX_BYTES, type NanoAvatarAnswerV1, type NanoAvatarManifestV1, type NanoAvatarScopeV1 } from '../../../../contracts/nano-avatars-v1';

export type { NanoAvatarAnswerV1, NanoAvatarManifestV1, NanoAvatarScopeV1 };
export interface NanoAvatarClient {
  scope(): Promise<NanoAvatarScopeV1>;
  load(context: string): Promise<NanoAvatarAnswerV1>;
  subscribe(listener: (scope: NanoAvatarScopeV1) => void): Promise<() => void>;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => integer(value) && value > 0;
const validId = (id: unknown): id is string => typeof id === 'string' && (/^(nano|analyst|lawyer|marketer|editor|blair|pixel)$/.test(id) || /^u-[0-9a-f]{12}$/.test(id));
const invalid = (): never => { throw new Error('Invalid avatar contract'); };

export function parseAvatarScope(value: unknown): NanoAvatarScopeV1 {
  if (!record(value) || value.protocol !== 1 || !integer(value.revision)
    || !(value.context === null || (typeof value.context === 'string' && value.context.length > 0))
    || !(value.workspaceId === null || (typeof value.workspaceId === 'string' && value.workspaceId.length > 0))
    || (value.context === null) !== (value.workspaceId === null)) return invalid();
  return value as unknown as NanoAvatarScopeV1;
}
export function parseAvatarManifest(value: unknown): NanoAvatarManifestV1 {
  if (!record(value) || value.schemaVersion !== 1 || value.renderer !== 'nano-atlas' || value.rendererVersion !== 1
    || !validId(value.avatarId) || typeof value.name !== 'string' || value.name.length === 0) return invalid();
  const { media, atlas, clips } = value;
  if (!record(media) || media.variant !== 'atlas' || media.mimeType !== 'image/webp'
    || typeof media.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(media.sha256)
    || !positive(media.byteCount) || media.byteCount > NANO_AVATAR_MAX_BYTES
    || !record(atlas) || atlas.cellWidth !== 192 || atlas.cellHeight !== 208 || atlas.columns !== 8 || atlas.rows !== 9
    || !record(clips) || Object.keys(clips).length !== NANO_AVATAR_CLIPS.length) return invalid();
  for (const name of NANO_AVATAR_CLIPS) {
    const clip = clips[name];
    if (!record(clip) || !integer(clip.row) || clip.row >= atlas.rows || !positive(clip.frames) || clip.frames > atlas.columns
      || (name === 'still' ? clip.ms !== null || clip.frames !== 1 : !positive(clip.ms))
      || (clip.desync !== undefined && typeof clip.desync !== 'boolean')
      || (clip.repeat !== undefined && !positive(clip.repeat))
      || (clip.still !== undefined && (!integer(clip.still) || clip.still >= clip.frames))) return invalid();
    if (clip.hold !== undefined && (!record(clip.hold) || !positive(clip.hold.ms) || !Array.isArray(clip.hold.frames)
      || clip.hold.frames.some((frame) => !integer(frame) || frame >= (clip.frames as number)))) return invalid();
  }
  return value as unknown as NanoAvatarManifestV1;
}
function parseAnswer(value: unknown): NanoAvatarAnswerV1 {
  if (!record(value)) return invalid();
  const scope = parseAvatarScope(value.scope);
  if (value.avatar === null) return { scope, avatar: null };
  if (!record(value.avatar) || typeof value.avatar.mediaBase64 !== 'string') return invalid();
  const manifest = parseAvatarManifest(value.avatar.manifest);
  if (value.avatar.mediaBase64.length !== Math.ceil(manifest.media.byteCount / 3) * 4) return invalid();
  return { scope, avatar: { manifest, mediaBase64: value.avatar.mediaBase64 } };
}
export function createNanoAvatarClient(invoke: HostInvoke, listen: HostListen): NanoAvatarClient {
  return {
    scope: async () => parseAvatarScope(await invoke('nano_avatar_scope_v1')),
    load: async (context) => parseAnswer(await invoke('nano_avatar_load_v1', { request: { context } })),
    subscribe: (listener) => listen<unknown>(NANO_AVATAR_EVENT_V1, (value) => {
      try { listener(parseAvatarScope(value)); } catch { /* An invalid event never grants access. */ }
    }),
  };
}
export const nanoAvatarHost = createNanoAvatarClient(hostInvoke, hostListen);
