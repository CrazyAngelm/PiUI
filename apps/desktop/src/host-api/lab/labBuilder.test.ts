import { describe, expect, it } from 'vitest';
import { applyProposal, builderEnvelope, readProposal } from '../../app/pipelines/assistant/builderPrompt';
import { emptyGraph, newGraphNode } from '../../features/orchestration/agentGraph';
import { graphToSystemFile } from '../../features/orchestration/systemFile';
import { builderAnswer } from './labBuilder';

const harnesses = [{ harness: 'codex', label: 'Codex', models: ['gpt-lab-5-codex'] }];

describe('lab pipeline assistant', () => {
  it('proposes a valid bounded review loop for an empty draft', () => {
    const prompt = builderEnvelope({ first: true, draftJson: JSON.stringify(graphToSystemFile(emptyGraph())), problems: [], harnesses, text: 'Build a feature' });
    const proposal = readProposal(builderAnswer(prompt));
    expect(proposal?.ok).toBe(true);
    if (!proposal?.ok) return;
    expect(proposal.file.agents.map((agent) => agent.id)).toEqual(['developer', 'tester', 'reviewer']);
    expect(proposal.file.agents[2]?.review).toEqual({ field: 'approved', retryFromStepId: 'developer', maxIterations: 3 });
  });

  it('adds a reviewer to an existing draft and keeps it applicable in place', () => {
    const node = { ...newGraphNode(0), id: 'writer', task: 'Write the docs' };
    node.profile = { ...node.profile, name: 'Writer', model: 'gpt-lab-5-codex' };
    const draft = { ...emptyGraph(), name: 'Docs', nodes: [node], edges: [] };
    const prompt = builderEnvelope({ first: false, draftJson: JSON.stringify(graphToSystemFile(draft)), problems: [], harnesses, text: 'Add a review' });
    const proposal = readProposal(builderAnswer(prompt));
    expect(proposal?.ok).toBe(true);
    if (!proposal?.ok) return;
    const next = applyProposal(draft, proposal.file);
    expect(next.id).toBe(draft.id);
    expect(next.nodes.map((item) => item.id)).toEqual(['writer', 'reviewer']);
    expect(next.edges).toEqual([{ from: 'writer', to: 'reviewer', kind: 'result' }]);
  });
});
