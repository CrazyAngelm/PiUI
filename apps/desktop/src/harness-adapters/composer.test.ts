import { describe, expect, it } from 'vitest';
import { harnessConfigurations } from './index';
import { MODEL_WITHOUT_IMAGES, TEXT_ONLY_COMPOSER, composerSupport, imageSupport } from './composer';

describe('composer support manifests', () => {
  it('declares every harness composer inputs, never claiming more than its bridge', () => {
    expect(Object.fromEntries(Object.entries(harnessConfigurations).map(([harness, configuration]) => [harness, configuration.composer]))).toEqual({
      codex: { images: 'native', imagesNote: expect.any(String), nativeCommands: false, skillMentions: true },
      'prime-agent': { images: 'none', imagesNote: 'Prime Agent accepts text only in PiUI.', nativeCommands: false, skillMentions: false },
      pi: { images: 'native', imagesNote: expect.any(String), nativeCommands: true, skillMentions: false },
      hermes: { images: 'native', imagesNote: expect.any(String), nativeCommands: true, skillMentions: false },
      'claude-code': { images: 'native', imagesNote: expect.any(String), nativeCommands: true, skillMentions: false },
    });
  });

  it('treats an undeclared harness (e.g. a registry ACP agent) as text only', () => {
    expect(composerSupport('acp:example')).toBe(TEXT_ONLY_COMPOSER);
    expect(imageSupport('acp:example', undefined)).toEqual({ supported: false, reason: TEXT_ONLY_COMPOSER.imagesNote });
  });

  it('lets the live session decide within what the harness protocol takes', () => {
    expect(imageSupport('codex', undefined)).toEqual({ supported: true });
    expect(imageSupport('codex', true)).toEqual({ supported: true });
    expect(imageSupport('pi', false)).toEqual({ supported: false, reason: MODEL_WITHOUT_IMAGES });
    // A live report never widens a harness that takes no images.
    expect(imageSupport('prime-agent', true)).toEqual({ supported: false, reason: 'Prime Agent accepts text only in PiUI.' });
  });
});
