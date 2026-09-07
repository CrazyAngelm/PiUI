import type { PipelineDefinition, PipelineStep } from '../../../../../contracts/orchestration-v4';

export interface PipelineValidation {
  readonly errors: readonly string[];
  readonly orderedStepIds: readonly string[];
}

export function createPipeline(id: string): PipelineDefinition {
  return { id, name: '', steps: [] };
}

export function createPipelineStep(id: string): PipelineStep {
  return { id, name: '', assignedMemberId: '', instructions: '', dependencyStepIds: [] };
}

export function removePipelineStep(pipeline: PipelineDefinition, stepId: string): PipelineDefinition {
  return { ...pipeline, steps: pipeline.steps.filter((step) => step.id !== stepId).map((step) => ({
    ...step, dependencyStepIds: step.dependencyStepIds.filter((dependency) => dependency !== stepId),
  })) };
}

/** Presentation validation only. The coordinator remains the authority at save/launch. */
export function validatePipeline(pipeline: PipelineDefinition): PipelineValidation {
  const errors: string[] = [];
  if (!pipeline.name.trim()) errors.push('Give this pipeline a name.');
  const ids = new Set<string>();
  for (const step of pipeline.steps) {
    if (!step.id.trim() || ids.has(step.id)) errors.push('Each task needs a distinct non-empty identifier.');
    ids.add(step.id);
    if (!step.name.trim()) errors.push('Give each task a name.');
    if (!step.assignedMemberId.trim()) errors.push(`Choose a member slot for ${step.name || 'the unnamed task'}.`);
  }
  for (const step of pipeline.steps) {
    const dependencies = new Set<string>();
    for (const dependency of step.dependencyStepIds) {
      if (!ids.has(dependency)) errors.push(`${step.name || 'A task'} refers to a missing dependency.`);
      if (dependencies.has(dependency)) errors.push(`${step.name || 'A task'} repeats a dependency.`);
      dependencies.add(dependency);
    }
  }
  const remaining = new Map(pipeline.steps.map((step) => [step.id, new Set(step.dependencyStepIds)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
    if (ready.length === 0) break;
    for (const id of ready) {
      remaining.delete(id);
      order.push(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  if (remaining.size > 0 && pipeline.steps.every((step) => step.dependencyStepIds.every((id) => ids.has(id)))) {
    errors.push('Dependencies contain a cycle. Remove a dependency before saving.');
  }
  return { errors: [...new Set(errors)], orderedStepIds: errors.length === 0 ? order : [] };
}
