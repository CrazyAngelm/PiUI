/**
 * The pipeline assistant is an ordinary native chat. PiUI wraps each request
 * with the current draft and reads proposals back through the same parser as
 * JSON import, so a proposal is only ever a new draft for the person to apply.
 */
import type { AgentGraph, GraphEdge } from '../../../features/orchestration/agentGraph';
import { parseSystemFile, systemFileToGraph, type SystemFile } from '../../../features/orchestration/systemFile';

export const CONTEXT_OPEN = '<piui-builder-context>';
export const CONTEXT_CLOSE = '</piui-builder-context>';

export interface HarnessChoice {
  harness: string;
  label: string;
  models: string[];
}

export interface EnvelopeInput {
  first: boolean;
  draftJson: string;
  problems: readonly string[];
  harnesses: readonly HarnessChoice[];
  text: string;
}

const BRIEF = `You are the PiUI pipeline assistant. PiUI runs graphs of native coding agents (Codex, Claude Code, Pi, Prime, Hermes). You design and edit such a graph together with the person; you never start runs yourself. The person applies your proposal to their editor draft, checks it and runs it.

How to answer:
- Reply in the person's language. Be brief: say what you changed and why in at most 6 bullets.
- When you propose a pipeline, end your reply with the COMPLETE updated system as exactly one \`\`\`json fenced block (format "piui-system", version 4). Never send partial JSON or several JSON blocks.
- If something essential is unclear, ask one short question instead of guessing and do not output JSON.

Format (portable PiUI system v4):
{"format":"piui-system","version":4,"name":"…","agents":[…],"connections":[…]}
- agents[]: {"id","profile","task", optional "kind":"router", "input", "executionMode":"callable", "resultFields", "review", "requireApproval", "router", "position":{"x","y"}}
- profile: {"name","harness","model","permissionMode","instructions","toolPolicy":{"rules":[]}, optional "reasoning" (off|minimal|low|medium|high|xhigh|max), "serviceTier" (standard|fast), "whenToCall","inputInstructions","expectedResult"}
- permissionMode: read-only | workspace-write | full-access | native. Use the least authority that can do the job.
- connections[]: {"from","to","kind"} with kind result (the next agent waits for and receives the result), route (router branch, needs "branchId"), send (may message), observe (may watch), spawn (may start instances of a callable role).
- resultFields: [{"name","kind"}] with kind text|number|boolean|text-list|artifact, when the next step needs structured data.
- review loop: on the reviewer {"review":{"field":"approved","retryFromStepId":"<upstream agent id>","maxIterations":3}} plus a boolean result field "approved". Always bound loops with maxIterations.
- An orchestrator that decides how many workers/testers to start: callable roles ("executionMode":"callable", profile.whenToCall/inputInstructions/expectedResult) plus spawn connections from the orchestrator to each role.
- Routers: {"kind":"router","router":{"mode":"program"|"agent","inputStepId":"<the single upstream agent>","branches":[{"id","label","predicate"?}]}}; agent-mode routers pick branches themselves.

Design rules:
- Start from the smallest graph that can produce and verify the outcome. Add a node only for a different executor (harness, model, rights), an independent check, a change of control flow, or a result several nodes need. Otherwise put the step inside one agent's task.
- Keep ids of agents you keep, and their positions. New ids: short kebab-case. Place new agents left to right about 300 px apart.
- "model" is required. Use only the models listed below for each harness; if a harness lists none, write "REPLACE_WITH_AVAILABLE_MODEL" and tell the person to pick one. Never invent models, tools, skills or MCP servers.
- Tasks are concrete: inputs, responsibility, expected output, how to verify, when to stop. Use {{input.<name>}} to insert a run input.`;

export function builderEnvelope({ first, draftJson, problems, harnesses, text }: EnvelopeInput): string {
  const lines: string[] = [CONTEXT_OPEN];
  if (first) lines.push(BRIEF, '');
  lines.push('Available harnesses and models:');
  for (const choice of harnesses) {
    lines.push(`- ${choice.harness} (${choice.label}): ${choice.models.length ? choice.models.join(', ') : 'no models listed'}`);
  }
  lines.push('', 'Current editor draft:', '```json', draftJson.trim(), '```');
  lines.push('', problems.length ? `Problems reported by Check:\n${problems.map((problem) => `- ${problem}`).join('\n')}` : 'Check reports no problems.');
  lines.push(CONTEXT_CLOSE, '', text.trim());
  return lines.join('\n');
}

/** What the person typed, without the context PiUI added. */
export function stripEnvelope(text: string): string {
  const close = text.lastIndexOf(CONTEXT_CLOSE);
  return close >= 0 && text.trimStart().startsWith(CONTEXT_OPEN) ? text.slice(close + CONTEXT_CLOSE.length).trim() : text;
}

export interface ProposalText {
  json: string;
  /** The answer with the JSON block removed, for display. */
  prose: string;
}

/** The last fenced JSON block that looks like a PiUI system file. */
export function extractProposal(answer: string): ProposalText | undefined {
  const fence = /```(?:json)?[^\n]*\n([\s\S]*?)```/gu;
  let found: { start: number; end: number; json: string } | undefined;
  for (const match of answer.matchAll(fence)) {
    const body = match[1] ?? '';
    if (/"format"\s*:\s*"piui-system"/u.test(body)) found = { start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, json: body };
  }
  if (!found) return undefined;
  const prose = `${answer.slice(0, found.start)}${answer.slice(found.end)}`.replace(/\n{3,}/gu, '\n\n').trim();
  return { json: found.json.trim(), prose };
}

export type Proposal =
  | { ok: true; file: SystemFile; prose: string }
  | { ok: false; error: string; prose: string };

export function readProposal(answer: string): Proposal | undefined {
  const text = extractProposal(answer);
  if (!text) return undefined;
  try {
    return { ok: true, file: parseSystemFile(text.json), prose: text.prose };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), prose: text.prose };
  }
}

/**
 * Replace the draft's content with a proposal while keeping the draft's
 * identity, so saving updates the same pipeline, and keeping profile ids of
 * agents that survive, so their saved definitions are updated in place.
 * System files never carry pinned data: surviving nodes keep theirs.
 */
export function applyProposal(current: AgentGraph, file: SystemFile): AgentGraph {
  const proposed = systemFileToGraph(file);
  const keptProfile = new Map<string, string>();
  for (const node of proposed.nodes) {
    const existing = current.nodes.find((item) => item.id === node.id);
    if (existing) keptProfile.set(node.profile.id, existing.profile.id);
  }
  const profileId = (id: string) => keptProfile.get(id) ?? id;
  return {
    ...proposed,
    id: current.id,
    teamId: current.teamId,
    pipelineId: current.pipelineId,
    nodes: proposed.nodes.map((node) => {
      const pinned = current.nodes.find((item) => item.id === node.id)?.pinnedOutput;
      return {
        ...node,
        ...(pinned === undefined ? {} : { pinnedOutput: pinned }),
        profile: { ...node.profile, id: profileId(node.profile.id), allowedSpawnProfileIds: node.profile.allowedSpawnProfileIds.map(profileId) },
      };
    }),
  };
}

export interface ChangeSummary {
  added: string[];
  removed: string[];
  changed: string[];
  connectionsAdded: number;
  connectionsRemoved: number;
  renamed: boolean;
}

const edgeKey = (edge: GraphEdge) => `${edge.from}:${edge.to}:${edge.kind}:${edge.branchId ?? ''}`;

/** Human-sized difference between the draft and a proposal, by agent name. */
export function summarizeChange(current: AgentGraph, next: AgentGraph): ChangeSummary {
  const before = new Map(current.nodes.map((node) => [node.id, node]));
  const after = new Map(next.nodes.map((node) => [node.id, node]));
  const comparable = (node: AgentGraph['nodes'][number]) => {
    const { x: _x, y: _y, profile, ...rest } = node;
    const { id: _id, allowedSpawnProfileIds: _spawn, ...settings } = profile;
    return JSON.stringify({ ...rest, settings });
  };
  const beforeEdges = new Set(current.edges.map(edgeKey));
  const afterEdges = new Set(next.edges.map(edgeKey));
  return {
    added: next.nodes.filter((node) => !before.has(node.id)).map((node) => node.profile.name || node.id),
    removed: current.nodes.filter((node) => !after.has(node.id)).map((node) => node.profile.name || node.id),
    changed: next.nodes
      .filter((node) => {
        const previous = before.get(node.id);
        return previous !== undefined && comparable(previous) !== comparable(node);
      })
      .map((node) => node.profile.name || node.id),
    connectionsAdded: [...afterEdges].filter((key) => !beforeEdges.has(key)).length,
    connectionsRemoved: [...beforeEdges].filter((key) => !afterEdges.has(key)).length,
    renamed: current.name !== next.name,
  };
}

export function isEmptyChange(summary: ChangeSummary): boolean {
  return !summary.added.length && !summary.removed.length && !summary.changed.length && !summary.connectionsAdded && !summary.connectionsRemoved && !summary.renamed;
}
