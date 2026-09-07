// Native workspace scenario for the existing Windows Tauri/WebView2 harness.
//
// This module deliberately owns no processes. The outside controller and its
// Windows Job Object remain the only process owners. The inner harness passes
// its authenticated WebView automation connection and isolated fixture here.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const SAFE_FIXTURE = Object.freeze({
  profileId: 'workspace-e2e-safe-profile',
  teamId: 'workspace-e2e-safe-team',
  pipelineId: 'workspace-e2e-safe-pipeline',
  launchId: 'workspace-e2e-safe-launch',
  memberId: 'workspace-e2e-safe-member',
  stepId: 'workspace-e2e-safe-step',
});

function assertion(value, message) {
  if (!value) throw new Error(message);
}

function errorText(error) {
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function safeErrorCode(error) {
  let value = error;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return 'UNKNOWN'; }
  }
  const code = value && typeof value === 'object' && typeof value.code === 'string' ? value.code : 'UNKNOWN';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNKNOWN';
}

function safeDiagnosticName(value) {
  // Presence is enough for failure diagnosis. Never log model/provider strings
  // that a user or native extension can supply.
  return typeof value === 'string' && value.trim() !== '' ? 'present' : 'none';
}

function normalizedMilliseconds(value) {
  return Math.max(0, Math.round(value));
}

/**
 * Run the redesigned workspace proof inside the real Tauri WebView2 process.
 *
 * `captureScreenshot` is supplied by the owning native harness. It must capture
 * the actual application window and return the artifact path. DOM snapshots do
 * not satisfy this contract.
 */
export async function runWorkspaceWebview2Proof({
  automation,
  expectedPageUrl,
  harness,
  mode,
  commandBoundMs,
  startupBoundMs,
  captureScreenshot,
  resizeWindow,
}) {
  if (!automation || typeof automation.evaluate !== 'function' || typeof automation.dispatchKey !== 'function') {
    throw new TypeError('Workspace E2E requires the authenticated WebView automation client.');
  }
  if (typeof expectedPageUrl !== 'string' || !expectedPageUrl.startsWith('http://127.0.0.1:')) {
    throw new TypeError('Workspace E2E requires the exact loopback page URL.');
  }
  if (!harness?.fixture || !harness?.ownedChild) {
    throw new TypeError('Workspace E2E requires the controller-owned fixture and contained Tauri child.');
  }
  const appOwnerPid = harness.appOwnerPid;
  if (!Number.isSafeInteger(appOwnerPid) || appOwnerPid <= 0 || appOwnerPid !== harness.ownedChild.child?.pid) {
    throw new TypeError('Workspace E2E requires the contained Tauri Job-runner owner pid.');
  }
  const screenshotRoot = join(harness.fixture.fixtureRoot, 'workspace-screenshots');
  if (!isAbsolute(screenshotRoot) || relative(harness.fixture.fixtureRoot, screenshotRoot).startsWith('..')) {
    throw new TypeError('Workspace E2E screenshot output must stay inside its controller-owned fixture.');
  }
  if (mode !== 'normal' && mode !== 'safe') throw new TypeError('Workspace E2E mode must be normal or safe.');
  if (!Number.isSafeInteger(commandBoundMs) || commandBoundMs <= 0) {
    throw new TypeError('Workspace E2E requires the launcher command bound.');
  }
  if (!Number.isSafeInteger(startupBoundMs) || startupBoundMs < commandBoundMs) {
    throw new TypeError('Workspace E2E requires the launcher startup bound.');
  }
  if (typeof captureScreenshot !== 'function') {
    throw new TypeError('Workspace E2E requires an actual native-window screenshot callback.');
  }
  if (typeof resizeWindow !== 'function') {
    throw new TypeError('Workspace E2E requires an exact native-window resize callback.');
  }

  const startedAt = performance.now();
  const phaseStarted = new Map();
  const timings = {};
  const screenshots = [];
  const checks = [];

  function begin(name) { phaseStarted.set(name, performance.now()); }
  function end(name) {
    const start = phaseStarted.get(name);
    if (start === undefined) throw new Error(`Timing phase ${name} was not started.`);
    timings[name] = normalizedMilliseconds(performance.now() - start);
  }

  async function evaluate(expression) { return automation.evaluate(expression); }

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
    throw new Error(`${label} did not become true within the launcher bound.${lastError ? ` Last error: ${lastError.message}` : ''}`);
  }

  async function invoke(command, args) {
    return evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
  }

  async function invokeOutcome(command, args) {
    return evaluate(`(async () => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}) };
      } catch (error) {
        return { ok: false, error: typeof error === 'string' ? error : (() => { try { return JSON.stringify(error); } catch { return String(error); } })() };
      }
    })()`);
  }

  async function assertRejected(command, args, label, expectedFragment) {
    const outcome = await invokeOutcome(command, args);
    assertion(outcome?.ok === false, `${label} unexpectedly succeeded.`);
    if (expectedFragment !== undefined) {
      assertion(errorText(outcome.error).toLocaleLowerCase().includes(expectedFragment.toLocaleLowerCase()), `${label} returned the wrong failure: ${errorText(outcome.error)}`);
    }
    return outcome.error;
  }

  async function clickButton(name, root = '') {
    await waitFor(`(() => {
      const root = ${root ? `document.querySelector(${JSON.stringify(root)})` : 'document'};
      const button = root && [...root.querySelectorAll('button')].find((candidate) => {
        const wanted = ${JSON.stringify(name)};
        return candidate.getAttribute('aria-label') === wanted
          || candidate.textContent?.trim() === wanted
          || candidate.querySelector('strong')?.textContent?.trim() === wanted
          || [...candidate.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === wanted);
      });
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`, `enabled button “${name}”`);

  }

  async function setControl(selector, value, eventName = 'input') {
    const changed = await evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) || control.disabled) return false;
      const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, ${JSON.stringify(value)});
      control.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }));
      return control.value === ${JSON.stringify(value)};
    })()`);
    assertion(changed, `Could not set ${selector}.`);
  }

  async function setLabelledControl(label, value, eventName = 'input') {
    const changed = await evaluate(`(() => {
      const wanted = ${JSON.stringify(label)};
      const label = [...document.querySelectorAll('label')].find((candidate) => {
        const clone = candidate.cloneNode(true);
        clone.querySelectorAll('input,select,textarea').forEach((node) => node.remove());
        const text = clone.textContent?.trim() ?? '';
        return text === wanted || text.startsWith(wanted);

      });
      const control = label?.querySelector('input,select,textarea') ?? (label?.htmlFor ? document.getElementById(label.htmlFor) : null);
      if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) || control.disabled) return false;
      const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, ${JSON.stringify(value)});
      control.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }));
      return control.value === ${JSON.stringify(value)};
    })()`);
    assertion(changed, `Could not set control labelled “${label}”.`);
  }

  async function capture(name) {
    const path = join(screenshotRoot, `${name}.png`);
    const returnedPath = await captureScreenshot({ name, path, appOwnerPid });
    assertion(returnedPath === path, `Screenshot ${name} did not confirm its exact controller-owned artifact path.`);
    assertion(existsSync(path), `Screenshot ${name} did not create its artifact.`);
    const signature = readFileSync(path).subarray(0, 8);
    assertion(signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Screenshot ${name} is not a PNG captured from the native window.`);
    screenshots.push(path);
  }

  async function waitForWorkspaceShell() {
    await waitFor(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 'Tauri invoke bridge', startupBoundMs);
    await waitFor(`document.querySelector('aside .utilities') && document.querySelector('#workspace-main')`, 'redesigned workspace shell', startupBoundMs);
    assertion(!automation.currentPage?.href.includes('view=classic'), 'The redesigned proof navigated to the classic compatibility route.');
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
    assertion(automation.generation > before, 'The workspace WebView did not return after reload.');
    await waitForWorkspaceShell();
  }

  async function workspaceCatalog() {
    const result = await invoke('workspace_command_v15', { command: { type: 'catalog' } });
    assertion(result?.type === 'catalog' && result.catalog?.protocol === 15, 'The host did not return the workspace v11 catalog.');
    return result.catalog;
  }

  async function verifyClosedNativeSession(sessionId, failureScreenshot) {
    let closeCatalogStatus = 'missing';
    try {
      const latest = await workspaceCatalog();
      const status = latest.sessions.find((item) => item.id === sessionId)?.status;
      closeCatalogStatus = ['starting', 'idle', 'running', 'stopping', 'closed', 'failed'].includes(status) ? status : 'missing';
      assertion(closeCatalogStatus === 'closed', 'The UI close action did not close the native workspace session in the host catalog.');
      await waitFor(`[...document.querySelectorAll('.session-list > button')].some((item) => item.textContent?.includes('Native lifecycle proof') && item.textContent?.includes('Closed'))`, 'closed native session rendered in the UI', startupBoundMs);
      assertion(await evaluate(`document.querySelector('.inline-error[role="alert"]') === null`), 'The native close reached Closed through error recovery instead of a graceful RPC reply.');
      return latest;
    } catch {
      const snapshot = await invokeOutcome('workspace_command_v15', { command: { type: 'snapshot', sessionId } });
      const snapshotStatus = snapshot?.ok === true ? 'SUCCESS' : safeErrorCode(snapshot?.error);
      await capture(failureScreenshot);
      throw new Error(`Native close proof failed. Catalog status: ${closeCatalogStatus}. Snapshot status: ${snapshotStatus}.`);
    }
  }

  async function orchestrationCatalog(workspaceId) {
    return invoke('orchestration_catalog_v6', { request: { workspaceId } });
  }

  async function readSingle(kind, workspaceId, name) {
    const routes = {
      profile: ['profiles', 'orchestration_get_profile_v6'],
      team: ['teams', 'orchestration_get_team_v6'],
      pipeline: ['pipelines', 'orchestration_get_pipeline_v6'],
      launch: ['launchCommands', 'orchestration_get_launch_command_v6'],
    };
    const [collection, route] = routes[kind];
    const catalog = await orchestrationCatalog(workspaceId);
    const summary = catalog[collection].find((item) => item.name === name);
    assertion(summary, `The host did not persist ${kind} “${name}”.`);
    const stored = await invoke(route, { request: { workspaceId, id: summary.id } });
    assertion(stored?.value?.name === name, `The host could not read ${kind} “${name}”.`);
    return { summary, stored };
  }

  async function selectWorkspaceSection(name) {
    if (['Agents', 'Teams', 'Pipelines'].includes(name)) await evaluate(`document.querySelector('nav[aria-label="Workspace sections"] details').open = true`);
    await clickButton(name, 'nav[aria-label="Workspace sections"]');
    await waitFor(`document.querySelector('#orchestration-title')?.textContent?.trim() === ${JSON.stringify(name)}`, `${name} workspace section`);
  }

  async function chooseNativeModel(selector) {
    await waitFor(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled && [...document.querySelector(${JSON.stringify(selector)}).options].some(o => o.value && !o.disabled)`, 'native model options', startupBoundMs);
    const value = await evaluate(`[...document.querySelector(${JSON.stringify(selector)}).options].find(o => o.value && !o.disabled).value`);
    await setControl(selector, value, 'change');
  }

  async function createAndUpdateDefinitions(workspaceId) {
    const names = {
      profile: ['WebView Agent', 'WebView Agent Updated'],
      team: ['WebView Team', 'WebView Team Updated'],
      pipeline: ['WebView Pipeline', 'WebView Pipeline Updated'],
      launch: ['WebView Launch', 'WebView Launch Updated'],
    };

    await clickButton('Workspace', '.view-switch');
    await selectWorkspaceSection('Systems');
    await setControl('.system-name', 'Mixed graph proof');
    await clickButton('＋ Add agent', '.canvas-tools');
    await chooseNativeModel('aside[aria-label="Agent settings"] select[aria-label="Model"]');
    await setControl('aside[aria-label="Agent settings"] select[aria-label="Reasoning"]', 'low', 'change');
    await setControl('aside label:nth-of-type(5) select', 'fast', 'change');
    await clickButton('＋ Add agent', '.canvas-tools');
    await setControl('aside label:nth-of-type(2) select', 'prime-agent', 'change');
    await chooseNativeModel('aside[aria-label="Agent settings"] select[aria-label="Model"]');
    await evaluate(`(() => { const select = document.querySelector('.canvas-tools select'); select.value = 'sequential'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelectorAll('.connections li').length === 1`, 'graph result connection');
    await clickButton('Save', '.system-editor .toolbar');
    await waitFor(`document.querySelector('.save-state')?.textContent === 'Saved'`, 'atomic graph save');
    const graphCommand = await readSingle('launch', workspaceId, 'Mixed graph proof');
    const graphPipeline = await invoke('orchestration_get_pipeline_v6', { request: { workspaceId, id: graphCommand.stored.value.pipelineId } });
    assertion(graphPipeline.value.steps[1].dependencyStepIds[0] === graphPipeline.value.steps[0].id, 'Mixed graph lost its result edge');
    const graphCatalog = await orchestrationCatalog(workspaceId);
    const graphProfiles = [];
    for (const item of graphCatalog.profiles.filter(item => ['Agent 1', 'Agent 2'].includes(item.name))) graphProfiles.push(await invoke('orchestration_get_profile_v6', { request: { workspaceId, id: item.id } }));
    assertion(graphProfiles.some(item => item.value.harness === 'codex' && item.value.reasoning === 'low' && item.value.serviceTier === 'fast'), 'Graph lost Codex settings');
    assertion(graphProfiles.some(item => item.value.harness === 'prime-agent'), 'Graph lost Prime adapter');
    await capture('workspace-mixed-graph');
    await selectWorkspaceSection('Agents');

    await clickButton('Create profile');
    await waitFor(`document.querySelector('#profile-name')`, 'Codex prompt editor');
    await setControl('#profile-name', 'Custom Codex prompt');
    await setControl('#profile-harness', 'codex', 'change');
    await chooseNativeModel('#profile-model');
    assertion(await evaluate(`(() => {
      const label = [...document.querySelectorAll('label')].find(e => e.textContent.includes('Replace Codex base prompt'));
      const checkbox = label?.querySelector('input');
      checkbox?.focus(); checkbox?.click();
      return checkbox?.checked && document.activeElement === checkbox;
    })()`), 'Codex base prompt toggle must be focusable and labelled.');
    await waitFor(`document.querySelector('#profile-base-instructions')`, 'explicit empty Codex prompt');
    await evaluate(`document.querySelector('#profile-editor-title').scrollIntoView({block:'start'})`);
    await capture('workspace-codex-profile');
    await clickButton('Save profile');
    await waitFor(`[...document.querySelectorAll('.definition-list strong')].some(e => e.textContent === 'Custom Codex prompt')`, 'saved Codex prompt');
    const customPrompt = await readSingle('profile', workspaceId, 'Custom Codex prompt');
    assertion(customPrompt.stored.value.baseInstructions === '', 'Explicit empty base prompt was lost at the host boundary.');
    await clickButton('Delete Custom Codex prompt');
    await waitFor(`document.querySelector('[aria-label="Confirm definition deletion"]')`, 'Codex profile deletion confirmation');
    await clickButton('Delete definition', '[aria-label="Confirm definition deletion"]');
    await waitFor(`!document.querySelector('[aria-label="Confirm definition deletion"]')`, 'Codex profile deleted');

    await clickButton('Create profile');
    await waitFor(`document.querySelector('#profile-name')`, 'profile editor');
    await setControl('#profile-name', names.profile[0]);
    await setControl('#profile-harness', 'prime-agent', 'change');
    await chooseNativeModel('#profile-model');
    await evaluate(`document.querySelector('details.advanced summary').click()`);
    await setControl('#profile-permission', 'read-only', 'change');
    await waitFor(`document.querySelector('.rule-warning')?.textContent?.includes('Prime Agent rejects this strict permission mode')`, 'unsupported Prime policy warning');
    await clickButton('Save profile');
    await waitFor(`[...document.querySelectorAll('.definition-list strong')].some((item) => item.textContent?.trim() === ${JSON.stringify(names.profile[0])})`, 'saved profile');
    let profile = await readSingle('profile', workspaceId, names.profile[0]);
    await clickButton(names.profile[0]);
    await waitFor(`document.querySelector('#profile-name')?.value === ${JSON.stringify(names.profile[0])}`, 'stored profile editor');
    // Catalog discovery owns the host runtime transition gate; await its native startup bound before timing the save itself.
    await waitFor(`document.querySelector('#profile-model') && !document.querySelector('#profile-model').disabled`, 'reopened profile catalog', startupBoundMs);
    await setControl('#profile-name', names.profile[1]);
    await clickButton('Save profile');
    try { await waitFor(`[...document.querySelectorAll('.definition-list strong')].some((item) => item.textContent?.trim() === ${JSON.stringify(names.profile[1])})`, 'updated profile'); } catch (error) { await capture('profile-update-failure'); const diagnostic = await evaluate(`JSON.stringify({alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent),name:document.querySelector('#profile-name')?.value})`); throw new Error(`${error.message} ${diagnostic}`); }
    profile = await readSingle('profile', workspaceId, names.profile[1]);
    assertion(profile.summary.revision > 0, 'Profile update did not advance its host revision.');

    await selectWorkspaceSection('Teams');
    await clickButton('Create team');
    await waitFor(`document.querySelector('#team-editor-title')`, 'team editor');
    await setLabelledControl('Team name', names.team[0]);
    await clickButton('Add member');
    await waitFor(`document.querySelector('.member-row input')`, 'team member row');
    await setControl('.member-row input', 'lead');
    await setControl('.member-row select', profile.summary.id, 'input');
    await setLabelledControl('Orchestrator member', 'lead', 'input');
    await clickButton('Add member');
    await waitFor(`document.querySelectorAll('.member-row').length === 2`, 'second team member');
    await clickButton('Everyone to everyone');
    assertion(await evaluate(`document.querySelectorAll('.routes input[type="checkbox"]:checked').length === 2`), 'Peer preset must enable both message directions.');
    await evaluate(`document.querySelector('details.subagents summary').click()`);
    assertion(await evaluate(`(() => {
      const input = document.querySelector('.spawn-communication input');
      input.focus(); input.click(); return input.checked && document.activeElement === input;
    })()`), 'Dynamic team messaging must require an explicit focusable choice.');
    await evaluate(`document.querySelector('details.subagents summary').click(); document.querySelector('#connections-title').scrollIntoView({block:'start'})`);
    await capture('workspace-team-connections');
    await clickButton('Save team');
    await waitFor(`[...document.querySelectorAll('.definition-list strong')].some((item) => item.textContent?.trim() === ${JSON.stringify(names.team[0])})`, 'saved team');
    let team = await readSingle('team', workspaceId, names.team[0]);
    assertion(team.stored.value.sendEdges.length === 2 && team.stored.value.spawnedAgentsJoinTeam === true, 'Team messaging policy did not persist.');
    await clickButton(names.team[0]);
    await waitFor(`document.querySelector('#team-editor-title')`, 'stored team editor');
    await setLabelledControl('Team name', names.team[1]);
    await clickButton('Save team');
    await waitFor(`[...document.querySelectorAll('.definition-list strong')].some((item) => item.textContent?.trim() === ${JSON.stringify(names.team[1])})`, 'updated team');
    team = await readSingle('team', workspaceId, names.team[1]);
    assertion(team.summary.revision > 0, 'Team update did not advance its host revision.');

    await selectWorkspaceSection('Pipelines');
    await clickButton('Create pipeline');
    await waitFor(`document.querySelector('#pipeline-name')`, 'pipeline editor');
    await setControl('#pipeline-name', names.pipeline[0]);
    await clickButton('Add task');
    await waitFor(`document.querySelector('.task')`, 'pipeline task editor');
    await setLabelledControl('Task name', 'Verify workspace');
    await setLabelledControl('Member slot', 'lead');
    await setLabelledControl('Task instructions', 'Verify the isolated native workspace.');
    await clickButton('Save pipeline');
    await waitFor(`[...document.querySelectorAll('.definition-list strong')].some((item) => item.textContent?.trim() === ${JSON.stringify(names.pipeline[0])})`, 'saved pipeline');
    let pipeline = await readSingle('pipeline', workspaceId, names.pipeline[0]);
    await clickButton(names.pipeline[0]);
    await waitFor(`document.querySelector('#pipeline-name')`, 'stored pipeline editor');
    await setControl('#pipeline-name', names.pipeline[1]);
    await clickButton('Save pipeline');
    await waitFor(`[...document.querySelectorAll('.definition-list strong')].some((item) => item.textContent?.trim() === ${JSON.stringify(names.pipeline[1])})`, 'updated pipeline');
    pipeline = await readSingle('pipeline', workspaceId, names.pipeline[1]);
    assertion(pipeline.summary.revision > 0, 'Pipeline update did not advance its host revision.');

    await clickButton('Create launch command');
    await waitFor(`document.querySelector('#launch-name')`, 'launch command editor');
    await setControl('#launch-name', names.launch[0]);
    await setControl('#launch-team', team.summary.id, 'change');
    await setControl('#launch-pipeline', pipeline.summary.id, 'change');
    await clickButton('Save launch command');
    await waitFor(`[...document.querySelectorAll('ul[aria-label="Launch commands"] strong')].some((item) => item.textContent?.trim() === ${JSON.stringify(names.launch[0])})`, 'saved launch command');
    let launch = await readSingle('launch', workspaceId, names.launch[0]);
    await clickButton(names.launch[0]);
    await waitFor(`document.querySelector('#launch-name')`, 'stored launch command editor');
    await setControl('#launch-name', names.launch[1]);
    await clickButton('Save launch command');
    await waitFor(`[...document.querySelectorAll('ul[aria-label="Launch commands"] strong')].some((item) => item.textContent?.trim() === ${JSON.stringify(names.launch[1])})`, 'updated launch command');
    launch = await readSingle('launch', workspaceId, names.launch[1]);
    assertion(launch.summary.revision > 0, 'Launch command update did not advance its host revision.');

    const beforeRunCatalog = await workspaceCatalog();
    const sessionsBeforeRun = beforeRunCatalog.sessions.map((session) => session.id).sort();
    // Availability is checked before strict-policy support by native preflight.
    const primeAvailable = beforeRunCatalog.harnesses.some((item) => item.kind === 'prime-agent' && item.status === 'available');
    const expectedFailureCode = primeAvailable ? 'unsupported-policy' : 'runtime-unavailable';
    const expectedFailureCopy = primeAvailable ? 'requested native policy is unsupported' : 'native runtime is unavailable';
    await clickButton(`Launch ${names.launch[1]}`);
    await waitFor(`document.querySelector('#run-launcher-title')?.textContent?.trim() === ${JSON.stringify(names.launch[1])}`, 'saved launch command run form');
    const lockedLaunch = await evaluate(`(() => ({
      team: document.querySelector('#run-team')?.value,
      pipeline: document.querySelector('#run-pipeline')?.value,
      teamDisabled: document.querySelector('#run-team')?.disabled,
      pipelineDisabled: document.querySelector('#run-pipeline')?.disabled,
    }))()`);
    assertion(lockedLaunch.team === team.summary.id && lockedLaunch.pipeline === pipeline.summary.id && lockedLaunch.teamDisabled && lockedLaunch.pipelineDisabled, 'The saved launch command did not lock its actual team and pipeline references.');
    await clickButton('Start run');
    await waitFor(`document.querySelector('#run-inspector-title') && document.querySelector('[aria-label="Run status: Failed"]')`, 'recorded unsupported-policy run failure', startupBoundMs);
    await waitFor(`document.querySelector('.inspector .error[role="alert"]')?.textContent?.includes(${JSON.stringify(expectedFailureCopy)})`, 'safe native preflight error');
    const runs = await invoke('orchestration_list_runs_v6', { request: { workspaceId } });
    assertion(Array.isArray(runs) && runs.length === 1 && runs[0].status === 'failed', 'The host did not retain exactly one failed run after policy preflight rejection.');
    const recordedRun = await invoke('orchestration_get_run_v6', { request: { workspaceId, runId: runs[0].id } });
    assertion(recordedRun?.status === 'failed' && recordedRun.tasks?.length === 1, 'The recorded policy-rejected run is not terminal failed.');
    assertion(recordedRun.tasks[0]?.status === 'failed' && recordedRun.tasks[0]?.failure?.code === expectedFailureCode, 'The failed task did not preserve the expected native preflight failure code.');
    assertion(!JSON.stringify(recordedRun).toLocaleLowerCase().includes('succeeded'), 'The policy-rejected run fabricated a succeeded outcome.');
    const sessionsAfterRun = (await workspaceCatalog()).sessions.map((session) => session.id).sort();
    assertion(JSON.stringify(sessionsAfterRun) === JSON.stringify(sessionsBeforeRun), 'Unsupported policy preflight started a native session.');
    await waitFor(`document.querySelector('[aria-label="Execution graph"] .agent')`, 'execution graph from durable run');
    await evaluate(`document.querySelector('[aria-label="Execution graph"] .agent').click()`);
    await waitFor(`document.querySelector('[aria-label="Agent activity"]')`, 'selected agent activity');
    assertion(await evaluate(`document.querySelector('.agent-inspector').textContent.includes('Total tokens') && document.querySelector('.agent-inspector dd').textContent.trim() === '—'`), 'Missing native usage was represented as a fabricated zero');
    await evaluate(`document.querySelector('[aria-label="Resize agent activity"]').focus()`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft',bubbles:true}))`);
    assertion(await evaluate(`document.activeElement.getAttribute('aria-label') === 'Resize agent activity'`), 'Inspector resize is not keyboard reachable');
    await clickButton('Input and result', '.agent-inspector');
    await waitFor(`document.querySelector('.agent-inspector').textContent.includes('Result is not available yet.')`, 'unavailable result presentation');
    checks.push('execution-graph-durable-failure', 'usage-unknown-not-zero', 'execution-inspector-keyboard', 'native-result-unavailable');
    await capture('workspace-run-failed');
    await clickButton('Close run inspector');
    await waitFor(`!document.querySelector('#run-inspector-title')`, 'closed failed run inspector');

    await reload();
    await clickButton('Workspace', '.view-switch');
    await waitFor(`document.querySelector('#orchestration-title')?.textContent?.trim() === 'Pipelines'`, 'reloaded Pipelines section', startupBoundMs);
    for (const name of [names.pipeline[1], names.launch[1]]) {
      await waitFor(`[...document.querySelectorAll('.definition-list strong')].some((item) => item.textContent?.trim() === ${JSON.stringify(name)})`, `reloaded ${name}`);
    }
    await capture('workspace-definitions');

    for (const [name, section] of [
      [names.launch[1], undefined], [names.pipeline[1], undefined], [names.team[1], 'Teams'], [names.profile[1], 'Agents'],
    ]) {
      if (section) await selectWorkspaceSection(section);
      await waitFor(`[...document.querySelectorAll('button')].some((item) => item.getAttribute('aria-label') === ${JSON.stringify(`Delete ${name}`)} && !item.disabled)`, `delete control for ${name}`);
      await clickButton(`Delete ${name}`);
      await waitFor(`document.querySelector('[aria-label="Confirm definition deletion"]')`, `delete confirmation for ${name}`);
      await clickButton('Delete definition', '[aria-label="Confirm definition deletion"]');
      await waitFor(`![...document.querySelectorAll('.definition-list strong')].some((item) => item.textContent?.trim() === ${JSON.stringify(name)})`, `deleted ${name}`);
    }
    const finalCatalog = await orchestrationCatalog(workspaceId);
    assertion(finalCatalog.profiles.length === 2 && finalCatalog.teams.length === 1 && finalCatalog.pipelines.length === 1 && finalCatalog.launchCommands.length === 1 && finalCatalog.launchCommands[0].id === graphCommand.summary.id, 'UI deletion must remove selected definitions and preserve the independent graph.');
    await selectWorkspaceSection('Systems');
    await waitFor(`document.querySelector('select[aria-label="Open system"] option[value="${graphCommand.summary.id}"]')`, 'saved graph catalog loaded');
    await setControl('select[aria-label="Open system"]', graphCommand.summary.id, 'change');
    await waitFor(`document.querySelectorAll('.node').length === 2 && document.querySelectorAll('.connections li').length === 1`, 'reopened mixed graph');
    await capture('workspace-mixed-graph-reopened');
    await evaluate(`document.querySelector('.close-inspector').focus()`);
    assertion(await evaluate(`document.activeElement?.matches('button.close-inspector[aria-label]')`), 'Inspector close must be a labelled, keyboard-focusable native button');
    // Synthetic KeyboardEvent does not trigger native button activation.
    await evaluate(`document.activeElement.click()`);
    await waitFor(`!document.querySelector('.graph-layout aside')`, 'close graph inspector');
    assertion(await evaluate(`document.activeElement?.matches('button.node')`), 'Closing inspector must return focus to its graph node');
    assertion(await evaluate(`document.activeElement?.matches('button.node')`), 'Graph selection must retain native keyboard button semantics');
    await evaluate(`document.activeElement.click()`);
    await waitFor(`document.querySelector('.graph-layout aside')`, 'reopen graph inspector');

    // Export through the actual UI serializer. Suppress only the native download
    // in this isolated test; retain the Blob bytes for the import round trip.
    await evaluate(`(() => {
      window.__piuiAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        window.__piuiExportPromise = fetch(this.href).then(response => response.text());
      };
      document.querySelector('.file-menu').open = true;
    })()`);
    let exported;
    try {
      await clickButton('Export JSON', '.file-menu');
      await waitFor(`Boolean(window.__piuiExportPromise)`, 'export JSON blob');
      exported = await evaluate(`window.__piuiExportPromise`);
    } finally {
      await evaluate(`HTMLAnchorElement.prototype.click = window.__piuiAnchorClick`);
    }
    const imported = JSON.parse(exported);
    assertion(imported.format === 'piui-system' && imported.agents.length === 2, 'Export lost mixed-system agents');
    const priorName = await evaluate(`document.querySelector('.system-name').value`);
    async function chooseJson(text) {
      await evaluate(`(() => {
        const input = document.querySelector('.file-input'); const transfer = new DataTransfer();
        transfer.items.add(new File([${JSON.stringify(text)}], 'proof.piui.json', {type:'application/json'}));
        input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true}));
      })()`);
    }
    await chooseJson('{invalid');
    await waitFor(`document.querySelector('.system-editor [role="alert"]')`, 'invalid system file error');
    assertion(await evaluate(`document.querySelector('.system-name').value`) === priorName, 'Failed import replaced the current system');
    imported.name = 'Imported JSON proof';
    imported.version = 4;
    imported.agents[0].resultFields = [{name:'summary',kind:'text'}];
    imported.agents[1].inputBindings = [{sourceStepId:imported.agents[0].id,field:'summary',name:'reviewInput'}];
    imported.agents[1].requireApproval = true;
    imported.agents[1].profile.harness = 'hermes';
    imported.agents[1].profile.permissionMode = 'native';
    delete imported.agents[1].profile.serviceTier;
    delete imported.agents[1].profile.reasoning;
    delete imported.agents[1].profile.resourceRules;
    await chooseJson(JSON.stringify(imported));
    await waitFor(`document.querySelector('.system-name').value === 'Imported JSON proof' && document.querySelector('.save-state')?.textContent === 'Unsaved changes'`, 'imported system draft');
    const beforeImportSave = await orchestrationCatalog(workspaceId);
    assertion(!beforeImportSave.launchCommands.some(item => item.name === imported.name), 'Import saved or ran without explicit Save');
    await clickButton('Save', '.system-editor .toolbar');
    await waitFor(`document.querySelector('.save-state')?.textContent === 'Saved'`, 'save imported system');
    const importedCommand = await readSingle('launch', workspaceId, imported.name);
    assertion(importedCommand.summary.id !== graphCommand.summary.id, 'Import reused an existing system identity');
    const importedTeam = await invoke('orchestration_get_team_v6', { request: { workspaceId, id: importedCommand.stored.value.teamId } });
    const hermesProfile = await invoke('orchestration_get_profile_v6', { request: { workspaceId, id: importedTeam.value.members[1].profileId } });
    assertion(hermesProfile.value.harness === 'hermes', 'Native WebView import/save lost Hermes');
    checks.push('hermes-v3-mixed-graph-import-save');
    const afterImportSave = await orchestrationCatalog(workspaceId);
    assertion(afterImportSave.launchCommands.some(item => item.id === graphCommand.summary.id), 'Import overwrote the original system');
    await evaluate(`document.querySelector('.file-menu').open = false`);
    await capture('workspace-imported-json');
    return names;
  }

  async function seedSafeModeRunDefinitions(workspaceId) {
    const profile = {
      id: SAFE_FIXTURE.profileId, name: 'Safe-mode profile', harness: 'pi', model: 'native',
      permissionMode: 'native', instructions: '', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [],
    };
    const team = {
      id: SAFE_FIXTURE.teamId, name: 'Safe-mode team',
      members: [{ id: SAFE_FIXTURE.memberId, profileId: SAFE_FIXTURE.profileId }],
      sendEdges: [], observeEdges: [], orchestratorMemberId: SAFE_FIXTURE.memberId,
    };
    const pipeline = {
      id: SAFE_FIXTURE.pipelineId, name: 'Safe-mode pipeline',
      steps: [{ id: SAFE_FIXTURE.stepId, name: 'Blocked task', assignedMemberId: SAFE_FIXTURE.memberId, instructions: 'Must not run in safe mode.', dependencyStepIds: [] }],
    };
    const launch = { id: SAFE_FIXTURE.launchId, name: 'Safe-mode launch', teamId: SAFE_FIXTURE.teamId, pipelineId: SAFE_FIXTURE.pipelineId };
    await invoke('orchestration_save_profile_v6', { request: { workspaceId, value: profile } });
    await invoke('orchestration_save_team_v6', { request: { workspaceId, value: team } });
    await invoke('orchestration_save_pipeline_v6', { request: { workspaceId, value: pipeline } });
    await invoke('orchestration_save_launch_command_v6', { request: { workspaceId, value: launch } });
  }



  await waitForWorkspaceShell();
  timings.browser = await evaluate(`(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const paint = Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, Math.round(entry.startTime)]));
    const milliseconds = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
    return {
      sample: 'tauri-webview2-dev',
      domInteractiveMs: milliseconds(navigation?.domInteractive),
      domContentLoadedMs: milliseconds(navigation?.domContentLoadedEventEnd),
      loadEventMs: milliseconds(navigation?.loadEventEnd),
      responseEndMs: milliseconds(navigation?.responseEnd),
      firstPaintMs: milliseconds(paint['first-paint']),
      firstContentfulPaintMs: milliseconds(paint['first-contentful-paint']),
      shellObservedMs: milliseconds(performance.now()),
    };
  })()`);

  if (mode === 'safe') {
    begin('safeMode');
    const catalog = await workspaceCatalog();
    assertion(catalog.safeMode === true, 'The safe-mode app returned a writable workspace catalog.');
    await waitFor(`document.querySelector('.safe-mode[role="status"]')?.textContent?.includes('Runtime actions')`, 'safe-mode banner');
    const workspace = catalog.workspaces.find((item) => !item.personal && !item.missing);
    assertion(workspace, 'Safe-mode proof could not find the persisted isolated project.');
    await waitFor(`(() => {
      const button = [...document.querySelectorAll('.project-row > button:first-child')].find((item) => item.querySelector('span')?.textContent?.trim() === ${JSON.stringify(workspace.name)});
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`, 'persisted isolated project selection');
    await waitFor(`[...document.querySelectorAll('.project-row > button:first-child')].some((item) => item.querySelector('span')?.textContent?.trim() === ${JSON.stringify(workspace.name)} && item.getAttribute('aria-current') === 'true')`, 'selected isolated project');

    await automation.dispatchKey({ key: 'n', code: 'KeyN', ctrlKey: true });
    await waitFor(`document.querySelector('#new-session-title')`, 'safe-mode new-session form');
    assertion(await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Create session'); return Boolean(button?.disabled); })()`), 'Safe mode exposed an enabled Create session action.');
    await assertRejected('workspace_settings_v16', { command: { type: 'get', sessionId: 'safe-fixture' } }, 'Safe-mode runtime settings', 'safe');
    await assertRejected('workspace_lifecycle_v17', { command: { type: 'deleteSession', sessionId: 'safe-fixture' } }, 'Safe-mode chat deletion', 'safe');
    await assertRejected('workspace_command_v15', { command: { type: 'createSession', workspaceId: workspace.id, harness: 'pi', permissionMode: 'native' } }, 'Safe-mode native session creation', 'safe');
    if (process.env.PIUI_E2E_CHAT_ONLY === '1' || process.env.PIUI_E2E_GRAPH_ONLY === '1') {
      assertion((await workspaceCatalog()).sessions.every(session => session.status === 'closed'), 'Safe mode must not auto-start a saved chat');
      await capture('automatic-chat-safe-mode');
      return { checks: ['safe-mode-no-auto-start', 'safe-mode-create-rejected'], timings, screenshots };
    }

    const definitions = await orchestrationCatalog(workspace.id);
    assertion(
      definitions.profiles.some((item) => item.id === SAFE_FIXTURE.profileId)
        && definitions.teams.some((item) => item.id === SAFE_FIXTURE.teamId)
        && definitions.pipelines.some((item) => item.id === SAFE_FIXTURE.pipelineId)
        && definitions.launchCommands.some((item) => item.id === SAFE_FIXTURE.launchId),
      'Safe-mode run fixtures did not persist from the normal host process.',
    );
    await assertRejected('orchestration_start_run_v6', { request: {
      workspaceId: workspace.id, runId: `workspace-e2e-safe-run-${Date.now()}`,
      teamId: SAFE_FIXTURE.teamId, pipelineId: SAFE_FIXTURE.pipelineId, launchCommandId: SAFE_FIXTURE.launchId,
    } }, 'Safe-mode orchestration run creation', 'runtime-unavailable');

    try {
      await clickButton('Workspace', '.view-switch');
      await waitFor(`/read-only|viewing only/.test(document.querySelector('.orchestration-panel .notice')?.textContent ?? '')`, 'safe-mode workspace notice', startupBoundMs);
      assertion(await evaluate(`![...document.querySelectorAll('.orchestration-panel button')].some((item) => /^Create /.test(item.textContent?.trim() ?? ''))`), 'Safe mode exposed a workspace definition create action.');
      await selectWorkspaceSection('Runs');
      assertion(await evaluate(`(() => { const button = [...document.querySelectorAll('.orchestration-panel button')].find((item) => item.textContent?.trim() === 'Start run'); return Boolean(button?.disabled); })()`), 'Safe mode exposed an enabled Start run control.');
      await selectWorkspaceSection('Pipelines');
      await waitFor(`[...document.querySelectorAll('button')].some((item) => item.getAttribute('aria-label') === 'Launch Safe-mode launch')`, 'safe-mode launch command');
      assertion(await evaluate(`document.querySelector('button[aria-label="Launch Safe-mode launch"]')?.disabled === true`), 'Safe mode exposed an enabled saved launch command.');
      await capture('workspace-safe-mode');
    } catch (error) {
      await capture('workspace-safe-mode-failure');
      throw error;
    }
    end('safeMode');
    timings.total = normalizedMilliseconds(performance.now() - startedAt);
    return {
      checks: ['safe-mode-ui-read-only', 'safe-mode-create-rejected', 'safe-mode-run-rejected', 'safe-mode-run-controls-disabled'],
      timings,
      screenshots,
      cleanup: { workspaceId: workspace.id, safeFixture: SAFE_FIXTURE },
    };
  }

  begin('startup');
  const initial = await workspaceCatalog();
  assertion(initial.safeMode === false, 'The normal workspace proof started in safe mode.');
  assertion(await evaluate(`document.querySelector('.view-switch button[aria-current="page"]')?.textContent?.trim() === 'Sessions'`), 'The redesigned shell did not start in Sessions.');
  const shellAccessibility = await evaluate(`(() => ({
    navigation: document.querySelector('aside[aria-label="Workspace navigation"]') !== null,
    projectTree: document.querySelector('nav[aria-label="Projects and native sessions"]') !== null,
    viewSwitch: document.querySelector('[aria-label="Workspace view"]') !== null,
    mainFocusable: document.querySelector('#workspace-main')?.getAttribute('tabindex') === '-1',
    actions: ['Settings','New chat','Add project'].every((name) =>
      [...document.querySelectorAll('button')].some((button) => button.textContent?.trim().startsWith(name))),
  }))()`);
  assertion(Object.values(shellAccessibility).every(Boolean), 'The Sessions startup surface lost a keyboard or screen-reader label.');
  end('startup');
  checks.push('sessions-default-startup', 'workspace-accessible-landmarks');

  begin('projectTrust');
  const projectPath = harness.fixture.workspaceProject ?? harness.fixture.piProject;
  assertion(typeof projectPath === 'string' && projectPath.length > 0, 'The isolated harness did not supply a workspace test folder.');
  const added = await invoke('add_project_v10', { path: projectPath, agentKind: 'pi' });
  assertion(typeof added?.id === 'string', 'The typed host did not register the isolated workspace folder.');
  await reload();
  await waitFor(`[...document.querySelectorAll('.project-row > button:first-child')].some((item) => item.textContent?.includes(${JSON.stringify(added.name)}))`, 'registered workspace in navigation', startupBoundMs);
  await clickButton(`Review trust for ${added.name}`);
  await waitFor(`document.querySelector('[role="dialog"][aria-labelledby="trust-title"]')`, 'explicit project trust dialog');
  const trustDialog = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="trust-title"]');
    return { modal: dialog?.getAttribute('aria-modal'), warning: dialog?.textContent?.includes('Trust is not a sandbox.'), name: document.querySelector('#trust-title')?.textContent };
  })()`);
  assertion(trustDialog.modal === 'true' && trustDialog.warning && trustDialog.name === `Trust ${added.name}?`, 'Project trust was not an explicit, labelled non-sandbox decision.');
  assertion(await evaluate(`document.querySelector('.shell').inert && document.activeElement?.closest('[role="dialog"]') !== null`), 'Trust must move focus inside the modal and make the workspace inert.');
  await evaluate(`document.querySelector('[aria-labelledby="trust-title"] button:last-child').focus()`);
  await automation.dispatchKey({ key: 'Tab', code: 'Tab' });
  assertion(await evaluate(`document.activeElement === document.querySelector('[aria-labelledby="trust-title"] button:first-child')`), 'Tab escaped the trust decision.');
  await clickButton(`Trust ${added.name}`, '[role="dialog"][aria-labelledby="trust-title"]');
  await waitFor(`!document.querySelector('[role="dialog"][aria-labelledby="trust-title"]')`, 'trusted project dialog close');
  let catalog = await workspaceCatalog();
  const workspace = catalog.workspaces.find((item) => item.id === added.id);
  assertion(workspace?.trust === 'trusted', 'The visible trust action did not update the typed host catalog.');
  end('projectTrust');
  checks.push('typed-host-project-registration', 'explicit-ui-project-trust');

  begin('unavailable');
  await automation.dispatchKey({ key: 'n', code: 'KeyN', ctrlKey: true });
  await waitFor(`document.querySelector('#new-session-title')`, 'new native session form');
  assertion(await evaluate(`document.activeElement?.id === 'new-session-project'`), 'New chat did not focus its first field.');
  const readiness = await evaluate(`(() => ({
    controls: ['Project','Harness','Model','Permission mode'].every((name) => [...document.querySelectorAll('.new-session label')].some((label) => label.textContent?.trim().startsWith(name))),
    text: document.querySelector('.new-session')?.textContent ?? '',
  }))()`);
  assertion(readiness.controls, 'The new-session form lost an accessible native control label.');
  const unavailable = catalog.harnesses.filter((item) => item.status !== 'available');
  for (const item of unavailable) {
    const visibleState = item.reason
      ? readiness.text.includes(item.reason)
      : readiness.text.includes(item.status === 'unverified' ? 'Setup or verification required' : 'Unavailable');
    assertion(readiness.text.includes(item.name) && visibleState, `The UI hid the ${item.name} unavailability reason.`);
  }
  await capture('workspace-unavailable');
  end('unavailable');
  checks.push(unavailable.length ? 'honest-harness-unavailable-state' : 'all-installed-harnesses-available');

  begin('nativeLifecycle');
  const eligible = catalog.harnesses.find((item) =>
    item.status === 'available'
    && ((item.kind === 'prime-agent' && item.version === '0.9.2') || (item.kind === 'codex' && item.version === '0.147.0')));
  assertion(eligible, 'No eligible prompt-free native lifecycle adapter is available: require Prime Agent SDK 0.9.2 with the host isolated-daemon guard, or Codex app-server 0.147.0.');
  // The sidebar also has a Harness filter; choose the creation form's control.
  await setControl('#new-session-project', workspace.id, 'change');
  await setControl('#new-session-harness', eligible.kind, 'change');
  await clickButton('Create session');
  const expectedTitle = eligible.kind === 'prime-agent' ? 'New Prime Agent session' : 'New Codex session';
  try {
    await waitFor(`document.querySelector('#session-title')?.textContent?.trim() === ${JSON.stringify(expectedTitle)}`, 'prompt-free native session start', startupBoundMs);
  } catch (error) {
    await capture('workspace-native-start-failure');
    throw error;
  }
  catalog = await workspaceCatalog();
  const nativeSession = catalog.sessions.find((item) => item.workspaceId === workspace.id && item.harness === eligible.kind && item.title === expectedTitle);
  assertion(nativeSession && nativeSession.status !== 'closed' && nativeSession.status !== 'failed', 'The host did not retain the prompt-free native session.');
  const initialSnapshotResult = await invoke('workspace_command_v15', { command: { type: 'snapshot', sessionId: nativeSession.id } });
  assertion(initialSnapshotResult?.type === 'session', 'The typed host did not return the native session snapshot.');
  const serializedSnapshot = JSON.stringify(initialSnapshotResult);
  assertion(!serializedSnapshot.includes('nativeId') && !serializedSnapshot.includes('nativePath'), 'The workspace snapshot leaked a native id or path.');

  await clickButton('Session details');
  await waitFor(`document.querySelector('aside[aria-label="Session details"]')`, 'session details inspector');
  await setLabelledControl('Session title', 'Native lifecycle proof');
  await clickButton('Rename session', 'aside[aria-label="Session details"]');
  await waitFor(`document.querySelector('#session-title')?.textContent?.trim() === 'Native lifecycle proof'`, 'native session rename');
  const renamedSnapshot = await invoke('workspace_command_v15', { command: { type: 'snapshot', sessionId: nativeSession.id } });
  assertion(renamedSnapshot?.snapshot?.session?.title === 'Native lifecycle proof', 'Rename did not reach the native workspace host.');
  end('nativeLifecycle');
  if (process.env.PIUI_E2E_CATALOGS === '1') {
    for (const harness of ['codex', 'pi', 'prime-agent']) {
      await evaluate(`(() => { window.__catalogProof = undefined; window.__TAURI_INTERNALS__.invoke('harness_models_v18', { request: ${JSON.stringify({ workspaceId: nativeSession.workspaceId, harness })} }).then(value => window.__catalogProof = { value }, error => window.__catalogProof = { error }); return true; })()`);
      await waitFor('window.__catalogProof !== undefined', `${harness} native catalog`, startupBoundMs);
      const outcome = await evaluate('window.__catalogProof');
      assertion(!outcome.error, `${harness} catalog failed: ${JSON.stringify(outcome.error)}`);
      const result = outcome.value;
      assertion(result.protocol === 18, 'catalog protocol');
      assertion(result.harness === harness, 'catalog harness');
      assertion(Array.isArray(result.models), `${harness} native model catalog`);
      // Pi/Prime use isolated agent directories with no provider credentials.
      if (harness === 'codex') assertion(result.models.length > 0, 'Codex native model catalog');
      assertion(Array.isArray(result.resources.items), 'resource catalog');
      checks.push(`${harness} catalog: ${JSON.stringify({ models: result.models.length, reasoning: [...new Set(result.models.flatMap(model => model.thinkingLevels ?? []))], resources: result.resources.items.length, warnings: result.resources.warnings })}`);
      console.log(checks.at(-1));
    }
  }
  if (process.env.PIUI_E2E_GRAPH_ONLY === '1') {
    await clickButton('Workspace', '.view-switch');
    await selectWorkspaceSection('Systems');
    await setControl('.system-name', 'Inspector proof');
    await clickButton('＋ Add agent', '.canvas-tools');
    const inspector = 'aside[aria-label="Agent settings"]';
    const models = `${inspector} select[aria-label="Model"]`;
    await waitFor(`document.querySelector(${JSON.stringify(models)})?.options.length > 1 && !document.querySelector(${JSON.stringify(models)}).disabled`, 'graph native models', startupBoundMs);
    const model = await evaluate(`document.querySelector(${JSON.stringify(models)}).options[1].value`);
    await setControl(models, model, 'change');
    await setControl(`${inspector} textarea[aria-label="Task"]`, 'Prepare the implementation.');
    await setControl(`${inspector} textarea[aria-label="Input"]`, 'Approved specification and affected file paths.');
    await setControl(`${inspector} textarea[aria-label="When to call"]`, 'After implementation, when an independent review is needed.');
    await setControl(`${inspector} textarea[aria-label="Expected result"]`, 'Actionable findings with file paths and test evidence.');
    assertion(!await evaluate(`document.querySelector('.system-editor').textContent.includes('Advanced settings')`), 'separate advanced editor removed');
    const width = await evaluate(`document.querySelector(${JSON.stringify(inspector)}).getBoundingClientRect().width`);
    await evaluate(`(() => { const splitter = document.querySelector(${JSON.stringify(inspector)}).querySelector('[role="separator"]'); splitter.focus(); splitter.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft',bubbles:true})); })()`);
    await waitFor(`document.querySelector(${JSON.stringify(inspector)}).getBoundingClientRect().width > ${width}`, 'keyboard panel resize');
    await clickButton('Expand editor', inspector);
    await waitFor(`document.querySelector('[role="dialog"] textarea')?.getBoundingClientRect().height > document.querySelector(${JSON.stringify(inspector)}).querySelector('textarea').getBoundingClientRect().height`, 'expanded task editor');
    await setControl('.task-editor textarea', 'Prepare the implementation and test it.');
    await clickButton('Done', '.task-editor');
    await clickButton('Save', '.system-editor .toolbar');
    await waitFor(`document.querySelector('.system-editor .save-state')?.textContent === 'Saved'`, 'graph saved');
    const command = await readSingle('launch', nativeSession.workspaceId, 'Inspector proof');
    const saved = await invoke('orchestration_get_pipeline_v6', { request: { workspaceId: nativeSession.workspaceId, id: command.stored.value.pipelineId } });
    assertion(saved.value.steps[0].inputInstructions === 'Approved specification and affected file paths.', 'Input reaches durable pipeline');
    await clickButton('New system', '.system-editor .toolbar');
    await setControl('select[aria-label="Open system"]', command.stored.value.id, 'change');
    await waitFor(`document.querySelector('textarea[aria-label="Input"]')?.value === 'Approved specification and affected file paths.'`, 'Input restored');
    assertion(await evaluate(`document.querySelector('textarea[aria-label="When to call"]').value === 'After implementation, when an independent review is needed.'`), 'invocation criteria restored');
    assertion(await evaluate(`document.querySelector('textarea[aria-label="Expected result"]').value === 'Actionable findings with file paths and test evidence.'`), 'expected result restored');
    await capture('unified-inspector');
    return { native: { harness: eligible.kind, version: eligible.version, sessionId: nativeSession.id }, timings, screenshots, checks: [...checks, 'native-graph-model-selection', 'keyboard-resize', 'expanded-task-editor', 'durable-input-reload', 'inline-settings'] };
  }
  if (process.env.PIUI_E2E_CHAT_ONLY === '1') {
    await clickButton('Session details');
    await clickButton('Close native session', 'aside[aria-label="Session details"]');
    await verifyClosedNativeSession(nativeSession.id, 'auto-resume-close-failure');
    await reload();
    await waitFor(`document.querySelector('#session-draft') && !document.querySelector('#session-draft').disabled`, 'automatically restored composer', startupBoundMs);
    const restored = (await workspaceCatalog()).sessions.filter(session => session.id === nativeSession.id);
    assertion(restored.length === 1 && restored[0].status === 'idle', 'Automatic restore must keep the same chat ID');
    assertion(!(await evaluate(`document.body.textContent.includes('Continue chat')`)), 'Normal restore must not require Continue');
    await capture('automatic-chat-restore');
    return { checks: [...checks, 'automatic-same-id-chat-restore', 'no-continue-gate'], timings, screenshots, native: { harness: eligible.kind, version: eligible.version, sessionId: nativeSession.id }, cleanup: { workspaceId: workspace.id, safeFixture: SAFE_FIXTURE } };
  }
  checks.push('eligible-native-start', 'native-snapshot-no-private-reference', 'native-ui-rename');
  await clickButton('Model and reasoning');
  await waitFor(`document.querySelector('.runtime-picker select[aria-label="Model"]')?.options.length > 0 && !document.querySelector('.runtime-picker select').disabled`, 'native model catalog', startupBoundMs);
  let beforeSettings = await invoke('workspace_settings_v16', { command: { type: 'get', sessionId: nativeSession.id } });
  assertion(beforeSettings.protocol === 16 && beforeSettings.models.length > 0, 'Missing native model catalog');
  if (eligible.kind === 'codex') {
    const nextIndex = beforeSettings.models.findIndex(model => model.id !== beforeSettings.model?.id && model.thinkingLevels?.length);
    assertion(nextIndex >= 0, 'Native model-switch proof requires another catalog model');
    const nextModel = beforeSettings.models[nextIndex];
    await setControl('.runtime-picker select[aria-label="Model"]', String(nextIndex), 'change');
    await waitFor(`!document.querySelector('.runtime-picker select[aria-label="Model"]').disabled && document.querySelector('.runtime-picker .trigger')?.textContent.includes(${JSON.stringify(nextModel.name)})`, 'native model switched', startupBoundMs);
    beforeSettings = await invoke('workspace_settings_v16', { command: { type: 'get', sessionId: nativeSession.id } });
    assertion(beforeSettings.model.id === nextModel.id && beforeSettings.model.provider === nextModel.provider, 'Native model/provider did not change');
    checks.push('native-composer-model-switch');
    const selectedModel = beforeSettings.models.find(model => model.id === beforeSettings.model?.id);
    assertion(selectedModel?.thinkingLevels?.length, 'Codex reasoning metadata missing');
    const effort = selectedModel.thinkingLevels[0];
    await setControl('.runtime-picker select[aria-label="Reasoning"]', effort, 'change');
    await waitFor(`!document.querySelector('.runtime-picker .speed')?.disabled`, 'reasoning saved', startupBoundMs);
    const wasFast = beforeSettings.serviceTier === 'fast';
    await evaluate(`document.querySelector('.runtime-picker .speed').click()`);
    await waitFor(`document.querySelector('.runtime-picker .speed')?.getAttribute('aria-pressed') === ${JSON.stringify(String(!wasFast))} && !document.querySelector('.runtime-picker .speed').disabled`, 'Fast saved', startupBoundMs);
    const changed = await invoke('workspace_settings_v16', { command: { type: 'get', sessionId: nativeSession.id } });
    assertion(changed.thinkingLevel === effort && changed.serviceTier === (wasFast ? 'standard' : 'fast'), 'Settings did not reach native Codex');
    await assertRejected('workspace_settings_v16', { command: { type: 'set', sessionId: nativeSession.id, model: selectedModel, thinkingLevel: 'not-a-native-level' } }, 'Invalid native reasoning');
    const clean = await invoke('workspace_command_v15', { command: { type: 'snapshot', sessionId: nativeSession.id } });
    assertion(!clean.snapshot.blocks.some(block => block.safeSummary?.includes('mcpServer/startupStatus') || block.safeSummary?.includes('thread/settings')), 'Lifecycle notifications leaked into chat');
  }
  await capture('workspace-runtime-picker');
  assertion(await evaluate(`(() => { const popup = document.querySelector('.runtime-picker .popover'); const model = popup?.querySelector('select'); if (!popup || !model) return false; const rect = model.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === model; })()`), 'Model picker is clipped or covered');
  await automation.dispatchKey({ key: 'Escape', code: 'Escape' });
  await waitFor(`!document.querySelector('.runtime-picker .popover')`, 'model picker Escape');
  assertion(await evaluate(`document.activeElement?.getAttribute('aria-label') === 'Model and reasoning'`), 'Model picker lost keyboard focus');
  checks.push('native-model-reasoning-fast-settings', 'native-settings-failure', 'model-picker-keyboard', 'no-mcp-transcript-noise');


  await clickButton('Close inspector');
  const geometry = await evaluate(`(() => {
    const composer = document.querySelector('.composer-shell').getBoundingClientRect();
    const messages = document.querySelector('.timeline-scroller').getBoundingClientRect();
    return { composerVisible: composer.top >= 0 && composer.bottom <= innerHeight, messagesVisible: messages.height > 0 && messages.bottom <= composer.top };
  })()`);
  assertion(geometry.composerVisible && geometry.messagesVisible, 'The conversation must scroll above a visible composer.');
  // Synthetic size fixture, only in this isolated WebView: no transcript or native file is changed.
  await evaluate(`(() => { const timeline = document.querySelector('.timeline'); timeline.style.minHeight = '300vh'; })()`);
  await waitFor(`(() => { const node = document.querySelector('.timeline-scroller'); return node.scrollHeight - node.clientHeight - node.scrollTop <= 1; })()`, 'follow conversation end');
  await evaluate(`document.querySelector('.timeline-scroller').scrollTop = 0`);
  await waitFor(`document.querySelector('.jump-latest')`, 'back to latest affordance');
  await evaluate(`document.querySelector('.timeline').style.minHeight = '400vh'`);
  assertion(await evaluate(`document.querySelector('.timeline-scroller').scrollTop === 0`), 'An update interrupted reading older messages.');
  await clickButton('↓ Back to latest');
  await waitFor(`!document.querySelector('.jump-latest')`, 'return to conversation end');
  await evaluate(`document.querySelector('.timeline').style.removeProperty('min-height')`);
  await capture('workspace-conversation');
  checks.push('composer-visible-with-scroll', 'conversation-follow-and-reading-position');

  await clickButton('Workspace', '.view-switch');
  await selectWorkspaceSection('Agents');
  await clickButton('Create profile');
  await waitFor(`document.querySelector('#profile-name') && !document.querySelector('#profile-name').disabled`, 'editable profile for navigation proof');
  await setControl('#profile-name', 'Unsaved navigation proof');
  await automation.dispatchKey({ key: 'n', code: 'KeyN', ctrlKey: true });
  await waitFor(`document.querySelector('#discard-title')`, 'dirty new-chat guard');
  await automation.dispatchKey({ key: 'Escape', code: 'Escape' });
  assertion(await evaluate(`document.querySelector('#profile-name')?.value === 'Unsaved navigation proof' && !document.querySelector('#discard-title')`), 'Escape must preserve the unsaved editor.');
  await automation.dispatchKey({ key: 'n', code: 'KeyN', ctrlKey: true });
  await clickButton('Discard changes', '[aria-labelledby="discard-title"]');
  await waitFor(`document.querySelector('#new-session-title')`, 'confirmed new-chat navigation');
  await clickButton('Cancel', '.new-session');
  await evaluate(`(() => { const title = [...document.querySelectorAll('.session-title')].find((node) => node.textContent === 'Native lifecycle proof'); title?.closest('button')?.click(); })()`);
  await waitFor(`document.querySelector('#session-title')`, 'return to original session');
  checks.push('dirty-editor-navigation-guard', 'modal-escape-preserves-input', 'explicit-discard-navigation');

  assertion(await evaluate(`!document.body.textContent.includes('Legacy history')`), 'Removed history navigation must not reappear.');
  checks.push('no-legacy-history-navigation');

  begin('appearance');
  await clickButton('Settings');
  await waitFor(`document.querySelector('#workspace-settings-title')`, 'workspace settings');
  await setLabelledControl('Theme', 'light', 'change');
  await waitFor(`document.documentElement.dataset.theme === 'light'`, 'light theme');
  const lightColor = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim()`);
  await capture('workspace-light');
  await setLabelledControl('Theme', 'dark', 'change');
  await waitFor(`document.documentElement.dataset.theme === 'dark'`, 'dark theme');
  const darkColor = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim()`);
  assertion(lightColor && darkColor && lightColor !== darkColor, 'Light and dark themes resolved to the same background token.');
  await setControl('select[aria-label="Language"]', 'ru', 'change');
  await waitFor(`document.documentElement.lang === 'ru' && document.querySelector('#workspace-settings-title')?.textContent === 'Настройки'`, 'Russian settings');
  await capture('workspace-russian-settings');
  await reload();
  assertion(await evaluate(`document.documentElement.lang === 'ru'`), 'Language choice was not persisted');
  await clickButton('Настройки', '.utilities');
  await setControl('select[aria-label="Language"]', 'en', 'change');
  await waitFor(`document.documentElement.lang === 'en'`, 'English settings');
  await clickButton('Done');

  await resizeWindow({ width: 720, height: 700, appOwnerPid });
  await waitFor(`innerWidth <= 760 && getComputedStyle(document.querySelector('.narrow-context')).display !== 'none'`, 'narrow navigation context', startupBoundMs);
  const narrow = await evaluate(`(() => ({
    width: innerWidth,
    openLabel: document.querySelector('button[aria-label="Open navigation"]') !== null,
    navInitiallyHidden: getComputedStyle(document.querySelector('aside[aria-label="Workspace navigation"]')).position === 'fixed',
    scrimAbsent: document.querySelector('.nav-scrim') === null,
  }))()`);
  assertion(narrow.width <= 760 && narrow.openLabel && narrow.navInitiallyHidden && narrow.scrimAbsent, 'The narrow workspace did not retain its closed, labelled navigation drawer.');
  await capture('workspace-narrow-dark-closed');
  await clickButton('Open navigation');
  await waitFor(`document.querySelector('aside[aria-label="Workspace navigation"]')?.classList.contains('open')`, 'open narrow navigation');
  await capture('workspace-narrow-dark');
  await clickButton('Close navigation');
  await resizeWindow({ width: 1180, height: 780, appOwnerPid });
  await waitFor(`innerWidth > 760`, 'restored wide workspace', startupBoundMs);
  end('appearance');
  checks.push('light-dark-theme', 'narrow-labelled-drawer');

  begin('orchestrationCrud');
  await createAndUpdateDefinitions(workspace.id);
  await seedSafeModeRunDefinitions(workspace.id);
  end('orchestrationCrud');
  checks.push('profile-team-pipeline-command-ui-crud', 'definition-host-reload-persistence', 'saved-command-ui-launch', 'native-preflight-run-recorded-failed', 'policy-preflight-started-no-native-session');

  begin('rejections');
  await assertRejected('workspace_command_v15', { command: { type: 'shell', command: 'whoami' } }, 'Unknown workspace command');
  await assertRejected('workspace_command_v15', { command: { type: 'snapshot', sessionId: nativeSession.id, nativePath: projectPath } }, 'Forged native path field');
  await assertRejected('workspace_command_v15', { command: { type: 'createSession', workspaceId: workspace.id, harness: eligible.kind, permissionMode: 'native', profileId: 'forged-profile-id' } }, 'Forged ordinary-session profile field');
  await assertRejected('orchestration_catalog_v6', { request: { workspaceId: workspace.id, actor: 'forged-actor' } }, 'Forged orchestration actor field');
  await assertRejected('workspace_command_v15', { command: { type: 'respond', sessionId: nativeSession.id, requestId: 'forged-approval', decision: 'approve-once' } }, 'Forged approval reply', 'approval');
  const forgedWorkspaceProfile = {
    id: 'forged-profile', name: 'Forged profile', harness: 'pi', model: 'native', permissionMode: 'native',
    instructions: '', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [],
  };
  await assertRejected('workspace_command_v15', { command: { type: 'createSession', workspaceId: 'forged-workspace-id', harness: eligible.kind, permissionMode: 'native' } }, 'Unknown native-session workspace');
  await assertRejected('orchestration_save_profile_v6', { request: { workspaceId: 'forged-workspace-id', value: forgedWorkspaceProfile } }, 'Unknown orchestration workspace');
  end('rejections');
  checks.push('unknown-command-rejected', 'native-path-field-rejected', 'ordinary-profile-field-rejected', 'actor-field-rejected', 'forged-approval-rejected', 'unknown-native-and-orchestration-workspaces-rejected');

  begin('nativeClose');
  await clickButton('Sessions', '.view-switch');
  await waitFor(`document.querySelector('#session-title')?.textContent?.trim() === 'Native lifecycle proof'`, 'native session after workspace CRUD', startupBoundMs);
  await clickButton('Session details');
  await waitFor(`document.querySelector('aside[aria-label="Session details"]')`, 'session details before close');
  await clickButton('Close native session', 'aside[aria-label="Session details"]');
  catalog = await verifyClosedNativeSession(nativeSession.id, 'workspace-close-failure-initial');

  try {
    await reload();
    assertion(!(await evaluate(`document.body.textContent.includes('Continue chat')`)), 'A saved chat must not require a Continue button');
    await waitFor(`[...document.querySelectorAll('.session-list > button')].some((item) => item.querySelector('.session-title')?.textContent?.trim() === 'Native lifecycle proof' && item.textContent?.includes('Idle'))`, 'zero-turn native session reopened as idle', startupBoundMs);
    catalog = await workspaceCatalog();
    const reopenedById = catalog.sessions.filter((item) => item.id === nativeSession.id);
    const reopenedByIdentity = catalog.sessions.filter((item) => item.title === 'Native lifecycle proof' && item.harness === eligible.kind);
    assertion(reopenedById.length === 1 && reopenedById[0].status === 'idle', 'Zero-turn reopen did not retain the same opaque workspace session ID in idle state.');
    assertion(reopenedByIdentity.length === 1 && reopenedByIdentity[0].id === nativeSession.id, 'Zero-turn reopen created a duplicate workspace session.');
    await clickButton('Session details');
    await waitFor(`document.querySelector('aside[aria-label="Session details"] button.danger-zone')?.textContent?.trim() === 'Close native session'`, 'reopened native session close control');
  } catch {
    const catalogOutcome = await invokeOutcome('workspace_command_v15', { command: { type: 'catalog' } });
    const latest = catalogOutcome?.ok === true && catalogOutcome.value?.type === 'catalog' ? catalogOutcome.value.catalog : undefined;
    const reopened = latest?.sessions?.find((item) => item.id === nativeSession.id);
    const catalogStatus = ['starting', 'idle', 'running', 'stopping', 'closed', 'failed'].includes(reopened?.status) ? reopened.status : 'missing';
    const catalogModel = safeDiagnosticName(reopened?.model?.name);
    const catalogProvider = safeDiagnosticName(reopened?.model?.provider);
    const snapshot = await invokeOutcome('workspace_command_v15', { command: { type: 'snapshot', sessionId: nativeSession.id } });
    const snapshotValue = snapshot?.ok === true && snapshot.value?.type === 'session' ? snapshot.value.snapshot : undefined;
    const snapshotStatus = snapshotValue && ['starting', 'idle', 'running', 'stopping', 'closed', 'failed'].includes(snapshotValue.session?.status)
      ? `SUCCESS_${snapshotValue.session.status.toUpperCase()}`
      : (snapshot?.ok === true ? 'SUCCESS_UNKNOWN' : safeErrorCode(snapshot?.error));
    const snapshotModel = safeDiagnosticName(snapshotValue?.session?.model?.name);
    const snapshotProvider = safeDiagnosticName(snapshotValue?.session?.model?.provider);
    await capture('workspace-reopen-failure');
    throw new Error(`Native zero-turn reopen proof failed. Catalog status: ${catalogStatus}. Catalog model/provider: ${catalogModel}/${catalogProvider}. Snapshot status: ${snapshotStatus}. Snapshot model/provider: ${snapshotModel}/${snapshotProvider}.`);
  }
  await clickButton('Close native session', 'aside[aria-label="Session details"]');
  catalog = await verifyClosedNativeSession(nativeSession.id, 'workspace-close-failure-after-reopen');
  end('nativeClose');
  checks.push('native-ui-close', 'zero-turn-ui-reopen-same-session', 'native-ui-reclose');

  await clickButton('Delete chat', 'aside[aria-label="Session details"]');
  await waitFor(`document.querySelector('[aria-labelledby="delete-chat-title"]')`, 'delete confirmation');
  assertion(await evaluate(`document.querySelector('.shell').inert && document.activeElement?.closest('[role="dialog"]') !== null`), 'Deletion dialog traps keyboard focus');
  await clickButton('Cancel', '[aria-labelledby="delete-chat-title"]');
  assertion((await workspaceCatalog()).sessions.some(session => session.id === nativeSession.id), 'Cancelling deletion must retain the chat');
  await clickButton('Delete chat', 'aside[aria-label="Session details"]');
  await clickButton('Delete chat', '[aria-labelledby="delete-chat-title"]');
  await waitFor(`!document.querySelector('[aria-labelledby="delete-chat-title"]')`, 'deleted chat confirmation closes');
  await reload();
  assertion(!(await workspaceCatalog()).sessions.some(session => session.id === nativeSession.id), 'Deleted chat returned after reload');
  checks.push('saved-chat-auto-resume-after-reload', 'delete-chat-cancel-focus-and-reload');
  timings.total = normalizedMilliseconds(performance.now() - startedAt);
  return {
    checks,
    timings,
    screenshots,
    native: { harness: eligible.kind, version: eligible.version, sessionId: nativeSession.id },
    cleanup: { workspaceId: workspace.id, safeFixture: SAFE_FIXTURE },
  };
}
