import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const OPEN_LINK = 'site_browser_open_link_v1';
const FIRST_PAGE = `<!doctype html><title>First site fixture</title><script src="/probe.js"></script>`;

async function startSite() {
  let secondLoaded = false;
  let firstConnection;
  const observations = new Map();
  const actions = new Map();
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
      case '/form':
        observations.set(`form:${url.searchParams.get('tab')}:requested`, true);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`
          <!doctype html><meta charset="utf-8"><title>Form fixture</title>
          <form>
            <label>Manual input <input id="manual"></label>
            <label>Organization <input id="organization" type="text" autocomplete="organization"></label>
            <button>Submit</button>
          </form>
          <script>
            const tab = new URL(location.href).searchParams.get('tab');
            const manual = document.getElementById('manual');
            const organization = document.getElementById('organization');
            const report = (event) => fetch('/form-observation?' + new URLSearchParams({
              tab, event, manual: manual.value, organization: organization.value,
            }));
            document.querySelector('form').addEventListener('submit', event => {
              event.preventDefault();
              report('submit');
            });
            organization.addEventListener('input', () => report('input'));
            report('loaded');
            setInterval(async () => {
              const action = await (await fetch('/form-action?tab=' + encodeURIComponent(tab))).text();
              if (action === 'manual') {
                manual.value = 'Typed by the fixture user';
                await report('manual');
              } else if (action === 'occupied') {
                organization.value = 'Prior user input';
                await report('manual');
              } else if (action === 'navigate') {
                location.replace('/form?tab=replacement');
              } else if (action === 'snapshot') {
                await report('snapshot');
              }
            }, 100);
          </script>
        `);
        break;
      case '/form-action': {
        const tab = url.searchParams.get('tab');
        const action = actions.get(tab);
        actions.delete(tab);
        response.writeHead(200).end(action ?? '');
        break;
      }
      case '/form-observation': {
        const { tab, event, manual, organization } = Object.fromEntries(url.searchParams);
        observations.set(`form:${tab}:${event}`, { manual, organization });
        response.writeHead(204).end();
        break;
      }
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
    actions,
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

function rightDock({ client: [width, height], views }) {
  if (views.length !== 3) return false;
  const split = Math.floor(width / 2);
  const toolbarHeight = views[1][3];
  const expected = [
    [0, 0, split, height],
    [split, 0, width - split, toolbarHeight],
    [split, toolbarHeight, width - split, height - toolbarHeight],
  ];
  return toolbarHeight > 0 && toolbarHeight < height
    && expected.every((rect, index) => rect.every((value, field) => value === views[index][field]));
}

export async function runSiteBrowserWebview2Proof({
  automation, safe, fixture, browserDock, resizeWindow, startupBoundMs, workspaceId, formDialog,
}) {
  const site = await startSite();
  const invoke = (url) => automation.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(OPEN_LINK)}, {
    request: { url: ${JSON.stringify(url)}, language: 'en' },
  }).then(opened => ({ opened }), error => ({ code: error.code }))`);
  const shellCookie = JSON.stringify(site.shellCookie);
  async function waitFor(read, label, diagnostics) {
    const deadline = performance.now() + startupBoundMs;
    do {
      const value = await read();
      if (value !== undefined && value !== null) return value;
      await delay(50);
    } while (performance.now() < deadline);
    const lastState = diagnostics ? ` Last state: ${JSON.stringify(diagnostics())}` : '';
    throw new Error(`The WebView2 site fixture did not observe ${label}.${lastState}`);
  }
  function waitForDock(matches, label) {
    let state;
    return waitFor(async () => {
      state = await browserDock('state');
      return matches(state) ? state : undefined;
    }, label, () => state);
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
  async function proveFormHandoff() {
    const ipc = (command, args) => automation.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
    const workspace = (command) => ipc('workspace_command_v15', { command });
    const { snapshot: initial } = await workspace({
      type: 'createSession', workspaceId, harness: 'claude-code', title: 'Local form fixture', permissionMode: 'native',
    });
    const { id: sessionId } = initial.session;
    const snapshot = async () => (await workspace({ type: 'snapshot', sessionId })).snapshot;
    const replyCount = (current) => [...JSON.stringify(current.blocks).matchAll(/BROWSER_FORM_RESULT/g)].length;
    const enqueue = (text) => ipc('workspace_composer_v19', { command: {
      type: 'send', sessionId, requestId: randomUUID(), text, mode: 'prompt', attachments: [],
    } });
    async function inspectApproval(proposal) {
      const dialog = await waitFor(async () => {
        const reading = await formDialog('read');
        return reading.status === 'shown' ? reading : null;
      }, 'the native approval details');
      const canonical = new URL(proposal.url);
      assert.equal(dialog.details, `Адрес:\r\n${canonical.href}\r\n\r\nПоле:\r\nОрганизация\r\n\r\nЗначение:\r\n${proposal.value}`);
      assert(!site.observations.has(`form:${canonical.searchParams.get('tab')}:requested`),
        'The browser requested the site before native approval.');
    }
    async function send(text, beforeReply) {
      const before = replyCount(await snapshot());
      await enqueue(text);
      if (beforeReply) await beforeReply();
      const result = await waitFor(async () => {
        const current = await snapshot();
        return replyCount(current) > before && current.session.status === 'idle' ? current : null;
      }, 'the end of the Claude form-tool turn');
      return JSON.stringify(result.blocks.filter((block) => JSON.stringify(block).includes('BROWSER_FORM_RESULT')).at(-1));
    }
    const toolPrompt = (args) => 'fixture-browser-form ' + JSON.stringify(args);
    const tool = (args, answer) => send(toolPrompt(args), answer && (async () => {
      await inspectApproval(args);
      assert.equal((await formDialog(answer)).status, 'answered');
    }));
    const proposed = 'Approved organization';
    const proposal = (tab, parameters = '', value = proposed) =>
      ({ op: 'open', url: site.origin + '/form?tab=' + tab + parameters, field: 'organization', value });
    const open = (tab) => tool(proposal(tab), 'approve');
    const siteSnapshot = (tab) => {
      site.actions.set(tab, 'snapshot');
      return observed(`form:${tab}:snapshot`);
    };
    const ok = /BROWSER_FORM_RESULT.*ok\\?":true/;
    let closed = false;
    try {
      const declined = proposal('declined', '&next=' + 'Ж'.repeat(200), 'Élodie '.repeat(1024) + 'Север');
      assert.match(await tool(declined, 'cancel'), /not-approved/);
      assert(!site.observations.has('form:declined:requested'), 'The browser opened a declined address.');
      const credentials = proposal('credentials');
      credentials.url = credentials.url.replace('://', '://@');
      assert.match(await tool(credentials), /invalid-address/);
      assert.match(await tool(proposal('hidden-control', '', 'Север\u202eLtd')), /invalid-value/);
      assert(!site.observations.has('form:hidden-control:requested'), 'The hidden text triggered navigation.');

      assert.match(await open('owned'), ok);
      assert.match(await tool({ op: 'fill' }), /awaiting-person/);
      site.actions.set('owned', 'manual');
      await observed('form:owned:manual');
      assert.equal(await openThroughChat('/form?tab=other'), true);
      assert.deepEqual(await observed('form:other:loaded'), { manual: '', organization: '' });
      assert.match(await send('Готово'), ok);
      assert.deepEqual(await observed('form:owned:input'), { manual: 'Typed by the fixture user', organization: proposed });
      assert.deepEqual(await siteSnapshot('other'), { manual: '', organization: '' }, 'An unrelated active tab received the write.');
      assert(!site.observations.has('form:owned:submit'), 'The host submitted the form.');
      assert.match(await tool({ op: 'fill' }), /already-used/);

      assert.match(await open('occupied'), ok);
      site.actions.set('occupied', 'occupied');
      await observed('form:occupied:manual');
      assert.match(await send('Готово'), /field-unavailable/);
      assert.deepEqual(await siteSnapshot('occupied'), { manual: '', organization: 'Prior user input' }, 'The host overwrote an occupied field.');

      assert.match(await open('navigating'), ok);
      site.actions.set('navigating', 'navigate');
      await observed('form:replacement:loaded');
      assert.match(await send('Готово'), /document-changed/);
      assert.deepEqual(await siteSnapshot('replacement'), { manual: '', organization: '' }, 'The host wrote in a replacement document.');
      const pending = proposal('closed-session');
      await enqueue(toolPrompt(pending));
      await inspectApproval(pending);
      await workspace({ type: 'closeSession', sessionId });
      closed = true;
      await waitFor(async () => (await formDialog('read')).status === 'waiting' ? true : null,
        'closing the owned native approval with the session');
      assert(!site.observations.has('form:closed-session:requested'), 'Closing the session opened the pending site.');
      return ['webview2-claude-form-handoff-after-local-ready', 'webview2-form-keeps-manual-input-and-bound-tab',
        'webview2-form-refuses-occupied-field-and-replacement-document',
        'webview2-form-approval-displays-full-address-and-value-and-retires-on-close'];
    } finally {
      if (!closed) await workspace({ type: 'closeSession', sessionId });
    }
  }
  try {
    if (safe) {
      assert.deepEqual(await invoke(site.origin + '/first'), { code: 'UNAVAILABLE' });
      assert.equal(await openThroughChat('/first'), false);
      return { checks: ['webview2-safe-mode-refuses-site-browser-links'] };
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
    await waitForDock(rightDock, 'the toolbar and site occupying the right half of the owned window');
    const opened = await waitForDock((state) => state.toolbar?.closeButtonVisible && state.toolbar.addressFocused,
      'the browser close button and focused address field');
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
    const resized = await waitForDock((state) => rightDock(state) && state.client[0] !== opened.client[0],
      'the resized native right dock');
    await observed('first-tab-pending');
    await browserDock('close');
    await waitFor(async () => {
      const layout = await workbench();
      return layout.focus && layout.composerFocused && layout.composerReady && Math.abs(layout.width - resizedWidth) <= 1
        ? layout : undefined;
    }, 'the visible, focused workbench restored to full width');
    const closed = await waitForDock(
      ({ client: [width, height], views }) => views.length === 1
        && [0, 0, width, height].every((value, field) => value === views[0][field]),
      'only the full-width workbench to remain visible',
    );
    assert.equal(await openThroughChat('/second'), true);
    await waitFor(async () => {
      const layout = await workbench();
      return layout.composerReady && Math.abs(layout.width - resizedWidth / 2) <= 1 ? layout : undefined;
    }, 'the reopened dock beside the workbench');
    assert.equal(await observed('shared-profile'), true, 'Site tabs used different browsing profiles.');
    assert.equal(await observed('first-tab-retained'), true, 'Opening the second link discarded the first tab.');
    assert(!site.observations.has('unexpected'), 'The untrusted page caused a navigation.');
    assertSiteProfile(fixture);
    const formChecks = await proveFormHandoff();
    const checks = [
      'webview2-trusted-main-opens-new-and-existing-site-browser',
      'webview2-browser-dock-resizes-both-views-and-restores-workbench-on-close',
      'webview2-site-browser-reuses-profile-and-preserves-tabs',
      'webview2-site-browser-profile-excludes-shell-cookie',
      authority.link === 'denied' ? 'webview2-site-page-ipc-rejected' : 'webview2-site-page-ipc-bridge-absent',
      'webview2-chat-link-host-refuses-invalid-and-app-origins',
      ...formChecks,
    ];
    return { checks, dockMeasurements: { opened, resized, closed } };
  } finally {
    await site.close();
  }
}
