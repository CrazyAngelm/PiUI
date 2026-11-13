import type { NanoAvatarClipV1, NanoAvatarManifestV1, NanoAvatarClipIdV1 } from '../../../../../contracts/nano-avatars-v1';

export function clipDuration(clip: NanoAvatarClipV1): number {
  return clip.ms === null ? 0 : clip.frames * clip.ms;
}

function frameAt(clip: NanoAvatarClipV1, elapsed: number, reduced: boolean): number {
  if (reduced || clip.ms === null) return clip.still ?? 0;
  const duration = clipDuration(clip);
  if (clip.hold && elapsed >= duration) {
    return clip.hold.frames[Math.floor((elapsed - duration) / clip.hold.ms) % clip.hold.frames.length] ?? 0;
  }
  return Math.floor(elapsed / clip.ms) % clip.frames;
}

/** Web descriptor semantics: normal pass, then hold sequence; finite repeats return to idle. */
export function poseAt(clips: NanoAvatarManifestV1['clips'], state: NanoAvatarClipIdV1, elapsed: number, reduced = false) {
  let clip = clips[state];
  let time = Math.max(0, elapsed);
  if (!reduced && clip.ms !== null && clip.repeat !== undefined && time >= clipDuration(clip) * clip.repeat) {
    time -= clipDuration(clip) * clip.repeat;
    clip = clips.idle;
  }
  return { row: clip.row, frame: frameAt(clip, time, reduced), animated: !reduced && clip.ms !== null };
}
