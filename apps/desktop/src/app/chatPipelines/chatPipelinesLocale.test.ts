import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lookupRussian } from '../../features/locale/ruCatalog';
import { PIPELINE_LIBRARY_ERROR_COPY } from '../../host-api/pipelineLibraryClient';

const here = dirname(fileURLToPath(import.meta.url));
/** Every `$t('…')` literal of the chat pipeline screens. */
const FILES = [
  'ChatRunCard.svelte',
  'ExecutorPicker.svelte',
  'PipelineInputsBar.svelte',
  'SaveTemplateDialog.svelte',
  '../shell/ContextChip.svelte',
  '../pipelines/StartInspector.svelte',
];
/** Messages built outside components that reach `$t` later. */
const MESSAGES = [
  'This pipeline does not accept chat messages. Add a message input to its start.',
  'This run was not started from a saved pipeline.',
  'The message is too long for a pipeline run.',
  'Fill in the pipeline inputs before sending.',
  'Check the pipeline inputs before sending.',
  'The run started, but this chat could not remember it. Find it in Runs.',
  'Pipelines take text only. Remove the images, or talk to the agent directly.',
  'Enter a template name.',
  'Describe the task for the pipeline…',
  'Handed on the result of {0}',
  'a pipeline',
  'The next message hands the pipeline result to {0}.',
  'Opened a template as a new pipeline',
  'Save it to use it in chats and runs.',
  'Save as template…',
  'Your templates',
  'This template could not be opened',
  'Pipelines take text only',
  'Remove the images, or talk to the harness directly.',
  ...Object.values(PIPELINE_LIBRARY_ERROR_COPY),
];

function literals(file: string): string[] {
  const source = readFileSync(join(here, file), 'utf8');
  return [...source.matchAll(/\$t\('((?:[^'\\]|\\.)*)'/gu)].map((match) => match[1]!.replace(/\\'/gu, "'"));
}

describe('chat pipelines in Russian', () => {
  it('translate every visible string', () => {
    const copy = [...new Set([...FILES.flatMap(literals), ...MESSAGES])];
    expect(copy.length).toBeGreaterThan(40);
    expect(copy.filter((value) => lookupRussian(value) === undefined)).toEqual([]);
  });
});
