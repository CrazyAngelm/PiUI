/**
 * Starter topologies. Each template produces a normal editable graph with
 * real edges and settings — nothing hidden is attached to the name.
 */
import { emptyGraph, newGraphNode, newRouterNode, type AgentGraph, type GraphEdge, type GraphNode } from '../../features/orchestration/agentGraph';
import type { AgentProfile, PipelineInput } from '../../host-api/orchestrationClient';
import { profileForHarness } from '../../harness-adapters/normalize';

export type TemplateId = 'chain' | 'parallel' | 'orchestrator' | 'review' | 'router';

export interface TemplateInfo {
  id: TemplateId;
  title: string;
  description: string;
}

export const TEMPLATES: readonly TemplateInfo[] = [
  { id: 'chain', title: 'Chain', description: 'Plan → build → review, each step gets the previous result' },
  { id: 'parallel', title: 'Parallel research', description: 'Two independent investigations, then one synthesis' },
  { id: 'orchestrator', title: 'Orchestrator and helpers', description: 'A lead agent decides how many workers and testers to start' },
  { id: 'review', title: 'Review loop', description: 'A reviewer sends work back until it is approved' },
  { id: 'router', title: 'Classify and route', description: 'A classifier picks which specialist continues' },
];

type Translate = (value: string) => string;

function agent(index: number, harness: AgentProfile['harness'], name: string, task: string, x: number, y: number): GraphNode {
  const node = newGraphNode(index);
  node.profile = { ...profileForHarness(node.profile, harness), name };
  node.task = task;
  node.x = x;
  node.y = y;
  return node;
}

export function buildTemplate(id: TemplateId, harness: AgentProfile['harness'], t: Translate): AgentGraph {
  const graph = emptyGraph();
  const edges: GraphEdge[] = [];
  let nodes: GraphNode[] = [];
  switch (id) {
    case 'chain': {
      const plan = agent(0, harness, t('Planner'), t('Break the goal into concrete steps with acceptance criteria.'), 40, 120);
      const build = agent(1, harness, t('Builder'), t('Carry out the plan. Report what changed and how it was verified.'), 340, 120);
      const review = agent(2, harness, t('Reviewer'), t('Check the result against the acceptance criteria. List only real problems with evidence.'), 640, 120);
      nodes = [plan, build, review];
      edges.push({ from: plan.id, to: build.id, kind: 'result' }, { from: build.id, to: review.id, kind: 'result' });
      break;
    }
    case 'parallel': {
      const first = agent(0, harness, t('Researcher A'), t('Investigate the first angle of the question. Cite sources.'), 40, 40);
      const second = agent(1, harness, t('Researcher B'), t('Investigate the second angle of the question. Cite sources.'), 40, 240);
      const synth = agent(2, harness, t('Synthesis'), t('Combine both findings into one answer. Note disagreements.'), 360, 140);
      nodes = [first, second, synth];
      edges.push({ from: first.id, to: synth.id, kind: 'result' }, { from: second.id, to: synth.id, kind: 'result' });
      break;
    }
    case 'orchestrator': {
      const lead = agent(0, harness, t('Orchestrator'), t('Split the goal into tasks. Start as many workers and testers as needed, wait for their results, and decide when the goal is met.'), 40, 140);
      const worker = agent(1, harness, t('Worker'), t('Complete the assigned task and report the result with evidence.'), 380, 40);
      const tester = agent(2, harness, t('Tester'), t('Test the delivered work and report failures with reproduction steps.'), 380, 260);
      worker.executionMode = 'callable';
      worker.profile = { ...worker.profile, whenToCall: t('For one well-defined implementation task.') };
      tester.executionMode = 'callable';
      tester.profile = { ...tester.profile, whenToCall: t('To verify delivered work independently.') };
      nodes = [lead, worker, tester];
      edges.push({ from: lead.id, to: worker.id, kind: 'spawn' }, { from: lead.id, to: tester.id, kind: 'spawn' });
      break;
    }
    case 'review': {
      const dev = agent(0, harness, t('Developer'), t('Implement the change. If reviewer feedback is attached, address every point.'), 40, 120);
      const review = agent(1, harness, t('Reviewer'), t('Review the change. Set approved to true only when nothing blocking remains.'), 360, 120);
      review.resultFields = [
        { name: 'approved', kind: 'boolean' },
        { name: 'feedback', kind: 'text' },
      ];
      // Explicit, visible bound: a person decides after three rejected rounds.
      review.review = { field: 'approved', retryFromStepId: dev.id, maxIterations: 3 };
      nodes = [dev, review];
      edges.push({ from: dev.id, to: review.id, kind: 'result' });
      break;
    }
    case 'router': {
      const classify = agent(0, harness, t('Classifier'), t('Classify the request. Return the field category as bug or feature.'), 40, 140);
      classify.resultFields = [{ name: 'category', kind: 'text' }];
      const router = newRouterNode(1);
      router.profile = { ...router.profile, name: t('Route by category') };
      router.x = 340;
      router.y = 120;
      const [bugBranch, featureBranch] = router.router!.branches;
      router.router = {
        mode: 'program',
        inputStepId: classify.id,
        branches: [
          { ...bugBranch!, label: t('Bug'), predicate: { op: 'equals', field: 'category', value: 'bug' } },
          { ...featureBranch!, label: t('Feature'), predicate: { op: 'equals', field: 'category', value: 'feature' } },
        ],
      };
      const fix = agent(2, harness, t('Bug fixer'), t('Reproduce and fix the bug. Add a regression test.'), 660, 40);
      const build = agent(3, harness, t('Feature builder'), t('Design and build the feature with tests.'), 660, 260);
      nodes = [classify, router, fix, build];
      edges.push(
        { from: classify.id, to: router.id, kind: 'result' },
        { from: router.id, to: fix.id, kind: 'route', branchId: bugBranch!.id },
        { from: router.id, to: build.id, kind: 'route', branchId: featureBranch!.id },
      );
      break;
    }
  }
  // Every template asks for its goal when it starts; agents receive it as run input.
  const inputs: PipelineInput[] = [
    {
      name: 'task',
      label: id === 'router' ? t('Request to classify') : id === 'parallel' ? t('Question to research') : t('What should the pipeline do?'),
      kind: 'long-text',
      required: true,
    },
  ];
  return { ...graph, name: t(TEMPLATES.find((item) => item.id === id)?.title ?? 'Pipeline'), inputs, nodes, edges };
}
