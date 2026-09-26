import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentProfile, PipelineStep, RunDefinitionSnapshot } from '../../../../contracts/orchestration-v6';
import {
  boundedText, dependencyOutputText, EXECUTOR_REASONS, executorAuthorityIssue, executorKind, failureDetail, failureWithDetail,
  MAX_FAILURE_DETAIL_BYTES, MAX_SCRIPT_SOURCE_BYTES, MAX_SCRIPT_STDOUT_BYTES, resultFieldIssues, resultValueIssue,
  SCRIPT_FAILURE_CODES, scriptResult, scriptStdinDocument, stepExecutorIssue,
} from './stepExecutors';

/** The Rust authority these helpers mirror. */
const rust = readFileSync(new URL('../../../../crates/piui-orchestration/src/executors.rs', import.meta.url), 'utf8');

const script = (patch: Partial<PipelineStep> = {}): PipelineStep => ({
  id: 'metrics', name: 'Metrics', assignedMemberId: 'metrics', instructions: '', dependencyStepIds: ['plan'],
  executor: { type: 'script', runtime: 'node', source: 'console.log(1)', timeoutSeconds: 30 }, ...patch,
});

const caller: AgentProfile = {
  id: 'caller', name: 'Caller', harness: 'pi', model: 'model', permissionMode: 'read-only', instructions: '',
  toolPolicy: { rules: [{ tool: 'bash', decision: 'deny', enforcement: 'native', mandatory: true }] },
  resourceRules: [{ kind: 'skill', id: 'docs', enabled: false }], allowedSpawnProfileIds: [],
};

function snapshot(patch: { profile?: Partial<AgentProfile>; team?: Partial<RunDefinitionSnapshot['team']> } = {}): RunDefinitionSnapshot {
  return {
    profiles: [{ ...caller, ...patch.profile }],
    team: { id: 'team', name: 'Team', members: [{ id: 'summarizer', profileId: 'caller' }], sendEdges: [], observeEdges: [], orchestratorMemberId: 'summarizer', ...patch.team },
    pipeline: { id: 'pipeline', name: 'Pipeline', steps: [] },
  };
}

const llm: PipelineStep = {
  id: 'summary', name: 'Summary', assignedMemberId: 'summarizer', instructions: 'Summarize.', dependencyStepIds: [], executor: { type: 'llm' },
};

describe('step executor mirror (v6.2)', () => {
  it('uses the exact Rust reasons and failure codes', () => {
    for (const reason of Object.values(EXECUTOR_REASONS)) expect(rust).toContain(JSON.stringify(reason));
    for (const code of Object.values(SCRIPT_FAILURE_CODES)) expect(rust).toContain(`"${code}"`);
    expect(rust).toContain('MAX_SCRIPT_SOURCE_BYTES: usize = 64 * 1024');
    expect(rust).toContain('MAX_SCRIPT_STDOUT_BYTES: usize = 256 * 1024');
    expect(rust).toContain('MAX_FAILURE_DETAIL_BYTES: usize = 2 * 1024');
    expect([MAX_SCRIPT_SOURCE_BYTES, MAX_SCRIPT_STDOUT_BYTES, MAX_FAILURE_DETAIL_BYTES]).toEqual([65_536, 262_144, 2_048]);
  });

  it('checks script source, timeout and agent-only features like validate_step_executor', () => {
    expect(executorKind({})).toBe('agent');
    expect(stepExecutorIssue(script())).toBeUndefined();
    const executor = script().executor as Extract<PipelineStep['executor'], { type: 'script' }>;
    expect(stepExecutorIssue(script({ executor: { ...executor, source: ' \n' } }))).toBe(EXECUTOR_REASONS.source);
    expect(stepExecutorIssue(script({ executor: { ...executor, source: 'é'.repeat(MAX_SCRIPT_SOURCE_BYTES / 2) } }))).toBeUndefined();
    expect(stepExecutorIssue(script({ executor: { ...executor, source: 'é'.repeat(MAX_SCRIPT_SOURCE_BYTES / 2 + 1) } })))
      .toBe(EXECUTOR_REASONS.sourceSize);
    for (const timeoutSeconds of [0, 3601, 1.5]) {
      expect(stepExecutorIssue(script({ executor: { ...executor, timeoutSeconds } }))).toBe(EXECUTOR_REASONS.timeout);
    }
    expect(stepExecutorIssue(script({ executionMode: 'callable' }))).toBe(EXECUTOR_REASONS.callable);
    expect(stepExecutorIssue(script({ inputBindings: [{ sourceStepId: 'plan', field: 'a', name: 'b' }] }))).toBe(EXECUTOR_REASONS.bindings);
    expect(stepExecutorIssue({ ...llm, router: { mode: 'agent', inputStepId: 'plan', branches: [] } })).toBe(EXECUTOR_REASONS.router);
  });

  it('keeps scripts outside the team and llm profiles at least authority', () => {
    expect(executorAuthorityIssue(snapshot(), script())).toBeUndefined();
    expect(executorAuthorityIssue(snapshot(), script({ assignedMemberId: 'summarizer' }))).toBe(EXECUTOR_REASONS.member);
    expect(executorAuthorityIssue(snapshot(), llm)).toBeUndefined();
    const cases: [Parameters<typeof snapshot>[0], string][] = [
      [{ team: { sendEdges: [{ fromMemberId: 'summarizer', toMemberId: 'summarizer' }] } }, EXECUTOR_REASONS.messages],
      [{ team: { observeEdges: [{ fromMemberId: 'summarizer', toMemberId: 'summarizer' }] } }, EXECUTOR_REASONS.messages],
      [{ profile: { permissionMode: 'workspace-write' } }, EXECUTOR_REASONS.readOnly],
      [{ profile: { networkAccess: true } }, EXECUTOR_REASONS.network],
      [{ profile: { toolPolicy: { rules: [{ tool: 'read', decision: 'allow', enforcement: 'native', mandatory: true }] } } }, EXECUTOR_REASONS.tools],
      [{ profile: { resourceRules: [{ kind: 'mcp', id: 'docs', enabled: true }] } }, EXECUTOR_REASONS.resources],
      [{ profile: { allowedSpawnProfileIds: ['caller'] } }, EXECUTOR_REASONS.spawns],
    ];
    for (const [patch, reason] of cases) expect(executorAuthorityIssue(snapshot(patch), llm)).toBe(reason);
  });

  it('turns stdout into data, text or the native result codes like complete_script_task', () => {
    expect(scriptResult([], '{"files": 3}\r\n')).toEqual({ status: 'succeeded', data: { files: 3 } });
    expect(scriptResult([], '3 files\n')).toEqual({ status: 'succeeded', output: { text: '3 files\n' } });
    expect(scriptResult([], '[1, 2]')).toEqual({ status: 'succeeded', output: { text: '[1, 2]' } });
    expect(scriptResult([], '{"files": 3}', true)).toEqual({ status: 'succeeded', output: { text: '{"files": 3}', truncated: true } });
    const fields = [{ name: 'files', kind: 'number' as const }];
    expect(scriptResult(fields, '{"files": 3}')).toEqual({ status: 'succeeded', data: { files: 3 } });
    expect(scriptResult(fields, '3 files')).toEqual({ status: 'failed', failure: { code: 'result-invalid-json' } });
    expect(scriptResult(fields, '[3]')).toEqual({ status: 'failed', failure: { code: 'result-not-object' } });
    expect(scriptResult(fields, '{}')).toEqual({ status: 'failed', failure: { code: 'result-missing-field' } });
    expect(scriptResult(fields, '{"files": "3"}')).toEqual({ status: 'failed', failure: { code: 'result-field-type' } });
    expect(scriptResult(fields, '{"files": 3}', true)).toEqual({ status: 'failed', failure: { code: 'result-invalid-json' } });
    const long = scriptResult([], 'é'.repeat(MAX_SCRIPT_STDOUT_BYTES));
    expect(long.status === 'succeeded' && long.output?.truncated).toBe(true);
    expect(long.status === 'succeeded' ? new TextEncoder().encode(long.output?.text).length : 0).toBe(MAX_SCRIPT_STDOUT_BYTES);
  });

  it('lists every failing result field like result_field_issues, first one as the run code', () => {
    const fields = [
      { name: 'files', kind: 'number' as const },
      { name: 'summary', kind: 'text' as const },
      { name: 'passed', kind: 'boolean' as const },
    ];
    const value = { files: '3', passed: true };
    expect(resultFieldIssues(fields, value)).toEqual([
      { field: 'files', code: 'result-field-type' },
      { field: 'summary', code: 'result-missing-field' },
    ]);
    expect(resultValueIssue(fields, value)).toBe('result-field-type');
    expect(resultFieldIssues(fields, { files: 3, summary: 'ok', passed: false })).toEqual([]);
    expect(rust).toContain('pub fn script_stdout_result(');
  });

  it('bounds failure detail to whole last lines without control characters', () => {
    expect(failureDetail('  short \r\n')).toBe('short');
    const detail = failureDetail(`${'noise line\n'.repeat(400)}TypeError: boom\u001b[0m\r\n`);
    expect(new TextEncoder().encode(detail).length).toBeLessThanOrEqual(MAX_FAILURE_DETAIL_BYTES);
    expect(detail.startsWith('noise line')).toBe(true);
    expect(detail.endsWith('TypeError: boom[0m')).toBe(true);
    expect(failureWithDetail('script-timeout', ' \n ')).toEqual({ code: 'script-timeout' });
    expect(boundedText('ab€', 3)).toEqual({ text: 'ab', truncated: true });
  });

  it('builds the script stdin document and native dependency context', () => {
    const document = scriptStdinDocument(
      {
        inputs: { task: 'demo' },
        tasks: [
          { stepId: 'plan', status: 'succeeded', revision: 2, resultReference: { sessionId: 's' }, resultData: { steps: 2 } },
          { stepId: 'count', status: 'succeeded', revision: 2, output: { text: '3 files' } },
        ],
      },
      { ...script(), dependencyStepIds: ['plan', 'count'] },
      (id) => (id === 'plan' ? 'Plan text' : null),
    );
    expect(document).toEqual({
      inputs: { task: 'demo' },
      dependencies: { plan: { text: 'Plan text', data: { steps: 2 } }, count: { text: '3 files', data: null } },
      step: { id: 'metrics', name: 'Metrics' },
    });
    expect(dependencyOutputText({ text: '3 files' }, undefined)).toBe('3 files');
    expect(dependencyOutputText(undefined, { files: 3, noise: true }, [{ field: 'files', name: 'fileCount' }])).toBe('{"fileCount":3}');
  });
});
