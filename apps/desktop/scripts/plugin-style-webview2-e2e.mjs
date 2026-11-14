// Real plugin registry, manifest verification, Settings handlers and CSSOM in
// Tauri/WebView2. Only the outer controller's owned fixture is written here.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const PLUGIN_ID = 'example.paper-style';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function owned(root, candidate) {
  const relation = relative(realpathSync(root), realpathSync(candidate));
  assert(relation === '' || (!relation.startsWith('..') && !isAbsolute(relation)), 'Plugin style fixture escaped the controller-owned root.');
}

/** Seed installed state; the real host still verifies its schema, hash and trust. */
export function seedPluginStyleFixture(fixture, repositoryRoot) {
  owned(fixture.fixtureRoot, fixture.tauriAppData);
  const source = join(repositoryRoot, 'examples', 'plugins', 'paper-style');
  const directory = join(fixture.tauriAppData, 'plugins-v1');
  const target = join(directory, 'packages', 'paper-style');
  mkdirSync(target, { recursive: true });
  mkdirSync(join(directory, 'data', 'paper-style'), { recursive: true });
  owned(fixture.fixtureRoot, target);
  const files = readdirSync(source, { withFileTypes: true }).map((entry) => {
    assert(entry.isFile() && !entry.isSymbolicLink(), 'The declarative style fixture must contain only plain package files.');
    const destination = join(target, entry.name);
    copyFileSync(join(source, entry.name), destination);
    owned(fixture.fixtureRoot, destination);
    return { path: entry.name, bytes: readFileSync(destination) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  // Exactly crates/piui-plugins/src/package.rs::code_hash (also plugin-check.mjs).
  const hash = createHash('sha256').update('piui-plugin-package-v1\n');
  for (const file of files) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(file.bytes.length));
    hash.update(file.path).update(Buffer.from([0])).update(length).update(createHash('sha256').update(file.bytes).digest());
  }
  const manifest = JSON.parse(readFileSync(join(target, 'piui-plugin.json'), 'utf8'));
  assert(manifest.id === PLUGIN_ID && manifest.schemaVersion === 3 && manifest.permissions.length === 0 && !manifest.backend && !manifest.ui, 'The native style fixture must remain the declarative v3 example.');
  const document = {
    version: 1, generation: 0,
    plugins: [{
      id: manifest.id, name: manifest.name, publisher: manifest.publisher, version: manifest.version,
      source: { type: 'installed', directory: 'paper-style' }, codeHash: hash.digest('hex'), permissions: [],
      enabled: true, installedAt: new Date().toISOString(), dataDirectory: 'paper-style',
    }],
    activeTheme: { pluginId: PLUGIN_ID, themeId: 'terminal' },
  };
  // Registry filenames/generation are the existing plugins registry-v1 format.
  writeFileSync(join(directory, 'registry-00000000000000000000.json'), JSON.stringify(document), { flag: 'wx' });
}

function buttonExpression(name, selector) {
  return `(() => {
    const scope = document.querySelector(${JSON.stringify(selector)});
    if (!scope) return null;
    return [...scope.querySelectorAll('button')].find(button => {
      if (button.getAttribute('aria-label') === ${JSON.stringify(name)}) return true;
      const clone = button.cloneNode(true);
      clone.querySelectorAll('kbd, .kbd, [aria-hidden="true"]').forEach(child => child.remove());
      return clone.textContent.trim() === ${JSON.stringify(name)};
    }) ?? null;
  })()`;
}

export async function runPluginStyleWebview2Proof({ automation, safe, fixture, commandBoundMs, startupBoundMs, captureScreenshot }) {
  const checks = [];
  const screenshots = [];
  const invoke = (command, args) => automation.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
  const registry = async () => (await invoke('plugins_v1', { command: { type: 'list' } })).registry;
  const style = () => invoke('plugin_style_v1', { request: {} });
  async function waitFor(read, accept, label, bound = commandBoundMs) {
    const deadline = performance.now() + bound;
    let last;
    do {
      last = await read();
      if (accept(last)) return last;
      // Match the existing shell WebView harness's polling cadence.
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    } while (performance.now() < deadline);
    throw new Error(`${label} did not reach its expected state: ${JSON.stringify(last)}`);
  }
  const css = () => automation.evaluate(`(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return { active: root.dataset.pluginStyle, theme: root.dataset.pluginTheme,
      appearance: root.dataset.theme, radius: style.getPropertyValue('--piui-radius-md').trim(),
      marker: style.getPropertyValue('--piui-decoration-marker-shape').trim(),
      font: style.getPropertyValue('--piui-font-ui').trim() };
  })()`);
  async function click(name, selector) {
    const expression = buttonExpression(name, selector);
    await waitFor(() => automation.evaluate(`Boolean((${expression}) && !(${expression}).disabled)`), Boolean, `enabled ${name}`, startupBoundMs);
    assert(await automation.evaluate(`(() => { const button = ${expression}; button.focus(); const focused = document.activeElement === button; button.click(); return focused; })()`), `Could not focus ${name}.`);
  }
  async function capture(name) {
    const path = join(fixture.fixtureRoot, 'workspace-screenshots', `${name}.png`);
    const result = await captureScreenshot({ name, path });
    assert(result === path && existsSync(path), 'Native plugin style screenshot was not captured.');
    screenshots.push(path);
  }
  const first = await waitFor(registry, value => value.checked, 'native plugin verification', startupBoundMs);
  const plugin = first.plugins.find(item => item.id === PLUGIN_ID);
  assert(plugin?.enabled && plugin.problems.length === 0 && plugin.contributes.themes.length === 2, 'Installed style fixture was not verified by the native host.');
  assert(plugin.active === !safe && first.safeMode === safe, 'Native plugin activation did not match safe mode.');
  checks.push('webview2-real-host-verifies-installed-style-fixture');
  await click('Settings', 'nav[aria-label="Workspace navigation"]');
  await waitFor(() => automation.evaluate('Boolean(document.querySelector(\'nav[aria-label="Settings sections"]\'))'), Boolean, 'Settings owner', startupBoundMs);

  if (safe) {
    const hidden = await style();
    assert(hidden.protocol === 1 && hidden.revision === first.revision && hidden.theme === undefined && hidden.style === undefined, 'Safe mode exposed a selected plugin style.');
    await waitFor(css, value => value.active === undefined && value.theme === undefined && value.radius === '10px' && value.marker === 'none' && value.font.includes('Segoe UI'), 'safe-mode built-in style');
    assert(await automation.evaluate('document.querySelector("#plugin-theme") === null'), 'Safe mode exposed plugin style selection.');
    const refusal = await automation.evaluate(`window.__TAURI_INTERNALS__.invoke('plugins_v1', { command: { type: 'setTheme', expectedRevision: ${first.revision}, theme: { pluginId: ${JSON.stringify(PLUGIN_ID)}, themeId: 'paper' } } }).then(() => null, error => error.code)`);
    assert(refusal === 'SAFE_MODE', 'Safe mode did not refuse a plugin selection mutation.');
    await capture('plugin-style-safe');
    checks.push('webview2-safe-selected-plugin-style-hidden', 'webview2-safe-style-mutation-refused', 'webview2-safe-base-style-and-no-unused-selector');
    return { checks, screenshots };
  }

  const persisted = await style();
  assert(persisted.theme?.pluginId === PLUGIN_ID && persisted.theme.themeId === 'terminal' && persisted.style?.corners === 'square', 'Native style read did not restore its stored selection.');
  async function select(themeId) {
    await waitFor(() => automation.evaluate('Boolean(document.querySelector("#plugin-theme") && !document.querySelector("#plugin-theme").disabled)'), Boolean, 'plugin theme selector', startupBoundMs);
    const value = JSON.stringify([PLUGIN_ID, themeId]);
    assert(await automation.evaluate(`(() => {
      const select = document.querySelector('#plugin-theme');
      select.focus(); const focused = document.activeElement === select;
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return focused;
    })()`), 'Plugin theme selector could not receive focus.');
    const selected = await waitFor(style, value => value.theme?.themeId === themeId, `native ${themeId} selection`);
    const current = await registry();
    assert(selected.revision === current.revision && current.activeTheme?.themeId === themeId, 'Style read lost its registry revision/identity binding.');
  }
  await select('paper');
  await waitFor(css, value => value.active === 'true' && value.appearance === 'light' && value.radius === '16px' && value.marker === 'none' && value.font.includes('Segoe UI'), 'Paper geometry/font');
  await capture('plugin-style-paper');
  await select('terminal');
  await waitFor(css, value => value.active === 'true' && value.appearance === 'dark' && value.radius === '0px' && value.marker === 'polygon(40% 0, 100% 0, 60% 100%, 0 100%)' && value.font.includes('Cascadia Code'), 'Terminal geometry/font');
  await capture('plugin-style-terminal');
  checks.push('webview2-settings-selects-style-through-native-owner', 'webview2-paper-and-terminal-geometry-font-and-appearance');

  await click('Plugins', 'nav[aria-label="Settings sections"]');
  const toggle = `document.querySelector('[role="switch"][aria-label="Enable Paper style"]')`;
  await waitFor(() => automation.evaluate(`Boolean(${toggle} && !${toggle}.disabled)`), Boolean, 'native plugin enable switch', startupBoundMs);
  const flip = () => automation.evaluate(`(() => { const toggle = ${toggle}; toggle.focus(); const focused = document.activeElement === toggle; toggle.click(); return focused; })()`);
  assert(await flip(), 'Could not focus the native plugin disable switch.');
  await waitFor(style, value => value.theme === undefined && value.style === undefined, 'disabled native style');
  await waitFor(css, value => value.active === undefined && value.theme === undefined && value.radius === '10px' && value.marker === 'none' && value.font.includes('Segoe UI'), 'disabled plugin restores built-in style');
  await capture('plugin-style-disabled');
  assert(await flip(), 'Could not focus the native plugin enable switch.');
  await waitFor(style, value => value.theme?.themeId === 'terminal' && value.style?.font === 'mono', 're-enabled native style');
  await waitFor(css, value => value.active === 'true' && value.radius === '0px' && value.font.includes('Cascadia Code'), 're-enabled plugin restores selected style');
  checks.push('webview2-disable-removes-native-style-and-restores-base', 'webview2-enable-restores-persisted-style');
  return { checks, screenshots };
}
