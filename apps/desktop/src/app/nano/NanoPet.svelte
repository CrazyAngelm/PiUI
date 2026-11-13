<script lang="ts">
  import type { ReadyAvatar } from './nanoAvatar.svelte';
  import { clipDuration, poseAt } from './avatarAnimation';
  import type { NanoPetState } from './nanoPet';

  interface Props { avatar: ReadyAvatar; state?: NanoPetState; size?: number }
  let { avatar, state = 'idle', size = 32 }: Props = $props();
  let canvas: HTMLCanvasElement;
  const atlas = $derived(avatar.manifest.atlas);
  const clip = $derived(avatar.manifest.clips[state]);

  $effect(() => {
    const surface = canvas;
    const context = surface?.getContext('2d');
    if (!context) return;
    const { bitmap } = avatar;
    const geometry = atlas;
    const animation = clip;
    const clips = avatar.manifest.clips;
    const activity = state;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const started = performance.now();
    const offset = animation.desync ? Math.random() * clipDuration(animation) : 0;
    let frameRequest = 0;
    let lastPose = '';
    let stopped = false;
    function paint(now: number): void {
      if (stopped || bitmap.width === 0) return;
      const reduced = media.matches || document.documentElement.dataset.reducedMotion === 'reduce';
      const pose = poseAt(clips, activity, now - started + offset, reduced);
      const identity = `${pose.row}:${pose.frame}`;
      if (identity !== lastPose) {
        context!.clearRect(0, 0, surface.width, surface.height);
        context!.drawImage(bitmap, pose.frame * geometry.cellWidth, pose.row * geometry.cellHeight,
          geometry.cellWidth, geometry.cellHeight, 0, 0, surface.width, surface.height);
        lastPose = identity;
      }
      if (pose.animated) {
        frameRequest = requestAnimationFrame(paint);
      }
    }
    const restart = (): void => { cancelAnimationFrame(frameRequest); paint(performance.now()); };
    media.addEventListener('change', restart);
    const observer = new MutationObserver(restart);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] });
    paint(started);
    return () => {
      stopped = true;
      cancelAnimationFrame(frameRequest);
      observer.disconnect();
      media.removeEventListener('change', restart);
      context.clearRect(0, 0, surface.width, surface.height);
    };
  });
</script>

<!-- Decoration only: the existing chat status remains the accessible, generic fallback. -->
<canvas bind:this={canvas} class="pet" aria-hidden="true" data-state={state}
  width={atlas.cellWidth} height={atlas.cellHeight}
  style:width={`${size}px`} style:height={`${size * atlas.cellHeight / atlas.cellWidth}px`}></canvas>

<style>
  .pet { display: inline-block; flex: none; pointer-events: none; user-select: none; }
</style>
