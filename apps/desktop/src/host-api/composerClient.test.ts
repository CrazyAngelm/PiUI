import { beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock('./transport', () => ({ hostInvoke: invoke, hostListen: listen, desktopAvailable: true }));
import { composerRequest, listenComposer } from './composerClient';
beforeEach(() => { invoke.mockReset(); listen.mockReset(); });
it('listens through the host transport and ignores other sessions', async () => {
  const stop = vi.fn();
  listen.mockResolvedValue(stop);
  const handler = vi.fn();
  expect(await listenComposer('session', handler)).toBe(stop);
  expect(listen).toHaveBeenCalledWith('piui://composer-v19', expect.any(Function));
  const deliver = listen.mock.calls[0]?.[1] as (payload: unknown) => void;
  deliver('other-session');
  deliver({ sessionId: 'session' });
  expect(handler).not.toHaveBeenCalled();
  deliver('session');
  expect(handler).toHaveBeenCalledTimes(1);
});
it('keeps request identity and queue revision across typed admission', async () => {
  const command = {type:'send' as const,sessionId:'session',requestId:'same-request',text:'draft',mode:'follow-up' as const};
  const state = {protocol:19,sessionId:'session',capabilities:{steer:false,compact:false},queue:{revision:2,paused:false,items:[{id:'same-request',text:'draft',status:'queued'}]}};
  invoke.mockResolvedValue(state);
  expect(await composerRequest(command)).toEqual(state);
  expect(invoke).toHaveBeenCalledWith('workspace_composer_v19',{command});
});
it('rejects a response belonging to another session', async () => {
  invoke.mockResolvedValue({protocol:19,sessionId:'different'});
  await expect(composerRequest({type:'snapshot',sessionId:'session'})).rejects.toThrow();
});
it('keeps refusal actionable without leaking native errors', async () => {
  invoke.mockRejectedValue({code:'NO_ACTIVE_TURN',message:'secret native payload'});
  await expect(composerRequest({type:'promote',sessionId:'session',requestId:'same-request'})).rejects.toThrow('There is no active turn to steer.');
});
