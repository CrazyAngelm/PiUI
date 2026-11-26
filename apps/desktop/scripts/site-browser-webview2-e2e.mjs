import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const OPEN_LINK = 'site_browser_open_link_v1';
const FIRST_PAGE = `<!doctype html><title>First site fixture</title>
<button>Site fixture page</button><script src="/probe.js"></script>`;

async function startSite() {
  let secondLoaded = false;
  let firstConnection;
  const observations = new Map();
  const run = randomUUID();
  const siteCookie = `piui-site-proof=${run}`;
  const shellCookie = `piui-shell-proof=${run}`;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const cookies = (request.headers.cookie ?? '').split('; ');
    switch (url.pathname) {
      case '/first':
        observations.set('separate-shell-profile', !cookies.includes(shellCookie));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': `${siteCookie}; Path=/; HttpOnly; SameSite=Lax`,
        });
        response.end(FIRST_PAGE);
        break;
      case '/probe.js':
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(`
          (async () => {
            const tauri = window.__TAURI_INTERNALS__;
            async function probe(command, args) {
              if (typeof tauri?.invoke !== 'function') return 'unavailable';
              return tauri.invoke(command, args).then(() => 'allowed', () => 'denied');
            }
            const probes = {
              link: probe(${JSON.stringify(OPEN_LINK)}, {
                  request: { url: location.origin + '/unexpected', language: 'en' },
              }),
              tabs: probe('site_browser_action_v1', { request: { action: 'read' } }),
              events: probe('plugin:event|listen', { event: 'piui://site-browser-changed-v1',
                target: { kind: 'Any' }, handler: tauri?.transformCallback?.(() => {}) ?? 0 }),
            };
            const results = await Promise.all(Object.entries(probes)
              .map(async ([command, result]) => [command, await result]));
            await fetch('/site-authority?' + new URLSearchParams(results));
            function reportViewport() { return fetch('/site-width?value=' + innerWidth); }
            addEventListener('resize', reportViewport);
            await reportViewport();
            if ((await fetch('/first-tab-pending')).ok) await fetch('/first-tab-retained');
          })();
        `);
        break;
      case '/site-authority':
        observations.set('site-authority', Object.fromEntries(url.searchParams));
        response.writeHead(204).end();
        break;
      case '/site-width':
        observations.set('site-width', Number(url.searchParams.get('value')));
        response.writeHead(204).end();
        break;
      case '/first-tab-pending':
        firstConnection = response;
        observations.set('first-tab-pending', true);
        if (secondLoaded) firstConnection.writeHead(204).end();
        break;
      case '/first-tab-retained':
        observations.set('first-tab-retained', true);
        response.writeHead(204).end();
        break;
      case '/second':
        secondLoaded = true;
        observations.set('shared-profile', cookies.includes(siteCookie));
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<title>Second site fixture</title>');
        if (firstConnection) firstConnection.writeHead(204).end();
        break;
      default:
        if (url.pathname === '/unexpected') observations.set('unexpected', true);
        response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    observations,
    shellCookie,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

function assertSiteProfile(fixture) {
  const expected = join(fixture.tauriAppData, 'browser-profile');
  assert(lstatSync(expected).isDirectory(), 'The dedicated browser-profile is not a directory.');
  const actual = realpathSync(expected);
  assert.equal(relative(expected, actual), '', 'The site profile escaped its fixture path.');
  assert.notEqual(relative(realpathSync(fixture.webviewData), actual), '', 'The site reused the shell profile directory.');
  assert(readdirSync(actual).length > 0, 'WebView2 did not use the dedicated browser-profile.');
}

export async function runSiteBrowserWebview2Proof({ automation, safe, fixture, browserDock, resizeWindow, startupBoundMs }) {
  const site = await startSite();
  const invoke = (url) => automation.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(OPEN_LINK)}, {
    request: { url: ${JSON.stringify(url)}, language: 'en' },
  }).then(opened => ({ opened }), error => ({ code: error.code }))`);
  const shellCookie = JSON.stringify(site.shellCookie);
  async function waitFor(read, label) {
    const deadline = performance.now() + startupBoundMs;
    do {
      const value = await read();
      if (value !== undefined && value !== null) return value;
      await delay(50);
    } while (performance.now() < deadline);
    throw new Error(`The WebView2 site fixture did not observe ${label}.`);
  }
  const observed = (key) => waitFor(() => site.observations.get(key), key);
  const workbench = () => automation.evaluate(`(() => {
    const composer = document.querySelector('main#main textarea[aria-label="Message"]');
    return {
      width: innerWidth, height: innerHeight, focus: document.hasFocus(),
      composerFocused: composer !== null && composer === document.activeElement,
      composerReady: Boolean(composer?.getBoundingClientRect().width && !composer.disabled),
    };
  })()`);
  async function openThroughChat(path) {
    await automation.evaluate(`(() => {
      globalThis.__piuiSiteBrowserProof = null;
      import('/src/app/chat/openChatLink.ts')
        .then(module => module.openLinkInHost(${JSON.stringify(site.origin + path)}))
        .then(opened => { globalThis.__piuiSiteBrowserProof = { opened }; },
          error => { globalThis.__piuiSiteBrowserProof = { error: String(error) }; });
      return true;
    })()`);
    const result = await waitFor(() => automation.evaluate('globalThis.__piuiSiteBrowserProof'), 'the chat link result');
    await automation.evaluate('delete globalThis.__piuiSiteBrowserProof');
    assert(!result.error, result.error);
    return result.opened;
  }
  try {
    if (safe) {
      assert.deepEqual(await invoke(site.origin + '/first'), { code: 'UNAVAILABLE' });
      assert.equal(await openThroughChat('/first'), false);
      return ['webview2-safe-mode-refuses-site-browser-links'];
    }

    for (const url of ['file:///not-a-site', 'http://tauri.localhost./browser.html', 'http://nested.piui-plugin.localhost/test']) {
      assert.deepEqual(await invoke(url), { code: 'INVALID_ADDRESS' });
    }
    assert(await automation.evaluate(`(() => {
      if (location.hostname !== '127.0.0.1') return false;
      document.cookie = ${shellCookie} + '; Path=/; SameSite=Lax';
      return document.cookie.split('; ').includes(${shellCookie});
    })()`), 'The trusted shell could not set the comparison cookie.');
    await automation.evaluate(`(() => {
      document.querySelector('main#main textarea[aria-label="Message"]')?.focus();
      return true;
    })()`);
    const beforeDock = await workbench();
    assert(beforeDock.composerFocused, 'The workbench could not focus its composer before opening the browser.');
    assert.equal(await openThroughChat('/first'), true);
    const split = await waitFor(async () => {
      const layout = await workbench();
      return layout.composerReady && !layout.focus && layout.width < beforeDock.width ? layout : undefined;
    }, 'the visible chat composer left of the dock');
    await waitFor(async () => {
      const dock = await browserDock('state');
      return dock.visible && dock.focused && dock.closeX >= dock.splitX && dock.pageVisible
        && dock.pageX >= dock.splitX && dock.pageY >= dock.addressY ? dock : undefined;
    }, 'the focused browser toolbar on the right side of the owned window');
    const mainHide = await automation.evaluate(`window.__TAURI_INTERNALS__.invoke('site_browser_hide_v1')
      .then(() => 'accepted', error => error.code)`);
    assert.equal(mainHide, 'UNAVAILABLE', 'The main WebView can hide the dock without the toolbar.');
    assert.equal(await observed('separate-shell-profile'), true, 'The site received the trusted shell cookie.');
    const authority = await observed('site-authority');
    for (const command of ['link', 'tabs', 'events']) {
      assert(['unavailable', 'denied'].includes(authority[command]), `The site obtained IPC access to ${command}.`);
    }
    const resizedWidth = beforeDock.width === 1024 ? 1180 : 1024;
    await resizeWindow({ width: resizedWidth, height: beforeDock.height });
    await waitFor(async () => {
      const left = (await workbench()).width;
      const right = site.observations.get('site-width');
      return left !== split.width && Math.abs(left - right) <= 1 && Math.abs(left + right - resizedWidth) <= 1
        ? left : undefined;
    }, 'both visible browser and workbench viewports to resize with the window');
    await observed('first-tab-pending');
    await browserDock('close');
    await waitFor(async () => {
      const layout = await workbench();
      return layout.focus && layout.composerFocused && layout.composerReady && Math.abs(layout.width - resizedWidth) <= 1
        ? layout : undefined;
    }, 'the visible, focused workbench restored to full width');
    const closed = await browserDock('state');
    assert(!closed.visible && !closed.pageVisible, 'The closed browser still exposes its toolbar or site.');
    assert.equal(await openThroughChat('/second'), true);
    await waitFor(async () => {
      const layout = await workbench();
      return layout.composerReady && Math.abs(layout.width - resizedWidth / 2) <= 1 ? layout : undefined;
    }, 'the reopened dock beside the workbench');
    assert.equal(await observed('shared-profile'), true, 'Site tabs used different browsing profiles.');
    assert.equal(await observed('first-tab-retained'), true, 'Opening the second link discarded the first tab.');
    assert(!site.observations.has('unexpected'), 'The untrusted page caused a navigation.');
    assertSiteProfile(fixture);
    return [
      'webview2-trusted-main-opens-new-and-existing-site-browser',
      'webview2-browser-dock-resizes-both-views-and-restores-workbench-on-close',
      'webview2-site-browser-reuses-profile-and-preserves-tabs',
      'webview2-site-browser-profile-excludes-shell-cookie',
      authority.link === 'denied' ? 'webview2-site-page-ipc-rejected' : 'webview2-site-page-ipc-bridge-absent',
      'webview2-chat-link-host-refuses-invalid-and-app-origins',
    ];
  } finally {
    await site.close();
  }
}
