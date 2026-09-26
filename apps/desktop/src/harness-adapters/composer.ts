import type { Harness } from '../../../../contracts/orchestration-v6';
import type { ComposerSupport } from './types';

/**
 * Chat composer inputs per harness, referenced by each adapter manifest
 * (`HarnessConfiguration.composer`). Kept apart from the manifests so the
 * first-paint composer does not load every manifest.
 */
export const COMPOSER_SUPPORT: Readonly<Record<Harness, ComposerSupport>> = {
  codex: {
    images: 'native',
    imagesNote: 'Codex sends images to models that accept image input.',
    nativeCommands: false,
    skillMentions: true,
  },
  'claude-code': {
    images: 'native',
    imagesNote: 'Claude Code receives images as image content.',
    nativeCommands: true,
    skillMentions: false,
  },
  pi: {
    images: 'native',
    imagesNote: 'Pi sends images to models that declare image input.',
    nativeCommands: true,
    skillMentions: false,
  },
  hermes: {
    images: 'native',
    imagesNote: 'Hermes receives images when its ACP agent declares image input.',
    nativeCommands: true,
    skillMentions: false,
  },
  'prime-agent': {
    images: 'none',
    imagesNote: 'Prime Agent accepts text only in PiUI.',
    nativeCommands: false,
    skillMentions: false,
  },
};

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
 * Composer inputs of a harness id. The only composer lookup, so a harness
 * registry (for example `acp:<id>` agents) can replace it.
 */
export function composerSupport(harness: string): ComposerSupport {
  const table: Readonly<Record<string, ComposerSupport | undefined>> = COMPOSER_SUPPORT;
  return table[harness] ?? TEXT_ONLY_COMPOSER;
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
