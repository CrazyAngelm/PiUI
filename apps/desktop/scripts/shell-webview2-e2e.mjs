// New-shell (default view) proof for the Windows Tauri/WebView2 harness.
//
// Like the workspace proof, this module owns no processes: the outside
// controller's Job Object owns them all. It drives the default view of the
// debug app (isolated app data and WebView2 profile) through the typed host,
// never starts a native agent and never reads credentials.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

function assertion(value, message) {
  if (!value) throw new Error(message);
}

function normalizedMilliseconds(value) {
  return Math.max(0, Math.round(value));
}

/** A JS expression finding the first button whose aria-label or visible text (without key hints) is `name`. */
function buttonExpression(name, root = 'document') {
  return `(() => {
    const scope = ${root};
    if (!scope) return null;
    const wanted = ${JSON.stringify(name)};
    return [...scope.querySelectorAll('button')].find((button) => {
      if (button.getAttribute('aria-label') === wanted) return true;
      const clone = button.cloneNode(true);
      clone.querySelectorAll('kbd, .kbd, [aria-hidden="true"]').forEach((child) => child.remove());
      return clone.textContent?.trim() === wanted;
    }) ?? null;
  })()`;
}

/**
 * Run the default-view proof inside the real Tauri WebView2 process.
 * `mode` is `normal` (fresh isolated data) or `safe` (the same data, restarted
 * with `--safe-mode`).
 */
export async function runShellWebview2Proof({
  automation,
  expectedPageUrl,
  harness,
  mode,
  commandBoundMs,
  startupBoundMs,
  captureScreenshot,
}) {
  if (!automation || typeof automation.evaluate !== 'function' || typeof automation.dispatchKey !== 'function') {
    throw new TypeError('Shell E2E requires the authenticated WebView automation client.');
  }
  if (typeof expectedPageUrl !== 'string' || !expectedPageUrl.startsWith('http://127.0.0.1:')) {
    throw new TypeError('Shell E2E requires the exact loopback page URL.');
  }
  if (!harness?.fixture || !harness?.ownedChild) {
    throw new TypeError('Shell E2E requires the controller-owned fixture and contained Tauri child.');
  }
  if (mode !== 'normal' && mode !== 'safe') throw new TypeError('Shell E2E mode must be normal or safe.');
  if (!Number.isSafeInteger(commandBoundMs) || commandBoundMs <= 0 || !Number.isSafeInteger(startupBoundMs) || startupBoundMs < commandBoundMs) {
    throw new TypeError('Shell E2E requires the launcher command and startup bounds.');
  }
  const screenshotRoot = join(harness.fixture.fixtureRoot, 'workspace-screenshots');
  if (!isAbsolute(screenshotRoot) || relative(harness.fixture.fixtureRoot, screenshotRoot).startsWith('..')) {
    throw new TypeError('Shell E2E screenshot output must stay inside its controller-owned fixture.');
  }

  const startedAt = performance.now();
  const checks = [];
  const screenshots = [];
  const timings = {};

  async function evaluate(expression) {
    return automation.evaluate(expression);
  }

  async function waitFor(expression, label, boundMs = commandBoundMs) {
    const deadline = performance.now() + boundMs;
    let lastError;
    while (performance.now() < deadline) {
      try {
        if (await evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        lastError = error;
        if (!(error instanceof Error) || !error.message.includes('Execution context was destroyed')) throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const diagnostic = await evaluate(`JSON.stringify({ href: location.pathname + location.search, heading: document.querySelector('main h1')?.textContent?.trim(), dialogs: [...document.querySelectorAll('[role=dialog]')].map((dialog) => dialog.getAttribute('aria-labelledby') ? document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent : dialog.getAttribute('aria-label')), alerts: [...document.querySelectorAll('[role=alert]')].map((alert) => alert.textContent?.trim()) })`).catch(() => 'unavailable');
    throw new Error(`${label} did not become true within the launcher bound: ${diagnostic}${lastError ? ` Last error: ${lastError.message}` : ''}`);
  }

  async function invoke(command, args) {
    return evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
  }

  async function catalog() {
    const result = await invoke('workspace_command_v15', { command: { type: 'catalog' } });
    assertion(result?.type === 'catalog' && result.catalog?.protocol === 15, 'The host did not return the workspace v15 catalog.');
    return result.catalog;
  }

  async function click(name, root = 'document', label = `button “${name}”`) {
    await waitFor(`(() => { const button = ${buttonExpression(name, root)}; return button && !button.disabled; })()`, `enabled ${label}`);
    await evaluate(`(${buttonExpression(name, root)}).click()`);
  }

  async function focusButton(name, root = 'document') {
    const focused = await evaluate(`(() => { const button = ${buttonExpression(name, root)}; button?.focus(); return button !== null && document.activeElement === button; })()`);
    assertion(focused, `Could not focus button “${name}”.`);
  }

  async function waitForShell() {
    await waitFor(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 'Tauri invoke bridge', startupBoundMs);
    await waitFor(`document.querySelector('nav[aria-label="Workspace navigation"], nav[aria-label="Навигация рабочей области"]') && document.querySelector('main#main')`, 'default-view shell', startupBoundMs);
    const href = automation.currentPage?.href ?? '';
    assertion(!href.includes('view='), `The shell proof must run the default view, not ${href}.`);
  }

  async function reload() {
    const before = automation.generation;
    await automation.reload();
    const deadline = performance.now() + startupBoundMs;
    while (performance.now() < deadline) {
      const page = automation.currentPage;
      if (automation.generation > before && page?.href.startsWith(expectedPageUrl)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assertion(automation.generation > before, 'The WebView did not return after reload.');
    await waitForShell();
  }

  async function capture(name) {
    if (typeof captureScreenshot !== 'function') return;
    const path = join(screenshotRoot, `${name}.png`);
    const returned = await captureScreenshot({ name, path });
    assertion(returned === path && existsSync(path), `Screenshot ${name} was not captured from the native window.`);
    assertion(readFileSync(path).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Screenshot ${name} is not a PNG.`);
    screenshots.push(path);
  }

  const sidebar = `document.querySelector('nav[aria-label="Workspace navigation"]')`;
  const settingsNav = `document.querySelector('nav[aria-label="Settings sections"]')`;
  const dialog = `document.querySelector('[role="dialog"]')`;

  if (mode === 'safe') {
    const phase = performance.now();
    await waitForShell();
    await click('New chat', sidebar);
    await waitFor(`document.querySelector('#home-title')`, 'Home in safe mode');
    const safe = await evaluate(`(() => ({
      banner: [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent?.includes('Safe mode: history is read-only and agents are not started.')),
      message: document.querySelector('textarea[aria-label="Message"]')?.disabled ?? null,
      start: ${buttonExpression('Start chat')}?.disabled ?? null,
    }))()`);
    assertion(safe.banner, 'Safe mode did not show its read-only banner in the default view.');
    assertion(safe.message === true && safe.start === true, `Safe mode left the new-chat composer enabled: ${JSON.stringify(safe)}`);
    const snapshot = await catalog();
    assertion(snapshot.safeMode === true, 'The host catalog did not report safe mode.');
    assertion(snapshot.workspaces.some((workspace) => !workspace.personal && workspace.trust === 'trusted'), 'Safe mode lost the trusted fixture project from the readable catalog.');
    await waitFor(`${sidebar} && [...${sidebar}.querySelectorAll('button[aria-expanded]')].length >= 2`, 'safe-mode project tree');
    await capture('shell-safe-mode');
    timings.safe = normalizedMilliseconds(performance.now() - phase);
    checks.push('shell-safe-mode-banner', 'shell-safe-mode-composer-disabled', 'shell-safe-mode-catalog-readable');
    timings.total = normalizedMilliseconds(performance.now() - startedAt);
    return { checks, screenshots, timings };
  }

  // 1. The default view is the new shell with its landmarks.
  let phase = performance.now();
  await waitForShell();
  const shell = await evaluate(`(() => ({
    main: document.querySelector('main#main')?.getAttribute('tabindex') === '-1',
    skip: document.querySelector('a[href="#main"]')?.textContent?.trim() === 'Skip to main content',
    home: document.querySelector('#home-title')?.textContent?.trim(),
    legacy: document.querySelector('.view-switch, #workspace-main, aside .utilities') !== null,
    classic: document.querySelector('.project-group, dialog.add-project-modal, .settings-nav') !== null,
    nav: ['New chat', 'Search', 'Pipelines', 'Runs', 'Automations', 'Settings'].every((name) => {
      const scope = ${sidebar};
      return scope !== null && [...scope.querySelectorAll('button')].some((button) => {
        const clone = button.cloneNode(true);
        clone.querySelectorAll('kbd, .kbd, [aria-hidden="true"]').forEach((child) => child.remove());
        return clone.textContent?.trim() === name;
      });
    }),
  }))()`);
  assertion(shell.main && shell.skip && shell.nav, `The default view lost a landmark or navigation label: ${JSON.stringify(shell)}`);
  assertion(shell.home === 'What should we work on?', `The default view did not open Home: ${JSON.stringify(shell)}`);
  assertion(!shell.legacy && !shell.classic, 'The default view rendered the legacy or classic shell.');
  await capture('shell-home-system-theme');
  timings.startup = normalizedMilliseconds(performance.now() - phase);
  checks.push('shell-default-view', 'shell-landmarks-and-labels');

  // 2. A project registered through the typed host appears restricted.
  phase = performance.now();
  const projectPath = harness.fixture.piProject;
  const added = await invoke('add_project_v10', { path: projectPath, agentKind: 'pi' });
  assertion(typeof added?.id === 'string' && typeof added?.name === 'string', 'The typed host did not register the isolated project.');
  await reload();
  const projectRow = `[...${sidebar}.querySelectorAll('button[aria-expanded]')].find((button) => button.textContent?.includes(${JSON.stringify(added.name)}))`;
  await waitFor(projectRow, 'registered project in the sidebar', startupBoundMs);
  assertion(await evaluate(`Boolean(${projectRow}?.querySelector('[title="Restricted until you trust this folder"]'))`), 'A new project was not marked restricted.');
  let snapshot = await catalog();
  assertion(snapshot.workspaces.find((workspace) => workspace.id === added.id)?.trust !== 'trusted', 'A new project was trusted without a decision.');
  checks.push('typed-host-project-registration', 'new-project-restricted');

  // 3. Trust is an explicit, labelled, non-sandbox decision with a focus trap.
  await click('Settings', sidebar);
  await waitFor(settingsNav, 'Settings');
  await click('Projects', settingsNav);
  const reviewButton = `[...document.querySelectorAll('article')].find((card) => card.textContent?.includes(${JSON.stringify(added.name)}))`;
  await waitFor(`${reviewButton}`, 'project card in Settings');
  // Activate the trigger the way a keyboard user does: focus, then press.
  await focusButton('Review trust…', reviewButton);
  await evaluate(`document.activeElement.click()`);
  await waitFor(`${dialog}?.textContent?.includes(${JSON.stringify(`Trust ${added.name}?`)})`, 'trust dialog');
  const trust = await evaluate(`(() => {
    const node = ${dialog};
    const title = node.getAttribute('aria-labelledby') ? document.getElementById(node.getAttribute('aria-labelledby'))?.textContent : '';
    return { title, warning: node.textContent.includes('Trust is not a sandbox.'), inside: node.contains(document.activeElement) };
  })()`);
  assertion(trust.title === `Trust ${added.name}?` && trust.warning, `Project trust was not an explicit, labelled non-sandbox decision: ${JSON.stringify(trust)}`);
  assertion(trust.inside, 'Opening the trust dialog did not move focus inside it.');
  await focusButton('Trust folder', dialog);
  await automation.dispatchKey({ key: 'Tab', code: 'Tab' });
  assertion(await evaluate(`${dialog}.contains(document.activeElement) && document.activeElement !== ${buttonExpression('Trust folder', dialog)}`), 'Tab escaped the trust dialog.');
  await automation.dispatchKey({ key: 'Tab', code: 'Tab', shiftKey: true });
  assertion(await evaluate(`${dialog}.contains(document.activeElement)`), 'Shift+Tab escaped the trust dialog.');
  await automation.dispatchKey({ key: 'Escape', code: 'Escape' });
  await waitFor(`!${dialog}`, 'trust dialog closes with Escape');
  await waitFor(`document.activeElement === (${buttonExpression('Review trust…', reviewButton)})`, 'focus returns to the trust trigger');
  snapshot = await catalog();
  assertion(snapshot.workspaces.find((workspace) => workspace.id === added.id)?.trust !== 'trusted', 'Escape trusted the project.');
  await click('Review trust…', reviewButton);
  await waitFor(`${dialog}`, 'trust dialog again');
  await click('Trust folder', dialog);
  await waitFor(`!${dialog}`, 'trust dialog closes after the decision');
  snapshot = await catalog();
  assertion(snapshot.workspaces.find((workspace) => workspace.id === added.id)?.trust === 'trusted', 'The visible trust action did not reach the typed host catalog.');
  await waitFor(`${reviewButton}?.textContent?.includes('Trusted')`, 'trusted state in Settings');
  timings.projectTrust = normalizedMilliseconds(performance.now() - phase);
  checks.push('explicit-ui-project-trust', 'trust-dialog-focus-trap', 'trust-dialog-escape-focus-restore');

  // 4. The command palette opens from the sidebar and Escape restores focus.
  await focusButton('Search', sidebar);
  await evaluate(`document.activeElement.click()`);
  await waitFor(`document.querySelector('[role="dialog"] input[role="combobox"]') === document.activeElement`, 'palette search focused');
  await automation.dispatchKey({ key: 'Escape', code: 'Escape' });
  await waitFor(`!${dialog}`, 'palette closes with Escape');
  await waitFor(`document.activeElement === (${buttonExpression('Search', sidebar)})`, 'focus returns to Search');
  checks.push('palette-escape-focus-restore');

  // 5. The theme is a host preference that survives a reload.
  phase = performance.now();
  await click('Settings', sidebar);
  await click('General', settingsNav);
  const themeGroup = `document.querySelector('[role="group"][aria-label="Theme"]')`;
  await waitFor(themeGroup, 'theme control');
  await click('Light', themeGroup);
  await waitFor(`document.documentElement.dataset.theme === 'light'`, 'light theme applied');
  const lightBackground = await evaluate(`getComputedStyle(document.body).backgroundColor`);
  await capture('shell-settings-light');
  await click('Dark', themeGroup);
  await waitFor(`document.documentElement.dataset.theme === 'dark'`, 'dark theme applied');
  const darkBackground = await evaluate(`getComputedStyle(document.body).backgroundColor`);
  assertion(lightBackground !== darkBackground, `Light and dark themes render the same background (${lightBackground}).`);
  await reload();
  await waitFor(`document.documentElement.dataset.theme === 'dark'`, 'dark theme restored from the host after reload', startupBoundMs);
  await capture('shell-settings-dark');
  await click('Settings', sidebar);
  await click('System', `document.querySelector('[role="group"][aria-label="Theme"]')`);
  await waitFor(`document.documentElement.dataset.theme === 'system'`, 'system theme restored');
  timings.theme = normalizedMilliseconds(performance.now() - phase);
  checks.push(`theme-persisted-by-host (${lightBackground} → ${darkBackground})`);

  // 6. Russian copy renders, persists and leaves user content alone.
  await click('Русский', `document.querySelector('[role="group"][aria-label="Language"]')`);
  await waitFor(`document.documentElement.lang === 'ru' && document.querySelector('nav[aria-label="Навигация рабочей области"]')`, 'Russian navigation');
  await reload();
  await waitFor(`document.documentElement.lang === 'ru'`, 'Russian persisted after reload', startupBoundMs);
  const russian = await evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label="Навигация рабочей области"]');
    return {
      newChat: [...nav.querySelectorAll('.nav-item__label')].some((label) => label.textContent?.trim() === 'Новый чат'),
      project: [...nav.querySelectorAll('button[aria-expanded]')].some((button) => button.textContent?.includes(${JSON.stringify(added.name)})),
    };
  })()`);
  assertion(russian.newChat && russian.project, `Russian copy did not render or translated user content: ${JSON.stringify(russian)}`);
  await click('Настройки', `document.querySelector('nav[aria-label="Навигация рабочей области"]')`);
  await click('English', `document.querySelector('[role="group"][aria-label="Язык"]')`);
  await waitFor(`document.documentElement.lang === 'en' && ${sidebar}`, 'English restored');
  checks.push('russian-copy-persisted-user-content-untranslated');

  // 7. Pipelines open their editor in the new shell.
  await click('Pipelines', sidebar);
  await waitFor(`document.querySelector('section[aria-label="Pipeline editor"]')`, 'pipeline editor', startupBoundMs);
  checks.push('pipelines-view-default-shell');

  // 8. Home keeps a usable composer outside safe mode.
  await click('New chat', sidebar);
  await waitFor(`document.querySelector('#home-title') && document.querySelector('textarea[aria-label="Message"]')?.disabled === false`, 'enabled new-chat composer');
  checks.push('home-composer-enabled');

  timings.total = normalizedMilliseconds(performance.now() - startedAt);
  return { checks, screenshots, timings, cleanup: { workspaceId: added.id } };
}
