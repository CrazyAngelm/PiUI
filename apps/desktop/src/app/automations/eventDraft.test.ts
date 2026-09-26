import { describe, expect, it } from 'vitest';
import { translate } from '../../features/locale/language';
import type { Translate } from './cadence';
import { eventDraftFrom, eventDraftProblem, eventTriggerOf, startsItself, type EventDraft } from './eventDraft';

const english: Translate = (value, parameters = []) =>
  value.replace(/\{(\d+)\}/g, (token, index: string) => (Number(index) < parameters.length ? String(parameters[Number(index)]) : token));
const russian: Translate = (value, parameters = []) => english(translate(value, 'ru'), parameters);
const pipelines = ['build', 'deploy'];

function files(include: string, exclude = '', debounce = '10'): EventDraft {
  return { ...eventDraftFrom(undefined, 'build'), kind: 'files-changed', include, exclude, debounce };
}

describe('event automation draft', () => {
  it('starts as a "pipeline succeeds" rule watching another pipeline', () => {
    const draft = eventDraftFrom(undefined, 'build');
    expect(draft).toMatchObject({ kind: 'run-finished', sourceId: 'build', outcomes: ['succeeded'], debounce: '10' });
    expect(eventDraftProblem(draft, pipelines, english)).toBe('');
    expect(eventTriggerOf(draft, pipelines)).toEqual({
      type: 'event', event: { kind: 'run-finished', launchCommandId: 'build', outcomes: ['succeeded'] },
    });
  });

  it('refuses a missing pipeline or an empty result choice', () => {
    const draft = eventDraftFrom(undefined, 'gone');
    expect(eventDraftProblem(draft, pipelines, english)).toBe('Choose the pipeline to wait for.');
    expect(eventTriggerOf(draft, pipelines)).toBeUndefined();
    expect(eventDraftProblem({ ...draft, sourceId: 'build', outcomes: [] }, pipelines, english)).toBe('Choose at least one result.');
  });

  it('stores outcomes in the host order', () => {
    const draft: EventDraft = { ...eventDraftFrom(undefined, 'build'), outcomes: ['cancelled', 'succeeded'] };
    expect(eventTriggerOf(draft, pipelines)?.event).toEqual({ kind: 'run-finished', launchCommandId: 'build', outcomes: ['succeeded', 'cancelled'] });
  });

  it('turns file lines into patterns and explains a refused one', () => {
    expect(eventTriggerOf(files(' src/**/*.ts \n\n.\\docs\\\n', 'src/gen/**', ' 30 '), pipelines)).toEqual({
      type: 'event', event: { kind: 'files-changed', include: ['src/**/*.ts', 'docs/'], exclude: ['src/gen/**'], debounceSeconds: 30 },
    });
    expect(eventTriggerOf(files('*.md'), pipelines)?.event).not.toHaveProperty('exclude');
    expect(eventDraftProblem(files(''), pipelines, english)).toBe('Add at least one file pattern.');
    expect(eventDraftProblem(files('src/**', '../secrets'), pipelines, english)).toBe('Pattern “../secrets”: Remove ./ and ../ from the pattern.');
    expect(eventDraftProblem(files('C:/Windows/*'), pipelines, english)).toContain('inside the project folder');
    expect(eventDraftProblem(files(Array.from({ length: 33 }, (_, index) => `a${index}/*`).join('\n')), pipelines, english))
      .toBe('Use at most 32 patterns in each list.');
  });

  it('bounds the quiet period to 2-3600 whole seconds', () => {
    for (const debounce of ['1', '3601', '2.5', 'soon', '']) {
      expect(eventDraftProblem(files('src/**', '', debounce), pipelines, english), debounce).toBe('Wait between 2 and 3600 seconds.');
    }
    for (const debounce of ['2', '3600']) expect(eventDraftProblem(files('src/**', '', debounce), pipelines, english)).toBe('');
  });

  it('round-trips a saved rule and notices a rule that starts its own pipeline', () => {
    const trigger = { type: 'event', event: { kind: 'files-changed', include: ['src/**', 'docs/'], exclude: ['x/**'], debounceSeconds: 45 } } as const;
    const draft = eventDraftFrom(trigger, 'build');
    expect(eventTriggerOf(draft, pipelines)).toEqual(trigger);
    expect(startsItself(eventDraftFrom(undefined, 'deploy'), 'deploy')).toBe(true);
    expect(startsItself(eventDraftFrom(undefined, 'build'), 'deploy')).toBe(false);
    expect(startsItself(draft, 'build')).toBe(false);
  });

  it('explains problems in Russian without translating the pattern', () => {
    const problem = eventDraftProblem(files('src/**', '../x'), pipelines, russian);
    expect(problem).toContain('../x');
    expect(problem).toMatch(/[а-яё]/i);
    for (const text of [
      eventDraftProblem(files(''), pipelines, russian),
      eventDraftProblem(files('src/**', '', '1'), pipelines, russian),
      eventDraftProblem(eventDraftFrom(undefined, 'gone'), pipelines, russian),
    ]) {
      expect(text).toMatch(/[а-яё]/i);
    }
  });
});
