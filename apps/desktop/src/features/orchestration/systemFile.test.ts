import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileGraph } from './agentGraph';
import { parseSystemFile, systemFileToGraph, graphToSystemFile, serializeSystemFile } from './systemFile';

const example = () => JSON.parse(readFileSync(new URL('../../../../../examples/systems/mixed-review.piui.json', import.meta.url), 'utf8'));
describe('portable system files', () => {
  it('accepts Hermes only in v3 and preserves v2 compatibility', () => {
    const file = example(); file.version = 2;
    expect(parseSystemFile(JSON.stringify(file)).version).toBe(2);
    file.agents[1].profile.harness = 'hermes';
    expect(() => parseSystemFile(JSON.stringify(file))).toThrow();
    file.version = 3;
    const reopened = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    expect(reopened.nodes[1]!.profile.harness).toBe('hermes');
    expect(parseSystemFile(serializeSystemFile(reopened)).version).toBe(3);
  });
  it('upgrades v1 files and preserves separate input requirements in the current version', () => {
    const legacy = example(); legacy.version = 1;
    for (const agent of legacy.agents) delete agent.input;
    const graph = systemFileToGraph(parseSystemFile(JSON.stringify(legacy)));
    graph.nodes[1]!.input = 'Changed file paths, test results and unresolved issues.';
    const file = parseSystemFile(serializeSystemFile(graph));
    expect(file.version).toBe(3);
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
    file.agents[0].profile.baseInstructions = '';
    file.agents[0].profile.reasoning = 'high';
    file.agents[0].profile.serviceTier = 'fast';
    file.agents[0].profile.resourceRules = [{kind:'mcp',id:'search',enabled:false}];
    file.agents[0].position = {x:0,y:250}; file.inheritTeamConnections = false;
    const original = systemFileToGraph(parseSystemFile(JSON.stringify(file)));
    const reopened = systemFileToGraph(parseSystemFile(serializeSystemFile(original)));
    expect(graphToSystemFile(reopened)).toEqual(graphToSystemFile(original));
    expect(reopened.id).not.toBe(original.id);
    expect(reopened.nodes[0]!.profile.id).not.toBe(original.nodes[0]!.profile.id);
    expect(reopened.nodes[0]!.profile.baseInstructions).toBe('');
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
  it('allows messaging cycles and equal-privilege delegation while preserving edge direction', () => {
    const file=example(); file.agents[1].profile.harness='codex'; file.agents[1].profile.permissionMode='read-only';
    file.connections.push({from:'research',to:'review',kind:'spawn'}, {from:'research',to:'review',kind:'send'}, {from:'review',to:'research',kind:'send'});
    expect(parseSystemFile(JSON.stringify(file)).connections).toHaveLength(4);
  });
});
