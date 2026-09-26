import type { ConnectionKind } from '../../../features/orchestration/agentGraph';

type Translate = (value: string, parameters?: readonly unknown[]) => string;

const KIND_LABEL: Readonly<Record<ConnectionKind, string>> = {
  result: 'Result',
  route: 'Route',
  send: 'Messages',
  observe: 'Observe',
  spawn: 'Delegate',
};

/**
 * Accessible name of a canvas connection, e.g. "Result connection from
 * Developer to Reviewer", instead of Svelte Flow's default built from ids.
 */
export function connectionLabel(t: Translate, kind: ConnectionKind | 'start', from: string, to: string): string {
  return kind === 'start'
    ? t('Connection from {0} to {1}', [from, to])
    : t('{0} connection from {1} to {2}', [t(KIND_LABEL[kind]), from, to]);
}
