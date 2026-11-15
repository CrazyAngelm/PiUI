import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./transport', () => ({
  hostInvoke: async (...args: unknown[]) => ({ protocol: 19, catalog: await invoke(...args) }),
  hostListen: vi.fn(), desktopAvailable: true,
}));
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
  get length() { return memory.size; },
  key: (index: number) => [...memory.keys()][index] ?? null,
});
let prewarmHarnessCatalogs: typeof import('./catalogPrewarm').prewarmHarnessCatalogs;
beforeEach(async () => {
  vi.resetModules(); invoke.mockReset(); localStorage.clear();
  ({ prewarmHarnessCatalogs } = await import('./catalogPrewarm'));
});

type Call = { request: { harness: string; part: string } };
const listed = (harness: string) => ({ protocol: 18, harness, models: [{ id: `${harness}-model`, name: 'Model' }], resources: { items: [], warnings: [] } });
/** The native requests so far, as `harness:part`. */
const started = (): string[] => invoke.mock.calls.map(([, call]) => `${call.request.harness}:${call.request.part}`);
const idle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

describe('background catalog prewarm', () => {
  it('asks harnesses one after the other, the next only after the previous full catalog settled', async () => {
    const gates = new Map<string, () => void>();
    invoke.mockImplementation((_command: string, { request }: Call) => new Promise(resolve => {
      gates.set(`${request.harness}:${request.part}`, () => resolve(listed(request.harness)));
    }));
    prewarmHarnessCatalogs('project', [{ kind: 'codex' }, { kind: 'claude-code' }]);
    await vi.waitFor(() => expect(started()).toEqual(['codex:models']));
    gates.get('codex:models')!();
    await vi.waitFor(() => expect(started()).toEqual(['codex:models', 'codex:resources']));
    await idle();
    expect(started(), 'the second harness waits for the first one’s resources too').toEqual(['codex:models', 'codex:resources']);
    gates.get('codex:resources')!();
    await vi.waitFor(() => expect(started()).toEqual(['codex:models', 'codex:resources', 'claude-code:models']));
  });

  it('asks each project, harness and native version once, and a new version again', async () => {
    // A failed load leaves no snapshot behind, so only the once-per-session rule can stop a repeat.
    invoke.mockRejectedValue({ code: 'RUNTIME_FAILED' });
    prewarmHarnessCatalogs('project', [{ kind: 'codex', version: '0.165.0' }]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await idle();
    prewarmHarnessCatalogs('project', [{ kind: 'codex', version: '0.165.0' }]);
    await idle();
    expect(invoke, 'the same version is not asked again').toHaveBeenCalledTimes(1);
    prewarmHarnessCatalogs('project', [{ kind: 'codex', version: '0.166.0' }]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    prewarmHarnessCatalogs('other-project', [{ kind: 'codex', version: '0.166.0' }]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  });

  it('keeps going when one harness fails', async () => {
    invoke.mockImplementation((_command: string, { request }: Call) => (
      request.harness === 'codex' ? Promise.reject({ code: 'RUNTIME_FAILED' }) : Promise.resolve(listed(request.harness))
    ));
    prewarmHarnessCatalogs('project', [{ kind: 'codex' }, { kind: 'claude-code' }]);
    await vi.waitFor(() => expect(started()).toEqual(['codex:models', 'claude-code:models', 'claude-code:resources']));
  });

  it('leaves a harness the project already remembers to its picker', async () => {
    invoke.mockImplementation((_command: string, { request }: Call) => Promise.resolve(listed(request.harness)));
    const { harnessModels } = await import('./harnessModels');
    await harnessModels({ workspaceId: 'project', harness: 'codex' });
    // A new session: nothing is in memory, only the snapshot in storage remembers the catalog.
    vi.resetModules();
    const fresh = await import('./catalogPrewarm');
    invoke.mockClear();
    fresh.prewarmHarnessCatalogs('project', [{ kind: 'codex' }]);
    await idle();
    expect(invoke).not.toHaveBeenCalled();
    // Another project has no snapshot of its own for it: that one is asked.
    fresh.prewarmHarnessCatalogs('other-project', [{ kind: 'codex' }]);
    await vi.waitFor(() => expect(started()).toEqual(['codex:models', 'codex:resources']));
  });
});
