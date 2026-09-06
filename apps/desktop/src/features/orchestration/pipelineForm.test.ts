import { describe, expect, it } from 'vitest';
import { createPipeline, createPipelineStep, removePipelineStep, validatePipeline } from './pipelineForm';
import type { PipelineDefinition, PipelineStep } from '../../../../../contracts/orchestration-v2';
const step = (id: string, dependencies: readonly string[] = []): PipelineStep => ({ id, name: id, assignedMemberId: 'reviewer', instructions: '', dependencyStepIds: dependencies });
const pipeline = (steps: readonly PipelineStep[]): PipelineDefinition => ({ id: 'fixture-pipeline', name: 'Fixture pipeline', steps });

describe('pipeline editor draft model', () => {
  it('creates only unsaved empty definitions, not sample work', () => {
    expect(createPipeline('draft')).toEqual({ id: 'draft', name: '', steps: [] });
    expect(createPipelineStep('draft-step')).toEqual({ id: 'draft-step', name: '', assignedMemberId: '', instructions: '', dependencyStepIds: [] });
  });
  it('previews a dependency DAG with independent tasks without changing the definition', () => {
    const source = pipeline([step('publish', ['review', 'test']), step('review'), step('test')]);
    expect(validatePipeline(source)).toEqual({ errors: [], orderedStepIds: ['review', 'test', 'publish'] });
    expect(source.steps[0]?.dependencyStepIds).toEqual(['review', 'test']);
  });
  it('rejects cycles and missing dependencies with no misleading order', () => {
    expect(validatePipeline(pipeline([step('a', ['b']), step('b', ['a'])]))).toEqual({ errors: ['Dependencies contain a cycle. Remove a dependency before saving.'], orderedStepIds: [] });
    const missing = validatePipeline(pipeline([step('a', ['missing'])]));
    expect(missing.errors).toContain('a refers to a missing dependency.');
    expect(missing.orderedStepIds).toEqual([]);
  });
  it('names invalid fields and removes dangling dependencies when a task is explicitly removed', () => {
    expect(validatePipeline({ id: 'draft', name: '', steps: [createPipelineStep('empty')] }).errors).toEqual(['Give this pipeline a name.', 'Give each task a name.', 'Choose a member slot for the unnamed task.']);
    const source = pipeline([step('a'), step('b', ['a'])]);
    const updated = removePipelineStep(source, 'a');
    expect(updated.steps).toEqual([step('b')]);
    expect(source.steps.length).toBe(2);
  });
});
