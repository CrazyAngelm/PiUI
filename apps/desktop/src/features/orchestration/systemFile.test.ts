import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileGraph, emptyGraph, graphIssues, newGraphNode, newRouterNode } from './agentGraph';
import { parseSystemFile, systemFileToGraph, graphToSystemFile, serializeSystemFile, SYSTEM_FILE_UNNAMED_PIPELINE, unresolvedPipelines } from './systemFile';
import { formatIssue, parseIssue, SUBPIPELINE_ISSUE_TEMPLATES } from '../../host-api/subpipelines';

const example = () => JSON.parse(readFileSync(new URL('../../../../../examples/systems/mixed-review.piui.json', import.meta.url), 'utf8'));
const structured = () => JSON.parse(readFileSync(new URL('../../../../../examples/systems/structured-review.piui.json', import.meta.url), 'utf8'));
/** Parsed, deliberately untyped documents that tests corrupt. */
type SystemFileJson = ReturnType<typeof structured>;
describe('portable system files', () => {
  it('round-trips structured mappings and review acceptance without losing local references', () => {
    const file = JSON.parse(readFileSync(new URL('../../../../../examples/systems/structured-review.piui.json', import.meta.url), 'utf8'));
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    const reopened = systemFileToGraph(parseSystemFile(serializeSystemFile(graph)));
    const steps = compileGraph(reopened).pipeline.steps;
    expect(steps[1]!.review).toEqual({field:'accepted',retryFromStepId:steps[0]!.id,maxIterations:3});
    expect(steps[1]!.requireApproval).toBe(true);
    expect(steps[1]!.inputBindings?.[0]).toEqual({sourceStepId:steps[0]!.id,field:'summary',name:'proposal'});
    file.agents[1].inputBindings[0].field = 'undeclared';
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow();
  });
  it('keeps the generated validators self-contained browser modules', () => {
    // Some schema keywords (for example maxLength) make Ajv emit a CommonJS
    // runtime import, which fails in the WebView and in `pnpm system:check`.
    for (const version of [1, 2, 3, 4, 5]) {
      const source = readFileSync(new URL(`../../../../../contracts/system-file-v${version}-validator.mjs`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/\brequire\(/);
    }
  });
  it('round-trips run inputs and review loop limits and keeps legacy versions strict', () => {
    const file = structured();
    file.inputs.push({ name: 'depth', label: 'Depth', kind: 'choice', options: ['quick', 'deep'], defaultValue: 'quick' }, { name: 'budget', label: 'Budget', kind: 'number', defaultValue: 2.5 });
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    expect(graph.inputs).toEqual(file.inputs);
    const text = serializeSystemFile(graph);
    const reopened = parseSystemFile(text);
    expect(reopened.inputs).toEqual(file.inputs);
    expect(reopened.agents[1]!.review).toEqual({ field: 'accepted', retryFromStepId: 'research', maxIterations: 3 });
    expect(compileGraph(systemFileToGraph(reopened)).pipeline.inputs).toEqual(file.inputs);
    expect(compileGraph(systemFileToGraph(reopened)).pipeline.steps[0]!.instructions).toContain('{{input.task}}');
    const plain = example(); plain.version = 4;
    expect(serializeSystemFile(systemFileToGraph(parseSystemFile(JSON.stringify(plain))))).not.toContain('"inputs"');
    const legacy = example(); legacy.version = 3; legacy.inputs = [{ name: 'task', label: 'Task', kind: 'text' }];
    expect(() => parseSystemFile(JSON.stringify(legacy))).toThrow();
    delete legacy.inputs;
    expect(parseSystemFile(JSON.stringify(legacy)).version).toBe(3);
  });
  it.each([
    ['input name', (file: SystemFileJson) => { file.inputs[0].name = 'Task'; }],
    ['duplicate input', (file: SystemFileJson) => { file.inputs.push({ ...file.inputs[0] }); }],
    ['unknown input field', (file: SystemFileJson) => { file.inputs[0].placeholder = 'not allowed'; }],
    ['choice without options', (file: SystemFileJson) => { file.inputs.push({ name: 'depth', label: 'Depth', kind: 'choice' }); }],
    ['mismatched default', (file: SystemFileJson) => { file.inputs.push({ name: 'budget', label: 'Budget', kind: 'number', defaultValue: 'two' }); }],
    ['null default', (file: SystemFileJson) => { file.inputs[0].defaultValue = null; }],
    ['zero review rounds', (file: SystemFileJson) => { file.agents[1].review.maxIterations = 0; }],
    ['21 review rounds', (file: SystemFileJson) => { file.agents[1].review.maxIterations = 21; }],
    ['fractional review rounds', (file: SystemFileJson) => { file.agents[1].review.maxIterations = 1.5; }],
  ])('rejects an invalid %s without dropping it', (_case, change) => {
    const file = structured();
    parseSystemFile(JSON.stringify(file));
    change(file);
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow();
  });
  it('preserves callable-only agents in v4 and rejects them in legacy files', () => {
    const file = example(); file.version = 4; file.connections = [];
    file.agents[1].executionMode = 'callable';
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    expect(compileGraph(graph).pipeline.steps[1]!.executionMode).toBe('callable');
    expect(parseSystemFile(serializeSystemFile(graph)).agents[1]!.executionMode).toBe('callable');
    file.version = 3;
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow();
  });
  it('accepts Hermes only in v3 and preserves v2 compatibility', () => {
    const file = example(); file.version = 2;
    expect(parseSystemFile(JSON.stringify(file)).version).toBe(2);
    file.agents[1].profile.harness = 'hermes';
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow();
    file.version = 3;
    const reopened = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    expect(reopened.nodes[1]!.profile.harness).toBe('hermes');
    expect(parseSystemFile(serializeSystemFile(reopened)).version).toBe(5);
  });
  it('accepts Claude Code only in v4, round-trips it and keeps v1-v3 closed', () => {
    const file = JSON.parse(readFileSync(new URL('../../../../../examples/systems/codex-claude-pi-review.piui.json', import.meta.url), 'utf8'));
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    expect(graph.nodes.map((node) => node.profile.harness)).toEqual(['codex', 'claude-code', 'pi']);
    const reopened = parseSystemFile(serializeSystemFile(graph));
    expect(reopened.version).toBe(5);
    expect(reopened.agents[1]!.profile).toMatchObject({ harness: 'claude-code', reasoning: 'high', permissionMode: 'read-only' });
    expect(compileGraph(systemFileToGraph(reopened)).pipeline.steps.map((step) => step.dependencyStepIds.length)).toEqual([0, 1, 1]);
    for (const version of [1, 2, 3]) {
      expect(() => parseSystemFile(JSON.stringify({ ...file, version })), `v${version}`).toThrow();
    }
    const invalid = (patch: Record<string, unknown>) => {
      const changed = structuredClone(file);
      Object.assign(changed.agents[1].profile, patch);
      return () => parseSystemFile(JSON.stringify(changed));
    };
    expect(invalid({ serviceTier: 'fast' }), 'fast mode can use paid extra usage').toThrow(/speed is not supported/);
    expect(invalid({ reasoning: 'minimal' })).toThrow(/effort level/);
    expect(invalid({ modelProvider: 'openai' })).toThrow(/only Anthropic models/);
    expect(invalid({ resourceRules: [{ kind: 'mcp', id: 'docs', enabled: false }] })).toThrow(/resource kind/);
    expect(invalid({ toolPolicy: { rules: [{ tool: 'Bash', decision: 'allow', enforcement: 'native', mandatory: true }] } }))
      .toThrow(/Bash cannot run/);
    expect(invalid({ toolPolicy: { rules: [{ tool: 'Agent', decision: 'allow', enforcement: 'native', mandatory: true }] } }))
      .toThrow(/unknown native tool/);
  });
  it('upgrades v1 files and preserves separate input requirements in the current version', () => {
    const legacy = example(); legacy.version = 1;
    for (const agent of legacy.agents) delete agent.input;
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(legacy)));
    graph.nodes[1]!.input = 'Changed file paths, test results and unresolved issues.';
    const file = parseSystemFile(serializeSystemFile(graph));
    expect(file.version).toBe(5);
    expect(systemFileToGraph(file).nodes[1]!.input).toBe(graph.nodes[1]!.input);
    expect(file.agents[1]!.task).toBe(graph.nodes[1]!.task);
  });
  it('preserves invocation descriptions and an explicit empty task input override', () => {
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(example())));
    const node = graph.nodes[0]!;
    node.profile = { ...node.profile, whenToCall: 'When independent review is needed', inputInstructions: 'Default input', expectedResult: 'Findings with evidence' };
    node.input = '';
    const reopened = systemFileToGraph(parseSystemFile(serializeSystemFile(graph)));
    expect(reopened.nodes[0]!.profile.whenToCall).toBe(node.profile.whenToCall);
    expect(reopened.nodes[0]!.profile.expectedResult).toBe(node.profile.expectedResult);
    expect(reopened.nodes[0]!.profile.inputInstructions).toBe('Default input');
    expect(compileGraph(reopened).pipeline.steps[0]!.inputInstructions).toBe('');
  });
  it('round-trips mixed harness settings, prompt distinction and positions without native identities', () => {
    const file = example();
    file.version = 4;
    file.agents[0].profile.baseInstructions = '';
    file.agents[0].profile.reasoning = 'high';
    file.agents[0].profile.serviceTier = 'fast';
    file.agents[0].profile.networkAccess = true;
    file.agents[0].profile.resourceRules = [{kind:'mcp',id:'search',enabled:false}];
    file.agents[0].position = {x:0,y:250}; file.inheritTeamConnections = false;
    const original = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    const reopened = systemFileToGraph(parseSystemFile(serializeSystemFile(original)));
    expect(graphToSystemFile(reopened)).toEqual(graphToSystemFile(original));
    expect(reopened.id).not.toBe(original.id);
    expect(reopened.nodes[0]!.profile.id).not.toBe(original.nodes[0]!.profile.id);
    expect(reopened.nodes[0]!.profile.baseInstructions).toBe('');
    expect(reopened.nodes[0]!.profile.networkAccess).toBe(true);
    expect(reopened.nodes[1]!.profile.baseInstructions).toBeUndefined();
  });
  it.each(['version','unknown','duplicate','dangling','cycle','resource','privileges'])('rejects %s without coercing or dropping fields', failure => {
    const file = example();
    if (failure==='version') file.version=99;
    if (failure==='unknown') file.agents[0].profile.apiKey='not-allowed';
    if (failure==='duplicate') file.agents[1].id=file.agents[0].id;
    if (failure==='dangling') file.connections[0].to='absent';
    if (failure==='cycle') file.connections.push({from:'review',to:'research',kind:'result'});
    if (failure==='resource') file.agents[1].profile.resourceRules=[{kind:'mcp',id:'server',enabled:false}];
    if (failure==='privileges') file.connections.push({from:'research',to:'review',kind:'spawn'});
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow();
  });
  it('requires the router discriminator to match its configuration', () => {
    const file = example(); file.version = 4; file.agents[0].router = { mode: 'program', inputStepId: file.agents[1].id, branches: [{ id: 'route', label: 'Route', predicate: { op: 'exists', field: 'result' } }] };
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow(/kind=router/);
    delete file.agents[0].router; file.agents[0].kind = 'router';
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow(/router configuration/);
  });
  it('requires branch IDs only on route connections', () => {
    const file = example(); file.version = 4;
    file.connections[0]!.branchId = 'unexpected';
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow(/Only route connections/);
    file.connections[0]!.kind = 'route';
    delete file.connections[0]!.branchId;
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow(/Route connections need a branch ID/);
  });
  it('allows messaging cycles and equal-privilege delegation while preserving edge direction', () => {
    const file=example(); file.agents[1].profile.harness='codex'; file.agents[1].profile.permissionMode='read-only';
    file.connections.push({from:'research',to:'review',kind:'spawn'}, {from:'research',to:'review',kind:'send'}, {from:'review',to:'research',kind:'send'});
    expect(parseSystemFile(JSON.stringify(file)).connections).toHaveLength(4);
  });
  it('round-trips program routers and branch-specific route edges', () => {
    const graph = emptyGraph(); graph.name = 'Branching';
    const source = newGraphNode(0), router = newRouterNode(1), target = newGraphNode(2);
    source.profile = { ...source.profile, model: 'source-model' }; target.profile = { ...target.profile, model: 'target-model' };
    source.resultFields = [{ name: 'status', kind: 'text' }];
    const branches = router.router!.branches.map((branch, index) => ({ ...branch, label: `Status ${index}`, predicate: { op: 'equals' as const, field: 'status', value: index === 0 ? 'ready' : 'blocked' } }));
    router.router = { ...router.router!, inputStepId: source.id, branches };
    graph.nodes = [source, router, target];
    graph.edges = [{ from: source.id, to: router.id, kind: 'result' }, { from: router.id, to: target.id, kind: 'route', branchId: branches[0]!.id }];
    const reopened = systemFileToGraph(parseSystemFile(serializeSystemFile(graph)));
    expect(reopened.nodes.find(node => node.id === router.id)?.router?.mode).toBe('program');
    expect(reopened.edges.find(edge => edge.kind === 'route')?.branchId).toBe(branches[0]!.id);
  });
});

describe('step executors in system files (v4, orchestration v6.2)', () => {
  const mixed = () => JSON.parse(readFileSync(new URL('../../../../../examples/systems/agent-script-llm.piui.json', import.meta.url), 'utf8'));
  it('round-trips an agent, a script and a single model call without dropping fields', () => {
    const file = mixed();
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    expect(graph.nodes.map(node => node.executor?.type ?? 'agent')).toEqual(['agent', 'script', 'llm']);
    const compiled = compileGraph(graph);
    // The script is host work: no profile and no team member.
    expect(compiled.profiles.map(profile => profile.name)).toEqual(['Dependency audit', 'Audit summary']);
    expect(compiled.team.members.map(member => member.id)).toEqual(['audit', 'summary']);
    const [, count, summary] = compiled.pipeline.steps;
    expect(count?.executor).toEqual(file.agents[1].executor);
    expect(count?.assignedMemberId).toBe('count');
    expect(summary?.executor).toEqual({ type: 'llm' });
    const text = serializeSystemFile(graph);
    const reopened = parseSystemFile(text);
    expect(reopened.agents.map(agent => agent.executor)).toEqual(file.agents.map((agent: { executor?: unknown }) => agent.executor));
    expect(reopened.agents[1]!.executor).toMatchObject({ source: file.agents[1].executor.source, timeoutSeconds: 30 });
    expect(JSON.parse(text).agents[0]).not.toHaveProperty('executor');
  });
  it.each([
    ['an unknown runtime', (file: SystemFileJson) => { file.agents[1].executor.runtime = 'bash'; }],
    ['an unknown executor field', (file: SystemFileJson) => { file.agents[1].executor.cwd = '/tmp'; }],
    ['an llm field', (file: SystemFileJson) => { file.agents[2].executor.model = 'other'; }],
    ['a zero timeout', (file: SystemFileJson) => { file.agents[1].executor.timeoutSeconds = 0; }],
    ['a fractional timeout', (file: SystemFileJson) => { file.agents[1].executor.timeoutSeconds = 1.5; }],
    ['blank source', (file: SystemFileJson) => { file.agents[1].executor.source = '  '; }],
    ['source over 64 KiB', (file: SystemFileJson) => { file.agents[1].executor.source = 'é'.repeat(32 * 1024 + 1); }],
    ['a script router', (file: SystemFileJson) => { file.agents[1].kind = 'router'; }],
    ['a callable script', (file: SystemFileJson) => { file.agents[1].executionMode = 'callable'; }],
    ['script input mappings', (file: SystemFileJson) => { file.agents[1].inputBindings = [{ sourceStepId: 'audit', field: 'dependencies', name: 'list' }]; }],
    ['a script orchestrator', (file: SystemFileJson) => { file.orchestrator = 'count'; }],
    ['messages to a script', (file: SystemFileJson) => { file.connections.push({ from: 'audit', to: 'count', kind: 'send' }); }],
    ['an observed model call', (file: SystemFileJson) => { file.connections.push({ from: 'audit', to: 'summary', kind: 'observe' }); }],
    ['a delegating model call', (file: SystemFileJson) => { file.connections.push({ from: 'summary', to: 'audit', kind: 'spawn' }); }],
    ['a writable model call', (file: SystemFileJson) => { file.agents[2].profile.permissionMode = 'workspace-write'; }],
    ['a networked model call', (file: SystemFileJson) => { file.agents[2].profile.networkAccess = true; }],
    ['a model call with tools', (file: SystemFileJson) => { file.agents[2].profile.harness = 'pi'; delete file.agents[2].profile.serviceTier; file.agents[2].profile.toolPolicy.rules = [{ tool: 'read', decision: 'allow', enforcement: 'native', mandatory: true }]; }],
    ['a model call without a read-only mode', (file: SystemFileJson) => { file.agents[2].profile.harness = 'prime-agent'; }],
    ['a model call on Hermes', (file: SystemFileJson) => { file.agents[2].profile.harness = 'hermes'; delete file.agents[2].profile.serviceTier; }],
    ['only host scripts', (file: SystemFileJson) => { file.agents = [file.agents[1]]; file.connections = []; delete file.orchestrator; }],
  ])('rejects %s without dropping it', (_case, change) => {
    const file = mixed();
    parseSystemFile(JSON.stringify(file));
    change(file);
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow();
  });
  it('keeps executors out of legacy versions', () => {
    const file = mixed(); file.version = 3;
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow();
  });
  it('accepts an explicit agent executor and keeps it', () => {
    const file = mixed(); file.agents[0].executor = { type: 'agent' };
    const reopened = parseSystemFile(serializeSystemFile(systemFileToGraph(parseSystemFile(JSON.stringify(file)))));
    expect(reopened.agents[0]!.executor).toEqual({ type: 'agent' });
  });
});

describe('ACP agents in system files (harness identity v2, orchestration v6.3)', () => {
  const acpReview = () => JSON.parse(readFileSync(new URL('../../../../../examples/systems/codex-gemini-acp-review.piui.json', import.meta.url), 'utf8'));
  it('round-trips an ACP profile with the native permission and agent default model', () => {
    const file = acpReview();
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    expect(graph.nodes.map((node) => node.profile.harness)).toEqual(['codex', 'acp:gemini-cli', 'pi']);
    const reopened = parseSystemFile(serializeSystemFile(graph));
    expect(reopened.version).toBe(5);
    expect(reopened.agents[1]!.profile).toMatchObject({ harness: 'acp:gemini-cli', model: 'default', permissionMode: 'native' });
    expect(compileGraph(systemFileToGraph(reopened)).pipeline.steps.map((step) => step.dependencyStepIds.length)).toEqual([0, 1, 1]);
  });
  it('keeps v1-v3 closed to ACP identities', () => {
    const file = acpReview();
    for (const version of [1, 2, 3]) {
      expect(() => parseSystemFile(JSON.stringify({ ...file, version })), `v${version}`).toThrow();
    }
  });
  it.each([
    ['an invalid descriptor id', { harness: 'acp:Gemini' }, /harness/],
    ['an empty descriptor id', { harness: 'acp:' }, /harness/],
    ['a bare descriptor id', { harness: 'gemini-cli' }, /harness/],
    ['a read-only preset', { permissionMode: 'read-only' }, /unsupported file permissions/],
    ['a speed setting', { serviceTier: 'standard' }, /speed is not supported/],
    ['network access', { networkAccess: true }, /network access/],
    ['a base prompt', { baseInstructions: '' }, /base prompt/],
    ['resource rules', { resourceRules: [{ kind: 'mcp', id: 'docs', enabled: false }] }, /resource kind/],
    ['a native tool rule', { toolPolicy: { rules: [{ tool: 'shell', decision: 'deny', enforcement: 'native', mandatory: true }] } }, /unknown native tool/],
  ])('rejects %s without dropping it', (_case, patch, message) => {
    const file = acpReview();
    Object.assign(file.agents[1].profile, patch);
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow(message);
  });
  it('refuses a single model call on an ACP agent', () => {
    const file = acpReview();
    file.agents[1].executor = { type: 'llm' };
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow(/cannot run a single model call read-only/);
  });
});

describe('sub-pipelines in system files (v5, orchestration v6.7)', () => {
  const development = () => JSON.parse(readFileSync(new URL('../../../../../examples/systems/development-with-testing.piui.json', import.meta.url), 'utf8'));
  const testing = () => JSON.parse(readFileSync(new URL('../../../../../examples/systems/testing.piui.json', import.meta.url), 'utf8'));
  const project = [{ id: 'cmd-testing', name: 'Testing' }, { id: 'cmd-release', name: 'Release check' }];

  it('resolves a pipeline name at import and round-trips steps, mappings and outputs by name', () => {
    const file = development();
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)), project);
    const call = graph.nodes.find((node) => node.id === 'testing');
    expect(call?.executor).toEqual({
      type: 'pipeline',
      launchCommandId: 'cmd-testing',
      inputs: { changes: { kind: 'step', stepId: 'developer', field: 'summary' }, focus: { kind: 'value', value: 'regressions in the changed files' } },
    });
    expect(call?.pipelineName).toBeUndefined();
    expect(graph.outputs).toEqual([
      { name: 'passed', kind: 'boolean', sourceStepId: 'testing', field: 'passed' },
      { name: 'summary', kind: 'text', sourceStepId: 'report' },
    ]);
    const compiled = compileGraph(graph);
    // Host work: no team member and no saved profile.
    expect(compiled.team.members.map((member) => member.id)).toEqual(['developer', 'report']);
    expect(compiled.pipeline.outputs).toEqual(graph.outputs);
    const text = serializeSystemFile(graph, project);
    const reopened = JSON.parse(text);
    expect(reopened.version).toBe(5);
    // Ids are local to a project: the file names the pipeline.
    expect(reopened.agents[1].executor).toEqual(file.agents[1].executor);
    expect(text).not.toContain('cmd-testing');
    expect(reopened.outputs).toEqual(file.outputs);
    expect(graphToSystemFile(systemFileToGraph(parseSystemFile(text), project), project)).toEqual(graphToSystemFile(graph, project));
  });

  it('parses the child example with its declared outputs', () => {
    const file = testing();
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    expect(graph.inputs?.map((input) => input.name)).toEqual(['changes', 'focus']);
    expect(parseSystemFile(serializeSystemFile(graph)).outputs).toEqual(file.outputs);
  });

  it('matches a name case-insensitively only when that is unique', () => {
    const file = development();
    file.agents[1].executor.pipeline = 'testing';
    const lower = systemFileToGraph(parseSystemFile(JSON.stringify(file)), project);
    expect(lower.nodes[1]?.executor).toMatchObject({ launchCommandId: 'cmd-testing' });
    const twice = [...project, { id: 'cmd-other', name: 'TESTING' }];
    const ambiguous = systemFileToGraph(parseSystemFile(JSON.stringify(file)), twice);
    expect(ambiguous.nodes[1]?.executor).toMatchObject({ launchCommandId: '' });
    expect(ambiguous.nodes[1]?.pipelineName).toBe('testing');
    // An exact name wins over case-insensitive ones.
    file.agents[1].executor.pipeline = 'Testing';
    expect(systemFileToGraph(parseSystemFile(JSON.stringify(file)), twice).nodes[1]?.executor).toMatchObject({ launchCommandId: 'cmd-testing' });
  });

  it('keeps an unknown name on the step as an issue that blocks saving, and never invents a pipeline', () => {
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(development())), [{ id: 'cmd-release', name: 'Release check' }]);
    const call = graph.nodes.find((node) => node.id === 'testing');
    expect(call?.executor).toMatchObject({ type: 'pipeline', launchCommandId: '' });
    expect(call?.pipelineName).toBe('Testing');
    const issue = graphIssues(graph).find((item) => item.nodeIds.includes('testing'));
    expect(issue?.message).toBe(formatIssue(SUBPIPELINE_ISSUE_TEMPLATES.unresolved, 'Testing'));
    expect(parseIssue(issue?.message ?? '')).toEqual({ template: SUBPIPELINE_ISSUE_TEMPLATES.unresolved, parameter: 'Testing' });
    expect(unresolvedPipelines(graph)).toEqual(['Testing']);
    // Export keeps the imported name instead of dropping the step.
    expect(JSON.parse(serializeSystemFile(graph)).agents[1].executor.pipeline).toBe('Testing');
    // A step whose pipeline cannot be named is refused.
    const unnamed = { ...graph, nodes: graph.nodes.map((node) => (node.id === 'testing' ? { ...node, pipelineName: undefined } : node)) };
    expect(() => serializeSystemFile(unnamed)).toThrow(SYSTEM_FILE_UNNAMED_PIPELINE);
  });

  it('imports v4 files unchanged and exports them as v5', () => {
    const file = JSON.parse(readFileSync(new URL('../../../../../examples/systems/agent-script-llm.piui.json', import.meta.url), 'utf8'));
    expect(file.version).toBe(4);
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    const exported = JSON.parse(serializeSystemFile(graph));
    expect(exported.version).toBe(5);
    expect(exported).not.toHaveProperty('outputs');
    expect(exported.agents.map((agent: { executor?: unknown }) => agent.executor)).toEqual(file.agents.map((agent: { executor?: unknown }) => agent.executor));
    expect(exported.agents.map((agent: { task: string }) => agent.task)).toEqual(file.agents.map((agent: { task: string }) => agent.task));
    expect(exported.connections).toEqual(file.connections);
    // Sub-pipelines and outputs stay v5-only.
    const v4 = development(); v4.version = 4;
    expect(() => parseSystemFile(JSON.stringify(v4))).toThrow();
    const outputsOnly = testing(); outputsOnly.version = 4;
    expect(() => parseSystemFile(JSON.stringify(outputsOnly))).toThrow();
  });

  it.each([
    ['a launch command id instead of a name', (file: SystemFileJson) => { file.agents[1].executor.launchCommandId = 'cmd-testing'; }],
    ['a blank pipeline name', (file: SystemFileJson) => { file.agents[1].executor.pipeline = ' '; }],
    ['an input name that is not an identifier', (file: SystemFileJson) => { file.agents[1].executor.inputs.Changes = { kind: 'value', value: 'x' }; }],
    ['a step source by step id', (file: SystemFileJson) => { file.agents[1].executor.inputs.changes = { kind: 'step', stepId: 'developer' }; }],
    ['an unknown source kind', (file: SystemFileJson) => { file.agents[1].executor.inputs.changes = { kind: 'secret', name: 'x' }; }],
    ['a source that is not a direct upstream agent', (file: SystemFileJson) => { file.agents[1].executor.inputs.changes = { kind: 'step', agent: 'report' }; }],
    ['a field the upstream agent does not declare', (file: SystemFileJson) => { file.agents[1].executor.inputs.changes.field = 'undeclared'; }],
    ['a run input the file does not declare', (file: SystemFileJson) => { file.agents[1].executor.inputs.focus = { kind: 'input', name: 'missing' }; }],
    ['input mappings on a sub-pipeline', (file: SystemFileJson) => { file.agents[1].inputBindings = [{ sourceStepId: 'developer', field: 'summary', name: 'summary' }]; }],
    ['a callable sub-pipeline', (file: SystemFileJson) => { file.agents[1].executionMode = 'callable'; }],
    ['a sub-pipeline orchestrator', (file: SystemFileJson) => { file.orchestrator = 'testing'; }],
    ['a sub-pipeline router', (file: SystemFileJson) => { file.agents[1].kind = 'router'; }],
    ['an output of an unknown agent', (file: SystemFileJson) => { file.outputs[0].agent = 'absent'; }],
    ['an output with an undeclared field', (file: SystemFileJson) => { file.outputs[0].field = 'undeclared'; }],
    ['an output name that is not an identifier', (file: SystemFileJson) => { file.outputs[0].name = 'Passed'; }],
    ['a duplicate output name', (file: SystemFileJson) => { file.outputs.push({ ...file.outputs[0] }); }],
    ['a whole-text output that is not text', (file: SystemFileJson) => { file.outputs[1].kind = 'number'; }],
    ['an output by step id', (file: SystemFileJson) => { file.outputs[0].sourceStepId = 'testing'; }],
    ['33 outputs', (file: SystemFileJson) => { file.outputs = Array.from({ length: 33 }, (_, index) => ({ name: `out${index}`, kind: 'text', agent: 'report' })); }],
  ])('rejects %s without dropping it', (_case, change) => {
    const file = development();
    parseSystemFile(JSON.stringify(file));
    change(file);
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow();
  });
});
