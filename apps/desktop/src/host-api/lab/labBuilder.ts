/**
 * Deterministic stand-in for a real model answering the pipeline assistant:
 * it reads the draft PiUI put in the context and proposes one sensible change,
 * so the assistant's apply/validate flow can be exercised without paid turns.
 */

interface DraftAgent {
  id: string;
  kind?: string;
  profile: { name: string; harness: string; model: string; permissionMode: string; instructions: string; toolPolicy: { rules: unknown[] } };
  task: string;
  resultFields?: { name: string; kind: string }[];
  review?: { field: string; retryFromStepId: string; maxIterations?: number };
  position?: { x: number; y: number };
}

interface DraftSystem {
  format: 'piui-system';
  version: number;
  name: string;
  agents: DraftAgent[];
  connections: { from: string; to: string; kind: string; branchId?: string }[];
}

export const BUILDER_MARKER = '<piui-builder-context>';

function draftFrom(prompt: string): DraftSystem | undefined {
  const match = /Current editor draft:\n```json\n([\s\S]*?)\n```/u.exec(prompt);
  if (!match?.[1]) return undefined;
  try {
    const value = JSON.parse(match[1]) as DraftSystem;
    return value.format === 'piui-system' && Array.isArray(value.agents) ? value : undefined;
  } catch {
    return undefined;
  }
}

function firstModels(prompt: string): Map<string, string> {
  const models = new Map<string, string>();
  for (const line of prompt.split('\n')) {
    const match = /^- ([a-z-]+) \([^)]*\): (.+)$/u.exec(line);
    if (!match?.[1] || !match[2] || match[2] === 'no models listed') continue;
    models.set(match[1], match[2].split(',')[0]!.trim());
  }
  return models;
}

function agent(id: string, name: string, harness: string, model: string, task: string, x: number, extra: Partial<DraftAgent> = {}): DraftAgent {
  return {
    id,
    profile: { name, harness, model, permissionMode: 'read-only', instructions: '', toolPolicy: { rules: [] } },
    task,
    position: { x, y: 120 },
    ...extra,
  };
}

/** The assistant's answer text: a short explanation and one complete system block. */
export function builderAnswer(prompt: string): string {
  const draft = draftFrom(prompt);
  const models = firstModels(prompt);
  const [harness, model] = [...models.entries()][0] ?? ['codex', 'REPLACE_WITH_AVAILABLE_MODEL'];
  const request = prompt.slice(prompt.lastIndexOf('</piui-builder-context>') + '</piui-builder-context>'.length).trim();
  const agents = draft?.agents ?? [];
  const workers = agents.filter((item) => item.kind !== 'router');

  if (workers.length === 0) {
    const system: DraftSystem = {
      format: 'piui-system',
      version: 4,
      name: draft?.name || 'Build, test and review',
      agents: [
        agent('developer', 'Developer', harness, model, 'Implement {{input.task}}. Keep the change small and explain what you changed.', 60),
        agent('tester', 'Tester', harness, model, 'Run the relevant tests for the change and report failures with evidence.', 360),
        agent('reviewer', 'Reviewer', harness, model, 'Review the change and the test report. Approve only if it is correct and tested.', 660, {
          resultFields: [
            { name: 'approved', kind: 'boolean' },
            { name: 'feedback', kind: 'text' },
          ],
          review: { field: 'approved', retryFromStepId: 'developer', maxIterations: 3 },
        }),
      ],
      connections: [
        { from: 'developer', to: 'tester', kind: 'result' },
        { from: 'tester', to: 'reviewer', kind: 'result' },
      ],
    };
    return [
      `Here is a loop for “${request.slice(0, 80)}”:`,
      '',
      '- **Developer** implements the task.',
      '- **Tester** runs the tests and reports evidence.',
      '- **Reviewer** approves or sends the work back to the developer, at most 3 rounds.',
      '',
      '```json',
      JSON.stringify(system, null, 2),
      '```',
    ].join('\n');
  }

  const last = workers[workers.length - 1]!;
  const x = Math.max(...agents.map((item) => item.position?.x ?? 0)) + 300;
  const hasReviewer = agents.some((item) => item.review);
  const next: DraftSystem = hasReviewer
    ? { ...draft!, agents: agents.map((item) => (item.review ? { ...item, review: { ...item.review, maxIterations: 3 } } : item)) }
    : {
        ...draft!,
        agents: [
          ...agents,
          agent('reviewer', 'Reviewer', last.profile.harness || harness, last.profile.model || model, `Review the result of ${last.profile.name}. Approve only if it fully solves the task.`, x, {
            resultFields: [
              { name: 'approved', kind: 'boolean' },
              { name: 'feedback', kind: 'text' },
            ],
            review: { field: 'approved', retryFromStepId: last.id, maxIterations: 3 },
          }),
        ],
        connections: [...draft!.connections, { from: last.id, to: 'reviewer', kind: 'result' }],
      };
  const bullets = hasReviewer
    ? ['- The review loop now stops after **3 rounds** and asks you instead of looping forever.']
    : [`- Added a **Reviewer** after **${last.profile.name}**.`, `- If it rejects the result, ${last.profile.name} gets the feedback and tries again, at most 3 rounds.`];
  return ['Proposed change:', '', ...bullets, '', '```json', JSON.stringify(next, null, 2), '```'].join('\n');
}
