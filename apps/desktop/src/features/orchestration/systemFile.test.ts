import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileGraph, emptyGraph, newGraphNode, newRouterNode } from './agentGraph';
import { parseSystemFile, systemFileToGraph, graphToSystemFile, serializeSystemFile } from './systemFile';

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
    for (const version of [1, 2, 3, 4]) {
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
    expect(parseSystemFile(serializeSystemFile(reopened)).version).toBe(4);
  });
  it('upgrades v1 files and preserves separate input requirements in the current version', () => {
    const legacy = example(); legacy.version = 1;
    for (const agent of legacy.agents) delete agent.input;
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(legacy)));
    graph.nodes[1]!.input = 'Changed file paths, test results and unresolved issues.';
    const file = parseSystemFile(serializeSystemFile(graph));
    expect(file.version).toBe(4);
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
