// Current production native composer components in the actual WebView2. Home
// keeps its real owner; the reply fixture has a synthetic owner and uses the
// unchanged host refusal path. Successful queue operations are proved in Lab.
import { join } from 'node:path';

export async function runComposerWebview2Proof({ automation, safe, fixture, commandBoundMs, startupBoundMs, captureScreenshot }) {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const began = performance.now();
  const checks = [];
  const screenshots = [];
  const timings = {};
  const module = "import('/e2e/composer-native-fixture.ts')";
  const homeInput = 'main textarea[aria-label="Message"]';
  const replyInput = '[data-composer-proof] textarea[aria-label="Message"]';
  async function waitFor(expression, label, bound = commandBoundMs) {
    const deadline = performance.now() + bound;
    do {
      if (await automation.evaluate(`Boolean(${expression})`)) return;
      await new Promise(resolve => setTimeout(resolve, 50)); // Existing native harness polling cadence.
    } while (performance.now() < deadline);
    throw new Error(`The native composer did not reach ${label}.`);
  }
  async function fill(selector, text) {
    await automation.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.focus(); input.value = ${JSON.stringify(text)}; input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText' }));
    })()`);
  }
  const geometry = selector => automation.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const css = getComputedStyle(input);
    return { height:input.getBoundingClientRect().height, line:Number.parseFloat(css.lineHeight), padding:Number.parseFloat(css.paddingTop)+Number.parseFloat(css.paddingBottom), shared:input.dataset.nanoComposer, boxSizing:css.boxSizing };
  })()`);
  async function capture(name) {
    const path = join(fixture.fixtureRoot, 'workspace-screenshots', `${name}.png`);
    await captureScreenshot({ name, path }); screenshots.push(path);
  }
  await waitFor(`document.querySelector(${JSON.stringify(homeInput)})?.dataset.nanoComposer === 'editor'`, 'actual Home editor', startupBoundMs);
  timings.homeReady = Math.round(performance.now() - began);
  if (safe) {
    // Home paints before the asynchronous native catalog arrives. Match the
    // existing shell proof: wait for owner safe-mode state, not just its DOM.
    await waitFor(`document.querySelector(${JSON.stringify(homeInput)})?.disabled === true && document.querySelector('main [data-nano-composer="send"]')?.disabled === true`, 'safe-mode owner disables Home', startupBoundMs);
    const disabled = await automation.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(homeInput)});
      const send = document.querySelector('main [data-nano-composer="send"]');
      return input.disabled && send.disabled;
    })()`);
    const catalog = await automation.evaluate("window.__TAURI_INTERNALS__.invoke('workspace_command_v15', {command:{type:'catalog'}})");
    assert(disabled && catalog.catalog.safeMode, 'Safe mode did not disable the real Home composer.');
    await capture('shared-composer-safe-home');
    checks.push('webview2-shared-composer-real-home-safe-mode-disabled');
    return { checks, screenshots, timings };
  }
  const initial = await geometry(homeInput);
  assert(initial.shared === 'editor' && initial.boxSizing === 'border-box' && Math.round(initial.height) === Math.round(initial.line * 3 + initial.padding), 'Home lost its authoritative three-row shared geometry.');
  const resizeStarted = performance.now();
  await fill(homeInput, 'Native Home draft\n'.repeat(8));
  await waitFor(`document.querySelector(${JSON.stringify(homeInput)}).getBoundingClientRect().height > ${initial.height}`, 'Home resize');
  // Includes authenticated automation round trips; this is observed proof cost,
  // not a new performance gate or a provider/startup benchmark.
  timings.homeResizeRoundTrip = Math.round(performance.now() - resizeStarted);
  const ime = await automation.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(homeInput)});
    const event = new KeyboardEvent('keydown', {key:'Enter',isComposing:true,bubbles:true,cancelable:true});
    input.dispatchEvent(event); return {prevented:event.defaultPrevented,value:input.value};
  })()`);
  assert(!ime.prevented && ime.value === 'Native Home draft\n'.repeat(8), 'IME Enter submitted or changed the native Home draft.');
  await capture('shared-composer-native-home');
  checks.push('webview2-real-home-shared-rows-resize-and-ime');

  try {
    const replyStarted = performance.now();
    await automation.evaluate(`${module}.then(module => module.beginComposerProof())`);
    await waitFor("document.querySelector('[data-composer-proof] [role=alert]')?.textContent.includes('no longer available')", 'real host unknown-session refusal', startupBoundMs);
    timings.replyMountAndHostRefusal = Math.round(performance.now() - replyStarted);
    const reply = await geometry(replyInput);
    assert(reply.shared === 'editor' && Math.round(reply.height) === Math.round(reply.line + reply.padding), 'Reply lost its authoritative one-row shared geometry.');
    await fill(replyInput, '/ru');
    await waitFor("document.querySelector('[data-composer-proof] [role=listbox]')", 'native slash menu');
    await automation.dispatchKey({ key:'Tab', code:'Tab' });
    await waitFor(`document.querySelector(${JSON.stringify(replyInput)}).value === '/run'`, 'menu consumes Tab before shared submission');
    await fill(replyInput, 'Retained after real host refusal');
    // Untrusted DOM events prove shared key intent routing, not OS text insertion.
    // Persistent Edge Lab tests separately use real keyboard Enter/Shift+Enter.
    const intents = await automation.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(replyInput)});
      const shift = new KeyboardEvent('keydown', {key:'Enter',shiftKey:true,bubbles:true,cancelable:true}); input.dispatchEvent(shift);
      const ime = new KeyboardEvent('keydown', {key:'Enter',isComposing:true,bubbles:true,cancelable:true}); input.dispatchEvent(ime);
      const send = new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}); input.dispatchEvent(send);
      return {shift:shift.defaultPrevented,ime:ime.defaultPrevented,send:send.defaultPrevented};
    })()`);
    assert(!intents.shift && !intents.ime && intents.send, 'The native reply did not keep shared newline/IME/submit intents.');
    const state = await automation.evaluate(`${module}.then(module => module.composerProofState())`);
    assert(state.draft === 'Retained after real host refusal' && state.value === state.draft && state.sendDisabled && state.modelDisabled, 'Host refusal lost the native draft or enabled unavailable controls.');
    const controls = await automation.evaluate(`([...document.querySelectorAll('[data-composer-proof] button')].map(button => {
      const clone = button.cloneNode(true); clone.querySelectorAll('[aria-hidden="true"]').forEach(child => child.remove());
      return button.getAttribute('aria-label') || clone.textContent.trim();
    }))`);
    assert(controls.includes('Attach images or files') && controls.includes('Codex'), 'The native attachment or executor control disappeared: ' + JSON.stringify(controls));
    await capture('shared-composer-native-reply-refusal');
    checks.push('webview2-production-chat-composer-synthetic-owner', 'webview2-reply-shared-rows-native-menu-and-key-intents', 'webview2-real-host-refusal-retains-draft-and-disabled-send', 'webview2-native-attachment-executor-and-model-controls');
  } finally {
    assert(await automation.evaluate(`${module}.then(module => module.endComposerProof())`), 'The native composer fixture did not dispose.');
  }
  checks.push('webview2-composer-presentation-disposed');
  return { checks, screenshots, timings };
}
