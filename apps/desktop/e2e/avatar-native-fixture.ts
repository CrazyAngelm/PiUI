import { mount, unmount, tick } from 'svelte';
import NanoPet from '../src/app/nano/NanoPet.svelte';
import { decodeAvatar } from '../src/app/nano/nanoAvatar.svelte';
import { createLabNanoAvatar } from '../src/host-api/lab/nanoAvatarFake';
import { LabEventBus } from '../src/host-api/lab/labBus';
import { browserTimers } from '../src/host-api/lab/labClock';
import type { NanoAccountStatusV1 } from '../../../contracts/nano-account-v1';

/** Dev-harness-only fixture. Never replaces the native account or host transport. */
export async function proveAvatarRendering() {
  const status = {
    revision: 1, state: 'signed-in', selectedWorkspaceId: 'synthetic',
    device: { id: 'synthetic' }, capabilities: { avatars: true },
    entitlements: { features: { avatars: true } },
  } as unknown as NanoAccountStatusV1;
  const source = createLabNanoAvatar(new LabEventBus(browserTimers), () => status, false);
  const answer = await source.load(source.scope().context!);
  if (!answer.avatar) throw new Error('Synthetic fixture has no media');
  const decoding = performance.now();
  const avatar = await decodeAvatar(answer.avatar);
  const decodeMs = performance.now() - decoding;
  const target = document.createElement('div');
  target.dataset.avatarProof = 'synthetic';
  document.body.append(target);
  const previousMotion = document.documentElement.dataset.reducedMotion;
  document.documentElement.dataset.reducedMotion = 'reduce';
  const painting = performance.now();
  const component = mount(NanoPet, { target, props: { avatar, state: 'error', size: 96 } });
  let visible = false;
  let reducedFrame = false;
  let paintMs = 0;
  try {
    await tick();
    const canvas = target.querySelector('canvas')!;
    const pixels = canvas.getContext('2d')!.getImageData(96, 70, 1, 1).data;
    visible = pixels[3] > 0 && canvas.getAttribute('aria-hidden') === 'true';
    const sample = document.createElement('canvas');
    sample.width = sample.height = 1;
    const probe = sample.getContext('2d')!;
    const error = avatar.manifest.clips.error;
    probe.drawImage(avatar.bitmap, (error.still ?? 0) * avatar.manifest.atlas.cellWidth + 96,
      error.row * avatar.manifest.atlas.cellHeight + 70, 1, 1, 0, 0, 1, 1);
    const expected = probe.getImageData(0, 0, 1, 1).data;
    reducedFrame = pixels.every((value, index) => value === expected[index]);
    paintMs = performance.now() - painting;
  } finally {
    await unmount(component);
    avatar.bitmap.close();
    target.remove();
    if (previousMotion === undefined) delete document.documentElement.dataset.reducedMotion;
    else document.documentElement.dataset.reducedMotion = previousMotion;
  }
  let rejected = false;
  try { await decodeAvatar({ ...answer.avatar, mediaBase64: 'AAAA' }); } catch { rejected = true; }
  return { visible, reducedFrame, rejected, released: avatar.bitmap.width === 0,
    removed: !document.querySelector('[data-avatar-proof]'), timings: { decodeMs, paintMs } };
}
