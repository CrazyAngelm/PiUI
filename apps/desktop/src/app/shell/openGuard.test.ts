import { describe, expect, it } from 'vitest';
import { createOpenGuard } from './openGuard';

describe('open guard for lazily loaded actions', () => {
  it('lets an unchanged attempt complete', () => {
    const guard = createOpenGuard<string>();
    expect(guard.begin('project-a', () => 'project-a')()).toBe(true);
  });

  it('drops a completion after the selected project changed', () => {
    const guard = createOpenGuard<string>();
    let selected = 'project-a';
    const mayComplete = guard.begin('project-a', () => selected);
    selected = 'project-b';
    expect(mayComplete()).toBe(false);
    // Back on the same project the attempt is valid again: it targets that project.
    selected = 'project-a';
    expect(mayComplete()).toBe(true);
  });

  it('lets only the newest attempt complete', () => {
    const guard = createOpenGuard<string>();
    const first = guard.begin('project-a', () => 'project-a');
    const second = guard.begin('project-a', () => 'project-a');
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('drops everything once the owner is closed', () => {
    const guard = createOpenGuard<string>();
    const pending = guard.begin('project-a', () => 'project-a');
    guard.close();
    expect(pending()).toBe(false);
    expect(guard.begin('project-a', () => 'project-a')()).toBe(false);
  });
});
