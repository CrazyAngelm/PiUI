import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLUGIN_THEME_TOKENS } from '../../../../contracts/piui-plugin-v1';
import {
  currentAppearance,
  envelope,
  methodPermitted,
  panelTheme,
  paramsIssue,
  parsePanelMessage,
  rendererActivity,
  rendererHeight,
  RequestBudget,
} from './pluginBridge';
import { ASSET_POLICY, contentType, panelHeaders, panelPolicy, PLUGIN_ORIGIN_WINDOWS, uiBase } from './pluginFrame';

const channel = 'c-1';
const request = (method: string, params: unknown = undefined, extra: Record<string, unknown> = {}) => ({
  piui: 'piui-panel',
  version: 1,
  type: 'request',
  channel,
  id: 'r1',
  method,
  ...(params === undefined ? {} : { params }),
  ...extra,
});

describe('chat renderers (bridge v1.1)', () => {
  it('sends plain, bounded activity and never more than 48 KiB of text', () => {
    const block = { toolName: 'create_issue', title: 'lab-issues.create_issue', status: 'streaming', text: 'Arguments: title: Broken link' };
    expect(rendererActivity(block)).toEqual({ toolName: 'create_issue', title: 'lab-issues.create_issue', status: 'streaming', text: 'Arguments: title: Broken link', truncated: false });
    expect(rendererActivity({ toolName: 'x', status: 'unknown-state' }).status).toBe('complete');
    expect(rendererActivity({ label: 'Tool', safeSummary: 'summary', truncated: true })).toMatchObject({ title: 'Tool', text: 'summary', truncated: true });
    const long = rendererActivity({ toolName: 'x', text: '😀'.repeat(20_000) });
    expect(new TextEncoder().encode(long.text).length).toBeLessThanOrEqual(48 * 1024);
    expect(long.truncated).toBe(true);
    expect(long.text.endsWith('😀')).toBe(true);
  });

  it('checks frame.resize and clamps the height; only ui.renderer may ask', () => {
    expect(parsePanelMessage(request('frame.resize', { height: 180 }), channel)).toMatchObject({ kind: 'request', method: 'frame.resize' });
    for (const params of [undefined, { height: '180' }, { height: -1 }, { height: 180, width: 10 }, { height: Number.NaN }]) {
      expect(paramsIssue('frame.resize', params)).toBeDefined();
    }
    expect(methodPermitted('frame.resize', ['ui.panel'])).toBe(false);
    expect(methodPermitted('frame.resize', ['ui.renderer'])).toBe(true);
    expect([rendererHeight(10), rendererHeight(180.4), rendererHeight(5000)]).toEqual([48, 180, 600]);
  });
});

describe('plugin panel bridge v1', () => {
  it('accepts ready and well-formed requests on the current channel only', () => {
    expect(parsePanelMessage({ piui: 'piui-panel', version: 1, type: 'ready' }, undefined)).toEqual({ kind: 'ready' });
    expect(parsePanelMessage(request('context.get'), channel)).toEqual({ kind: 'request', id: 'r1', method: 'context.get', params: undefined });
    expect(parsePanelMessage(request('commands.run', { commandId: 'say-hello' }), channel)).toMatchObject({ kind: 'request', method: 'commands.run' });
    // Another channel, no channel yet, another marker or version, bad ids: ignored silently.
    for (const [data, current] of [
      [request('context.get'), 'c-2'],
      [request('context.get'), undefined],
      [{ ...request('context.get'), piui: 'other' }, channel],
      [{ ...request('context.get'), version: 2 }, channel],
      [{ ...request('context.get'), id: 'has space' }, channel],
      [{ ...request('context.get'), id: 'x'.repeat(65) }, channel],
      ['text', channel],
      [null, channel],
      [[request('context.get')], channel],
    ] as const) {
      expect(parsePanelMessage(data, current)).toEqual({ kind: 'ignore' });
    }
  });

  it('refuses unknown methods, bad parameters and oversized requests with an error answer', () => {
    expect(parsePanelMessage(request('fs.read', { path: 'C:/' }), channel)).toMatchObject({ kind: 'refuse', code: 'unknown-method' });
    expect(parsePanelMessage(request('toString'), channel)).toMatchObject({ kind: 'refuse', code: 'unknown-method' });
    expect(parsePanelMessage(request('__proto__'), channel)).toMatchObject({ kind: 'refuse', code: 'unknown-method' });
    expect(parsePanelMessage(request('commands.run', { commandId: '../x' }), channel)).toMatchObject({ kind: 'refuse', code: 'invalid-params' });
    expect(parsePanelMessage(request('commands.run', { commandId: 'a', extra: 1 }), channel)).toMatchObject({ kind: 'refuse', code: 'invalid-params' });
    expect(parsePanelMessage(request('settings.set', { values: { a: { nested: true } } }), channel)).toMatchObject({ kind: 'refuse', code: 'invalid-params' });
    expect(parsePanelMessage(request('context.get', { any: 1 }), channel)).toMatchObject({ kind: 'refuse', code: 'invalid-params' });
    const big = request('notice.show', { message: 'x'.repeat(70 * 1024) });
    expect(parsePanelMessage(big, channel)).toMatchObject({ kind: 'refuse', code: 'too-large' });
  });

  it('checks notices for plain, bounded text and a known level', () => {
    expect(paramsIssue('notice.show', { message: 'Saved' })).toBeUndefined();
    expect(paramsIssue('notice.show', { message: 'Careful', level: 'warning' })).toBeUndefined();
    expect(paramsIssue('notice.show', { message: '' })).toBeDefined();
    expect(paramsIssue('notice.show', { message: 'x'.repeat(501) })).toBeDefined();
    expect(paramsIssue('notice.show', { message: 'bell\u0007' })).toBeDefined();
    expect(paramsIssue('notice.show', { message: 'ok', level: 'fatal' })).toBeDefined();
    expect(paramsIssue('notice.show', { message: 'ok', html: '<b>' })).toBeDefined();
    expect(paramsIssue('settings.set', { values: { greeting: 'Hi', count: 2, loud: false } })).toBeUndefined();
  });

  it('needs the permission of each method', () => {
    expect(methodPermitted('context.get', ['chat.read'])).toBe(true);
    expect(methodPermitted('context.get', ['ui.panel'])).toBe(false);
    expect(methodPermitted('commands.run', ['commands'])).toBe(true);
    expect(methodPermitted('settings.set', ['ui.panel', 'commands'])).toBe(false);
    expect(methodPermitted('notice.show', ['notifications'])).toBe(true);
  });

  it('limits bursts to twenty requests a second', () => {
    let now = 1_000;
    const budget = new RequestBudget(20, () => now);
    const first = Array.from({ length: 25 }, () => budget.allow());
    expect(first.filter(Boolean)).toHaveLength(20);
    now += 999;
    expect(budget.allow()).toBe(false);
    now += 1;
    expect(budget.allow()).toBe(true);
  });

  it('sends computed tokens without control characters and the current appearance', () => {
    const values: Record<string, string> = { '--piui-bg': ' #101010 ', '--piui-text': '#fafafa', '--piui-font-ui': 'Inter, sans-serif', '--piui-accent': 'red\u0000' };
    const theme = panelTheme((name) => values[name] ?? '', 'dark');
    expect(theme).toEqual({ appearance: 'dark', tokens: { bg: '#101010', text: '#fafafa', 'font-ui': 'Inter, sans-serif' } });
    expect(PLUGIN_THEME_TOKENS).toContain('bg');
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    expect(currentAppearance(root, true)).toBe('dark');
    root.dataset.theme = 'light';
    expect(currentAppearance(root, true)).toBe('light');
    expect(envelope({ type: 'event' })).toEqual({ piui: 'piui-panel', version: 1, type: 'event' });
  });
});

describe('plugin protocol responses (shared with crates/piui-plugins csp.rs)', () => {
  it('builds the same panel policy as the host fixture', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/plugin-panel-csp.json', import.meta.url), 'utf8')) as Record<string, string>;
    expect(fixture.origin).toBe(PLUGIN_ORIGIN_WINDOWS);
    const base = uiBase(fixture.id ?? '', fixture.uiEntry ?? '');
    expect(base).toBe(fixture.base);
    expect(panelPolicy(fixture.origin ?? '', base)).toBe(fixture.policy);
    expect(ASSET_POLICY).toBe(fixture.assetPolicy);
  });

  it('allows no connections, frames, workers, forms or navigation targets and keeps the sandbox', () => {
    const policy = panelPolicy(PLUGIN_ORIGIN_WINDOWS, uiBase('example.hello', 'index.html'));
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'", 'sandbox allow-scripts']) {
      expect(policy).toContain(directive);
    }
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(uiBase('example.hello', 'index.html')).toBe('example.hello/');
    expect(uiBase('example.hello', 'ui/panel/index.html')).toBe('example.hello/ui/panel/');
  });

  it('serves known types only, with a CSP on documents and CORS on module assets', () => {
    expect(contentType('ui/index.HTML')).toBe('text/html; charset=utf-8');
    expect(contentType('backend/main.exe')).toBeUndefined();
    expect(contentType('README')).toBeUndefined();
    const page = panelHeaders(PLUGIN_ORIGIN_WINDOWS, 'example.hello/ui/', 'ui/index.html');
    expect(page?.['Content-Security-Policy']).toContain('sandbox allow-scripts');
    expect(page?.['Access-Control-Allow-Origin']).toBeUndefined();
    const script = panelHeaders(PLUGIN_ORIGIN_WINDOWS, 'example.hello/ui/', 'ui/panel.js');
    expect(script).toMatchObject({ 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    // Opened on its own (an SVG, say), a file runs no script.
    expect(script?.['Content-Security-Policy']).toBe('sandbox');
    expect(panelHeaders(PLUGIN_ORIGIN_WINDOWS, 'example.hello/ui/', 'ui/tool.exe')).toBeUndefined();
  });
});
