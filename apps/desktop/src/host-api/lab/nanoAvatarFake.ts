import fixture from '../../../../../contracts/fixtures/nano-avatars-v1.json';
import { NANO_AVATAR_EVENT_V1, type NanoAvatarAnswerV1, type NanoAvatarScopeV1 } from '../../../../../contracts/nano-avatars-v1';
import type { NanoAccountStatusV1 } from '../../../../../contracts/nano-account-v1';
import { parseAvatarManifest } from '../nanoAvatarClient';
import type { LabEventBus } from './labBus';

/** Synthetic geometric test artwork, generated in Lab memory. No bundled avatar or Nano request. */
async function syntheticMedia(): Promise<NonNullable<NanoAvatarAnswerV1['avatar']>> {
  const canvas = document.createElement('canvas');
  canvas.width = fixture.atlas.cellWidth * fixture.atlas.columns;
  canvas.height = fixture.atlas.cellHeight * fixture.atlas.rows;
  const context = canvas.getContext('2d');
  if (!context) throw { code: 'feature-unavailable' };
  for (let row = 0; row < fixture.atlas.rows; row += 1) {
    for (let frame = 0; frame < fixture.atlas.columns; frame += 1) {
      context.fillStyle = `hsl(${150 + row * 15} 60% ${40 + frame * 3}%)`;
      context.beginPath();
      context.arc(frame * 192 + 96, row * 208 + 104, 65, 0, 2 * Math.PI);
      context.fill();
      context.fillStyle = '#ffffff';
      context.font = 'bold 32px sans-serif';
      context.textAlign = 'center';
      context.fillText('LAB', frame * 192 + 96, row * 208 + 115);
    }
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Synthetic avatar encoding failed')), 'image/webp'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
  const manifest = parseAvatarManifest({ ...fixture, media: { ...fixture.media, sha256: hash, byteCount: bytes.length } });
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { manifest, mediaBase64: btoa(binary) };
}

export function createLabNanoAvatar(bus: LabEventBus, status: () => NanoAccountStatusV1, safeMode: boolean) {
  let epoch = 0;
  let key = '';
  function scope(): NanoAvatarScopeV1 {
    const current = status();
    const eligible = !safeMode && current.state === 'signed-in' && current.capabilities?.avatars === true && current.entitlements?.features.avatars === true && current.selectedWorkspaceId !== null;
    const next = JSON.stringify([eligible, current.state, current.selectedWorkspaceId, current.device?.id]);
    if (key !== next) { key = next; epoch += 1; }
    return { protocol: 1, revision: current.revision, context: eligible ? `synthetic-${epoch}` : null, workspaceId: eligible ? current.selectedWorkspaceId : null };
  }
  return {
    scope,
    publish: () => bus.emit(NANO_AVATAR_EVENT_V1, scope()),
    async load(context: string): Promise<NanoAvatarAnswerV1> {
      const before = scope();
      if (safeMode || before.context === null || context !== before.context) throw { code: safeMode ? 'safe-mode' : 'feature-unavailable' };
      const avatar = await syntheticMedia();
      if (scope().context !== before.context) throw { code: 'feature-unavailable' };
      return { scope: before, avatar };
    },
  };
}
