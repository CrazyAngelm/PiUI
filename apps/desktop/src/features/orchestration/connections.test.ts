import { expect, it } from 'vitest';
import { connectionPreset, setConnection } from './connections';
const members = ['lead', 'writer', 'reviewer'].map(id => ({ id, profileId: id }));
it('orchestrator topology permits both directions without giving peers a route', () => {
  const edges = connectionPreset(members, 'lead', 'orchestrator');
  expect(edges).toHaveLength(4);
  expect(edges).toContainEqual({ fromMemberId: 'writer', toMemberId: 'lead' });
  expect(edges).not.toContainEqual({ fromMemberId: 'writer', toMemberId: 'reviewer' });
});
it('everyone topology excludes self routes and editing one direction preserves the reverse', () => {
  const edges = connectionPreset(members, 'lead', 'everyone');
  expect(edges).toHaveLength(6);
  const edited = setConnection(edges, 'writer', 'reviewer', false);
  expect(edited).not.toContainEqual({ fromMemberId: 'writer', toMemberId: 'reviewer' });
  expect(edited).toContainEqual({ fromMemberId: 'reviewer', toMemberId: 'writer' });
  expect(setConnection(edited, 'writer', 'reviewer', true)).toHaveLength(6);
});
