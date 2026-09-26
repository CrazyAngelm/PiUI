import { describe, expect, it } from 'vitest';
import { emptyGraph, newGraphNode, type AgentGraph } from '../../../features/orchestration/agentGraph';
import { graphToSystemFile } from '../../../features/orchestration/systemFile';
import { applyProposal, builderEnvelope, extractProposal, isEmptyChange, readProposal, stripEnvelope, summarizeChange } from './builderPrompt';

function draft(): AgentGraph {
  const planner = { ...newGraphNode(0), id: 'planner' };
  const developer = { ...newGraphNode(1), id: 'developer' };
  planner.profile = { ...planner.profile, name: 'Planner', model: 'gpt-5' };
  developer.profile = { ...developer.profile, name: 'Developer', model: 'gpt-5' };
  return { ...emptyGraph(), name: 'Feature', nodes: [planner, developer], edges: [{ from: 'planner', to: 'developer', kind: 'result' }] };
}

describe('pipeline assistant prompt', () => {
  it('wraps the draft as context and shows only what the person typed', () => {
    const text = builderEnvelope({ first: true, draftJson: '{"a":1}', problems: ['Missing task'], harnesses: [{ harness: 'codex', label: 'Codex', models: ['gpt-5'] }], text: '  Add a tester  ' });
    expect(text.startsWith('<piui-builder-context>')).toBe(true);
    expect(text).toContain('You are the PiUI pipeline assistant');
    expect(text).toContain('- codex (Codex): gpt-5');
    expect(text).toContain('- Missing task');
    expect(stripEnvelope(text)).toBe('Add a tester');
    expect(builderEnvelope({ first: false, draftJson: '{}', problems: [], harnesses: [], text: 'x' })).not.toContain('You are the PiUI pipeline assistant');
    expect(stripEnvelope('plain question')).toBe('plain question');
  });

  it('reads the last PiUI system block and keeps the prose for display', () => {
    const file = JSON.stringify(graphToSystemFile(draft()));
    const answer = `Added a reviewer.\n\n\`\`\`json\n{"not":"a system"}\n\`\`\`\n\n\`\`\`json\n${file}\n\`\`\`\nDone.`;
    const proposal = extractProposal(answer);
    expect(proposal?.json).toBe(file);
    expect(proposal?.prose).toContain('Added a reviewer.');
    expect(proposal?.prose).toContain('Done.');
    expect(proposal?.prose).not.toContain('piui-system');
    expect(extractProposal('No JSON here')).toBeUndefined();
  });

  it('validates proposals with the import parser', () => {
    const good = readProposal(`\`\`\`json\n${JSON.stringify(graphToSystemFile(draft()))}\n\`\`\``);
    expect(good?.ok).toBe(true);
    const bad = readProposal('```json\n{"format":"piui-system","version":4,"name":"x","agents":[{"id":"a"}],"connections":[]}\n```');
    expect(bad?.ok).toBe(false);
  });

  it('applies a proposal in place, keeping the draft identity and surviving profiles', () => {
    const current = draft();
    const file = graphToSystemFile(current);
    file.agents.push({ ...file.agents[1]!, id: 'reviewer', profile: { ...file.agents[1]!.profile, name: 'Reviewer' }, task: 'Review' });
    file.connections.push({ from: 'developer', to: 'reviewer', kind: 'result' });
    const next = applyProposal(current, file);
    expect([next.id, next.teamId, next.pipelineId]).toEqual([current.id, current.teamId, current.pipelineId]);
    expect(next.nodes.find((node) => node.id === 'planner')?.profile.id).toBe(current.nodes[0]?.profile.id);
    expect(next.nodes.find((node) => node.id === 'reviewer')?.profile.id).not.toBe(current.nodes[1]?.profile.id);
    const summary = summarizeChange(current, next);
    expect(summary).toMatchObject({ added: ['Reviewer'], removed: [], changed: [], connectionsAdded: 1, connectionsRemoved: 0, renamed: false });
    expect(isEmptyChange(summarizeChange(current, applyProposal(current, graphToSystemFile(current))))).toBe(true);
  });
});
