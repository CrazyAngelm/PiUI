/**
 * Names of the starter topologies, kept apart from the graph builders in
 * `templates.ts` so that menus can list them without loading the builders.
 */
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
