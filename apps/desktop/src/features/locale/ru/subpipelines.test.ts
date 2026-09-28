import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { failureText } from '../../../app/runs/runGraph';
import { orchestrationError } from '../../../host-api/orchestrationClient';
import { SUBPIPELINE_FAILURE_CODES, SUBPIPELINE_ISSUE_TEMPLATES, SUBPIPELINE_ISSUES, SUBPIPELINE_SAVE_ERROR_CODES } from '../../../host-api/subpipelines';
import { SYSTEM_FILE_UNNAMED_PIPELINE } from '../../orchestration/systemFile';
import { translate } from '../language';
import { subpipelinesRu } from './subpipelines';

/** Every `$t('…')` literal in the sub-pipeline components (v6.7). */
function sourceKeys(): string[] {
  const files = [
    '../../../app/pipelines/SubpipelineSettings.svelte',
    '../../../app/pipelines/OutputInspector.svelte',
    '../../../app/pipelines/canvas/OutputNodeCard.svelte',
  ].map((path) => new URL(path, import.meta.url));
  const keys = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\$t\('((?:[^'\\]|\\.)+)'/g)) keys.add((match[1] ?? '').replace(/\\'/g, "'"));
  }
  return [...keys];
}

const translated = (key: string): boolean => translate(key, 'ru') !== key || subpipelinesRu[key] === key;

describe('Russian copy for sub-pipelines', () => {
  it('translates every visible string of the new components', () => {
    const keys = sourceKeys();
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates issues, failure codes, save refusals, run labels and the export refusal', () => {
    const keys = [
      ...Object.values(SUBPIPELINE_ISSUES),
      ...Object.values(SUBPIPELINE_ISSUE_TEMPLATES),
      ...Object.values(SUBPIPELINE_FAILURE_CODES).map((code) => failureText(code)),
      ...SUBPIPELINE_SAVE_ERROR_CODES.map((code) => orchestrationError({ code }).message),
      SYSTEM_FILE_UNNAMED_PIPELINE,
      'A sub-pipeline runs on the host and cannot be the orchestrator.',
      'Sub-pipelines',
      'Sub-pipeline',
      'Open pipeline {0}',
      'Sub-pipeline of run',
      'Open parent run {0}',
      'level {0} of {1}',
      'Open child run',
      'Child run: {0}',
      'Sub-pipeline of #{0}',
      'Inputs of the sub-pipeline',
    ];
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('gives every save refusal its own copy instead of the generic one', () => {
    const generic = orchestrationError({ code: 'invalid' }).message;
    for (const code of SUBPIPELINE_SAVE_ERROR_CODES) {
      const error = orchestrationError({ code });
      expect(error.code, code).toBe(code);
      expect(error.message, code).not.toBe(generic);
    }
  });

  it('gives every sub-pipeline failure code a readable text', () => {
    for (const code of Object.values(SUBPIPELINE_FAILURE_CODES)) expect(failureText(code), code).not.toBe(code);
  });

  it('keeps placeholders intact', () => {
    for (const [key, value] of Object.entries(subpipelinesRu)) {
      const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
