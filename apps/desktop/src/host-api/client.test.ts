import { describe, expect, it } from 'vitest';
import { host, isHostConflict, toSafeHostError } from './client';

describe('safe host errors', () => {
  it('preserves only the recognized conflict code from structured host failures', () => {
    const error = toSafeHostError('Fake runtime start', {
      code: 'CONFLICT',
      message: 'D:/private/project should never reach the WebView',
    });

    expect(isHostConflict(error)).toBe(true);
    expect(error.message).toContain('project folder changed');
    expect(error.message).not.toContain('D:/private/project');
  });

  it('recognizes a JSON-serialized conflict but keeps unknown host payloads generic', () => {
    expect(isHostConflict(toSafeHostError('Session scan', '{"code":"CONFLICT"}'))).toBe(true);

    const error = toSafeHostError('Session scan', {
      code: 'IO_ERROR',
      message: 'C:/secret/session.jsonl',
    });
    expect(isHostConflict(error)).toBe(false);
    expect(error.message).toBe('Session scan could not be completed. Open diagnostics for a safe error code.');
  });

  it('preserves only the project-kind conflict code and hides host details', () => {
    const error = toSafeHostError('Project registration', {
      code: 'PROJECT_KIND_CONFLICT',
      message: 'D:/private/project was registered as pi',
    });

    expect(error.code).toBe('PROJECT_KIND_CONFLICT');
    expect(isHostConflict(error)).toBe(false);
    expect(error.message).toContain('another agent runtime');
    expect(error.message).not.toContain('D:/private/project');
  });

  it('maps an active Prime lease to a typed path-free conflict', () => {
    const error = toSafeHostError('Prime runtime start', {
      code: 'SESSION_ALREADY_ACTIVE',
      message: 'C:/private/session.jsonl is held by pid 1234',
    });

    expect(error.code).toBe('SESSION_ALREADY_ACTIVE');
    expect(error.message).toContain('already active');
    expect(error.message).not.toContain('C:/private');
    expect(error.message).not.toContain('1234');
  });

  it('round-trips an explicit Prime Agent kind in the browser project mock', async () => {
    const project = await host.addProject('D:/prime-project-test', 'prime-agent');
    expect(project.agentKind).toBe('prime-agent');
    await host.removeProject(project.id);
  });

  it('round-trips only the typed PiUI display preferences in the browser mock', async () => {
    const before = (await host.bootstrap()).preferences;
    const updated = await host.updatePreferences({
      theme: 'light',
      density: 'compact',
      reducedMotion: 'reduce',
      fontSize: 'large',
      chatWidth: 'focused',
    });
    expect(updated).toEqual({
      theme: 'light',
      density: 'compact',
      reducedMotion: 'reduce',
      fontSize: 'large',
      chatWidth: 'focused',
    });
    expect((await host.bootstrap()).preferences).toEqual(updated);
    await host.updatePreferences(before);
  });

  it('keeps the browser mock navigable through the projectless Chats surface', async () => {
    await expect(host.listPersonalSessions()).resolves.toEqual([]);
    await expect(host.startPersonalChat()).rejects.toThrow('live Pi runtime');
  });

  it('keeps optional extension UI contributions inert in the browser mock', async () => {
    await expect(host.listPiUiContributions()).resolves.toEqual({
      commands: [],
      composerActions: [],
    });
    await expect(host.getRuntimeCommands('mock-runtime')).resolves.toEqual([]);
  });

  it('keeps Pi and Prime Agent extension inventories separate in the browser mock', async () => {
    const piBefore = await host.listExtensions('pi');
    const primeBefore = await host.listExtensions('prime-agent');
    expect(piBefore.every((extension) => extension.agentKind === 'pi')).toBe(true);
    expect(primeBefore.every((extension) => extension.agentKind === 'prime-agent')).toBe(true);
    expect(primeBefore.some((prime) => piBefore.some((pi) => pi.id === prime.id))).toBe(false);

    const target = piBefore[0];
    expect(target).toBeDefined();
    const updated = await host.setExtensionEnabled('pi', target!.id, !target!.enabled);
    expect(updated.find((extension) => extension.id === target!.id)?.enabled).toBe(!target!.enabled);
    await expect(host.setExtensionEnabled('prime-agent', target!.id, true)).rejects.toThrow('not found');
    await host.setExtensionEnabled('pi', target!.id, target!.enabled);
  });

});
