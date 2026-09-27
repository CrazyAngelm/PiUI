import { describe, expect, it } from 'vitest';
import type { OrchestrationRunV6, PipelineInput, PipelineStep, TaskRecord } from '../../host-api/orchestrationClient';
import {
  acceptsChat,
  chatInput,
  answerTask,
  chatMessageInput,
  extraInputs,
  finalSteps,
  missingInputs,
  replyStep,
  splitPipelineContext,
  withChatInput,
  withPipelineContext,
} from './chatPipeline';

const step = (id: string, deps: string[] = [], extra: Partial<PipelineStep> = {}): PipelineStep => ({
  id,
  name: id,
  assignedMemberId: `m-${id}`,
  instructions: '',
  dependencyStepIds: deps,
  ...extra,
});
const task = (stepId: string, status: TaskRecord['status']): TaskRecord => ({ stepId, status, revision: 1 });
const run = (steps: PipelineStep[], tasks: TaskRecord[]) =>
  ({ definition: { pipeline: { id: 'p', name: 'P', steps } }, tasks }) as unknown as Pick<OrchestrationRunV6, 'definition' | 'tasks'>;

const message = chatMessageInput('Message', 'The chat message');
const topic: PipelineInput = { name: 'topic', label: 'Topic', kind: 'text', required: true };

describe('chat inputs', () => {
  it('uses the message input, else the only text input', () => {
    const count: PipelineInput = { name: 'count', label: 'Count', kind: 'number' };
    expect(acceptsChat(undefined)).toBe(false);
    expect(acceptsChat([count])).toBe(false);
    expect(chatInput([topic, count])?.name).toBe('topic');
    expect(chatInput([topic, { ...topic, name: 'other' }])).toBeUndefined();
    expect(chatInput([topic, message])?.name).toBe('message');
    expect(acceptsChat([{ ...message, kind: 'number' }, topic])).toBe(true);
  });

  it('adds the message input once, first', () => {
    const added = withChatInput([topic], message);
    expect(added.map((input) => input.name)).toEqual(['message', 'topic']);
    expect(withChatInput(added, message)).toHaveLength(2);
    expect(extraInputs(added)).toEqual([topic]);
    expect(extraInputs([topic])).toEqual([]);
  });

  it('lists required extra inputs without a value or default', () => {
    expect(missingInputs([message, topic], {})).toEqual(['topic']);
    expect(missingInputs([topic], {})).toEqual([]);
    expect(missingInputs([message, topic], { topic: '  ' })).toEqual(['topic']);
    expect(missingInputs([message, topic], { topic: 'x' })).toEqual([]);
    expect(missingInputs([message, { ...topic, defaultValue: 'd' }], {})).toEqual([]);
  });
});

describe('reply step', () => {
  it('picks the last final agent step', () => {
    const steps = [step('plan'), step('code', ['plan']), step('review', ['code'])];
    expect(finalSteps(steps).map((item) => item.id)).toEqual(['review']);
    expect(replyStep(steps)?.id).toBe('review');
  });

  it('skips routers, callable steps and scripts', () => {
    const steps = [
      step('a'),
      step('route', ['a'], { router: { mode: 'program', inputStepId: 'a', branches: [] } }),
      step('b', ['route']),
      step('helper', [], { executionMode: 'callable' }),
      step('script', ['b'], { executor: { type: 'script', runtime: 'node', source: '', timeoutSeconds: 10 } }),
    ];
    expect(replyStep(steps)?.id).toBe('b');
  });

  it('answers with the last final step that succeeded', () => {
    const steps = [step('a'), step('left', ['a']), step('right', ['a'])];
    expect(answerTask(run(steps, [task('a', 'succeeded'), task('left', 'succeeded'), task('right', 'skipped')]))?.step.id).toBe('left');
    expect(answerTask(run(steps, [task('a', 'succeeded'), task('left', 'failed'), task('right', 'failed')]))?.step.id).toBe('a');
    expect(answerTask(run(steps, [task('a', 'running')]))).toBeUndefined();
  });
});

describe('pipeline context', () => {
  it('round-trips labelled result blocks and the message', () => {
    const text = withPipelineContext(
      [
        { pipelineName: 'Review "loop"', runId: 'r1', request: 'Fix it', result: 'Done.' },
        { pipelineName: 'Second', runId: 'r2', request: 'Again', result: '' },
      ],
      'Thanks, now add tests',
    );
    const split = splitPipelineContext(text);
    expect(split.text).toBe('Thanks, now add tests');
    expect(split.contexts.map((context) => context.pipelineName)).toEqual(["Review 'loop'", 'Second']);
    expect(split.contexts[0]?.body).toContain('Done.');
    expect(split.contexts[1]?.body).toContain('(no text result)');
  });

  it('leaves ordinary and malformed messages alone', () => {
    expect(splitPipelineContext('hello')).toEqual({ contexts: [], text: 'hello' });
    const broken = '[PiUI pipeline result — pipeline "x", run r]\nno end';
    expect(splitPipelineContext(broken)).toEqual({ contexts: [], text: broken });
  });

  it('bounds a long result', () => {
    const text = withPipelineContext([{ pipelineName: 'P', runId: 'r', request: 'q', result: 'x'.repeat(30_000) }], 'next');
    expect(text.length).toBeLessThan(25_000);
    expect(text).toContain('(truncated)');
  });
});
