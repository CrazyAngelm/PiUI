import type { HarnessConfiguration, ComposerSupport } from './types';
import { harnessConfigurations } from './index';

/** A harness without a composer declaration takes text only. */
export const TEXT_ONLY_COMPOSER: ComposerSupport = {
  images: 'none',
  imagesNote: 'This harness does not accept images in PiUI.',
  nativeCommands: false,
  skillMentions: false,
};

/** Shown when the harness takes images but the session's current model does not. */
export const MODEL_WITHOUT_IMAGES = 'The current model does not accept images.';

/**
 * Composer inputs of a harness id. The only manifest lookup of the composer,
 * so a harness registry (for example `acp:<id>` agents) can replace it.
 */
export function composerSupport(harness: string): ComposerSupport {
  const configurations: Readonly<Record<string, HarnessConfiguration | undefined>> = harnessConfigurations;
  return configurations[harness]?.composer ?? TEXT_ONLY_COMPOSER;
}

export interface ImageSupport {
  readonly supported: boolean;
  /** English source copy explaining why images are unavailable. */
  readonly reason?: string;
}

/**
 * Whether the composer offers images. `live` is the open session's reported
 * capability (protocol and current model); `undefined` before a session
 * exists, when only the manifest is known and the host decides at send.
 */
export function imageSupport(harness: string, live: boolean | undefined): ImageSupport {
  const support = composerSupport(harness);
  if (support.images === 'none') return { supported: false, reason: support.imagesNote };
  if (live === false) return { supported: false, reason: MODEL_WITHOUT_IMAGES };
  return { supported: true };
}
