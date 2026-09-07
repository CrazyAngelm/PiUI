import { expect, it } from 'vitest';
import { executionLayout } from './executionLayout';
it('positions parallel branches before their join regardless of file ordering', () => {
  const nodes = executionLayout([{id:'join',dependencyStepIds:['a','b']},{id:'a',dependencyStepIds:[]},{id:'b',dependencyStepIds:[]}]);
  expect(nodes[0]!.x).toBeGreaterThan(nodes[1]!.x);
  expect(nodes[1]!.x).toBe(nodes[2]!.x);
  expect(nodes[1]!.y).not.toBe(nodes[2]!.y);
});
