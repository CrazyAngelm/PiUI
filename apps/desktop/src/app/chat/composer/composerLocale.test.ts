import { expect, it } from 'vitest';
import { translate } from '../../../features/locale/language';
import { harnessConfigurations } from '../../../harness-adapters';
import { MODEL_WITHOUT_IMAGES, TEXT_ONLY_COMPOSER } from '../../../harness-adapters/composer';
import { workspaceError } from '../../../host-api/workspaceClient';

it('translates the composer inputs copy, keeping placeholders', () => {
  const notes = Object.values(harnessConfigurations).flatMap((configuration) => (configuration.composer ? [configuration.composer.imagesNote] : []));
  for (const message of [
    ...notes,
    TEXT_ONLY_COMPOSER.imagesNote,
    MODEL_WITHOUT_IMAGES,
    'Attach images or files',
    'Attached images',
    'Image',
    'Drop images or files to attach',
    'Remove the images to send this message.',
    'Folders cannot be attached.',
    'Images must be 5 MB or smaller.',
    'The file could not be read.',
    'Only PNG, JPEG, GIF and WebP images can be attached.',
    'Too many files at once. Attach at most 10 at a time.',
    'Reference this file by its path?',
    'The agent reads referenced files with its own tools. PiUI does not upload, copy or attach them.',
    'File references',
    'Outside the project folder',
    'Insert references',
    'Reply, type / for commands or @ to mention a file…',
    'Project files',
    'Teammates',
    'Teammates and project files',
    'Loading project files…',
    'No matching files',
    'No matches',
    'Trust this project to mention its files.',
    'extension',
    'prompt',
    'skill',
    'The harness or its current model does not accept images. Your message is still queued; remove it or switch to a model that accepts images.',
    'An attached image is no longer available. Remove this message and attach the image again.',
  ]) {
    expect(translate(message, 'ru'), message).not.toBe(message);
  }
  for (const message of ['Preview of {0}', 'Remove {0}', 'Reference {0} files by their paths?', '{0} was not attached. {1}']) {
    expect(translate(message, 'ru'), message).toMatch(/\{0\}/);
  }
  expect(translate('{0} was not attached. A message can carry at most {1} images.', 'ru')).toMatch(/\{0\}[\s\S]*\{1\}/);
  for (const code of ['IMAGES_UNSUPPORTED', 'ATTACHMENT_UNAVAILABLE', 'FILES_UNAVAILABLE', 'DROP_EXPIRED']) {
    const message = workspaceError({ code, message: 'C:\\secret' }).message;
    expect(message).not.toContain('secret');
    expect(translate(message, 'ru'), code).not.toBe(message);
  }
});
