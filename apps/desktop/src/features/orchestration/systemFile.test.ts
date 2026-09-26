import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileGraph, emptyGraph, newGraphNode, newRouterNode } from './agentGraph';
import { parseSystemFile, systemFileToGraph, graphToSystemFile, serializeSystemFile } from './systemFile';

const example = () => JSON.parse(readFileSync(new URL('../../../../../examples/systems/mixed-review.piui.json', import.meta.url), 'utf8'));
describe('portable system files', () => {
  it('round-trips structured mappings and review acceptance without losing local references', () => {
    const file = JSON.parse(readFileSync(new URL('../../../../../examples/systems/structured-review.piui.json', import.meta.url), 'utf8'));
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    const reopened = systemFileToGraph(parseSystemFile(serializeSystemFile(graph)));
    const steps = compileGraph(reopened).pipeline.steps;
    expect(steps[1]!.review).toEqual({field:'accepted',retryFromStepId:steps[0]!.id});
    expect(steps[1]!.requireApproval).toBe(true);
    expect(steps[1]!.inputBindings?.[0]).toEqual({sourceStepId:steps[0]!.id,field:'summary',name:'proposal'});
    file.agents[1].inputBindings[0].field = 'undeclared';
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
  it('accepts Claude Code only in v4, round-trips it and keeps v1-v3 closed', () => {
    const file = JSON.parse(readFileSync(new URL('../../../../../examples/systems/codex-claude-pi-review.piui.json', import.meta.url), 'utf8'));
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    expect(graph.nodes.map((node) => node.profile.harness)).toEqual(['codex', 'claude-code', 'pi']);
    const reopened = parseSystemFile(serializeSystemFile(graph));
    expect(reopened.version).toBe(4);
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
