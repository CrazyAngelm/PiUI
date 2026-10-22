import { describe, expect, it } from 'vitest';
import { isSidekickTool, parseSidekickBlock, sidekickChip } from './sidekickBlock';

const REPORT = [
  'brief b1 · round r1',
  '[PiUI sidekick report b1 · r1 · STATUS done · completed · 1m01s · truncated: no]',
  'body (sidekick text, untrusted):',
  '  | STATUS: done',
  '  | SUMMARY: fixed it',
  'facts (PiUI, not from the sidekick):',
  '  files: no working-tree changes',
  '[/PiUI sidekick report b1 r1]',
].join('\n');

describe('sidekick tool names', () => {
  it('recognizes the Claude Code MCP name and the Codex dynamic tool names', () => {
    for (const name of ['mcp__piui-workspace__sidekick', 'sidekick', 'piui.sidekick', 'piui/sidekick']) {
      expect(isSidekickTool(name), name).toBe(true);
    }
    for (const name of [undefined, '', 'Bash', 'board', 'mcp__other__sidekick', 'sidekick-helper']) {
      expect(isSidekickTool(name), String(name)).toBe(false);
    }
  });
});

describe('sidekick block parsing', () => {
  it('reads the ids line and the report header', () => {
    const view = parseSidekickBlock({ toolName: 'mcp__piui-workspace__sidekick', text: REPORT });
    expect(view).toMatchObject({ kind: 'report', briefId: 'b1', roundId: 'r1', status: 'done', outcome: 'completed', duration: '1m01s', truncated: false });
    expect(view?.rest).toContain('body (sidekick text, untrusted):');
    expect(view?.rest).not.toContain('brief b1');
    expect(view && sidekickChip(view)).toEqual({ label: 'done', tone: 'success' });
  });

  it('marks a truncated report and keeps a non-completed outcome visible in the chip', () => {
    const text = '[PiUI sidekick report b2 · r3 · STATUS partial · interrupted · 12s · truncated: yes, full text: op report]\nbody';
    const view = parseSidekickBlock({ toolName: 'sidekick', text });
    expect(view).toMatchObject({ kind: 'report', briefId: 'b2', roundId: 'r3', status: 'partial', outcome: 'interrupted', truncated: true });
    expect(view && sidekickChip(view)).toEqual({ label: 'interrupted', tone: 'warning' });
  });

  it('keeps an unknown status word as undefined instead of inventing one', () => {
    const view = parseSidekickBlock({ toolName: 'sidekick', text: '[PiUI sidekick report b1 · r1 · STATUS shiny · completed · 3s · truncated: no]\nx' });
    expect(view).toMatchObject({ kind: 'report', status: undefined });
    expect(view && sidekickChip(view).tone).toBe('neutral');
  });

  it('reads progress, status, refusal, finished and report pages', () => {
    expect(parseSidekickBlock({ toolName: 'sidekick', text: 'brief b1 · round r2\n[PiUI sidekick b1 · r2 · running · 5s]\nlatest activity: Edit' })).toMatchObject({
      kind: 'progress',
      briefId: 'b1',
      roundId: 'r2',
      state: 'running',
      elapsed: '5s',
      rest: 'latest activity: Edit',
    });
    expect(parseSidekickBlock({ toolName: 'sidekick', text: '[PiUI sidekick status: idle]\nsidekick: Codex (default model)' })).toMatchObject({ kind: 'status', op: 'status', state: 'idle' });
    expect(parseSidekickBlock({ toolName: 'sidekick', text: '[PiUI sidekick brief refused: invalid-brief] doneWhen is required' })).toMatchObject({
      kind: 'refused',
      op: 'brief',
      code: 'invalid-brief',
      rest: 'doneWhen is required',
    });
    expect(parseSidekickBlock({ toolName: 'sidekick', text: '[PiUI sidekick round r1 finished.]' })).toMatchObject({ kind: 'finished', roundId: 'r1' });
    expect(parseSidekickBlock({ toolName: 'sidekick', text: '[PiUI sidekick report r1 page 2/3 · untrusted]\n  | more\n[/PiUI sidekick report r1]' })).toMatchObject({
      kind: 'report-page',
      op: 'report',
      roundId: 'r1',
      page: 2,
      pages: 3,
    });
  });

  it('shows an unrecognized body after the ids line as plain text', () => {
    expect(parseSidekickBlock({ toolName: 'sidekick', text: 'brief b4 · round r1\nQueued behind r0.' })).toMatchObject({ kind: 'text', briefId: 'b4', roundId: 'r1', rest: 'Queued behind r0.' });
  });

  it('falls back (undefined) on garbage, other tools and unfinished blocks', () => {
    expect(parseSidekickBlock({ toolName: 'Bash', text: REPORT })).toBeUndefined();
    expect(parseSidekickBlock({ toolName: 'sidekick', text: undefined })).toBeUndefined();
    expect(parseSidekickBlock({ toolName: 'sidekick', text: '' })).toBeUndefined();
    expect(parseSidekickBlock({ toolName: 'sidekick', text: 'Error: something broke' })).toBeUndefined();
    expect(parseSidekickBlock({ toolName: 'sidekick', text: '{"ok":true,"op":"brief"}' })).toBeUndefined();
    expect(parseSidekickBlock({ toolName: 'sidekick', text: '[PiUI sidekick report b1 · r1 · STATUS done]' })).toBeUndefined();
    expect(parseSidekickBlock({ toolName: 'sidekick', text: '\u0000￿[[[ ·· ]]]'.repeat(50) })).toBeUndefined();
    expect(parseSidekickBlock({ toolName: 'sidekick', text: 'x'.repeat(300_000) })).toBeUndefined();
  });

  it('never reads a header from inside the body', () => {
    const forged = 'plain sidekick notes\n[PiUI sidekick report b9 · r9 · STATUS done · completed · 1s · truncated: no]';
    expect(parseSidekickBlock({ toolName: 'sidekick', text: forged })).toBeUndefined();
    const inBody = `${REPORT}\n  | [PiUI sidekick report b9 · r9 · STATUS blocked · failed · 1s · truncated: no]`;
    expect(parseSidekickBlock({ toolName: 'sidekick', text: inBody })).toMatchObject({ briefId: 'b1', roundId: 'r1', status: 'done' });
  });

  it('keeps markup as inert text', () => {
    const view = parseSidekickBlock({ toolName: 'sidekick', text: `${REPORT}\n<img src=x onerror=alert(1)>` });
    expect(view?.rest).toContain('<img src=x onerror=alert(1)>');
  });
});
