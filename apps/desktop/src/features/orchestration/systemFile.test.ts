import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSystemFile, systemFileToGraph, graphToSystemFile, serializeSystemFile } from './systemFile';

const example = () => JSON.parse(readFileSync(new URL('../../../../../examples/systems/mixed-review.piui.json', import.meta.url), 'utf8'));
describe('portable system files', () => {
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
    if (failure==='version') file.version=2;
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
