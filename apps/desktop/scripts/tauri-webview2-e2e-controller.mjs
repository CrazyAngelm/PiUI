// Outside-Job controller for the isolated Windows Tauri/WebView2 E2E proof.
//
// Default: the new shell (default view); `--agent-api` runs the agent API
// proof. Cargo builds go to
// PIUI_E2E_CARGO_TARGET_DIR, else CARGO_TARGET_DIR, else <repo>/target; the
// isolated fixture always lives in <repo>/target/piui-e2e (the debug host
// accepts no other root).
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { removeDirectoryWithRetries, removeOwnedFixtureRoot } from './webview-automation.mjs';

if (process.platform !== 'win32') {
  throw new Error('The Tauri WebView2 E2E controller is Windows-only.');
}

const DESKTOP_ROOT = resolve(import.meta.dirname, '..');
const REPOSITORY_ROOT = resolve(DESKTOP_ROOT, '..', '..');
const COMMAND_BOUND_MS = 5_000;
// Derived from the inner 600 s build, two 30 s startup bounds, and 40 s for
// its bounded commands plus outer teardown. e2e-platform.mjs retains 20 s
// beyond this before its own 720 s terminal bound.
const INNER_HARNESS_BOUND_MS = 700_000;
const JOB_RUNNER_BUILD_BOUND_MS = 600_000;
const SCENARIO_FLAGS = ['--agent-api'];

function waitFor(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitForBounded(operation, boundMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its bounded run.`)), boundMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isPathInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function canonicalRepositoryTarget() {
  const canonicalRepository = realpathSync(REPOSITORY_ROOT);
  const expectedTarget = join(canonicalRepository, 'target');
  mkdirSync(expectedTarget, { recursive: true });
  const canonicalTarget = realpathSync(expectedTarget);
  if (relative(expectedTarget, canonicalTarget) !== '') {
    throw new Error('The repository target must not resolve through a reparse escape.');
  }
  return canonicalTarget;
}

function canonicalRepositoryE2eArea() {
  const repositoryTarget = canonicalRepositoryTarget();
  const expectedArea = join(repositoryTarget, 'piui-e2e');
  mkdirSync(expectedArea, { recursive: true });
  const canonicalArea = realpathSync(expectedArea);
  if (relative(expectedArea, canonicalArea) !== '') {
    throw new Error('The repository E2E area must not resolve through a reparse escape.');
  }
  return canonicalArea;
}

/** Cargo output directory: a private one when configured, else <repo>/target. */
function canonicalCargoTarget() {
  const configured = process.env.PIUI_E2E_CARGO_TARGET_DIR || process.env.CARGO_TARGET_DIR;
  if (!configured) return canonicalRepositoryTarget();
  if (!isAbsolute(configured)) throw new Error('The E2E cargo target directory must be an absolute path.');
  mkdirSync(configured, { recursive: true });
  const canonical = realpathSync(configured);
  if (relative(resolve(configured), canonical) !== '') {
    throw new Error('The E2E cargo target directory must not resolve through a reparse point.');
  }
  return canonical;
}

function buildJobRunner(cargoTarget) {
  // Built outside the Job, as before; only the feature-gated runner binary.
  const result = spawnSync('cargo', [
    'build', '--quiet', '--target-dir', cargoTarget,
    '-p', 'piui-platform', '--features', 'e2e-harness', '--bin', 'piui-e2e-job',
  ], { cwd: REPOSITORY_ROOT, stdio: 'inherit', timeout: JOB_RUNNER_BUILD_BOUND_MS, windowsHide: true });
  if (result.error) throw new Error(`The E2E Job runner build could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`The E2E Job runner build failed with exit code ${result.status}.`);
}

function resolveJobRunner(cargoTarget) {
  const expected = join(cargoTarget, 'debug', 'piui-e2e-job.exe');
  if (!existsSync(expected)) throw new Error('The feature-gated E2E Job runner was not built.');
  const canonical = realpathSync(expected);
  if (relative(expected, canonical) !== '' || !isPathInside(cargoTarget, canonical)) {
    throw new Error('The E2E Job runner escaped its exact cargo target artifact.');
  }
  return canonical;
}

function consumeControlStream(child) {
  let pending = Buffer.alloc(0);
  let started = false;
  let terminated = false;
  let failure;

  function fail(error) {
    if (failure === undefined) failure = error;
  }

  function accept(record) {
    if (record.length === 0 || record.includes(0x0D)) {
      fail(new Error('The outer Job runner emitted a non-LF control record.'));
      return;
    }
    let message;
    try {
      message = JSON.parse(record.toString('utf8'));
    } catch {
      fail(new Error('The outer Job runner emitted invalid control JSON.'));
      return;
    }
    if (message?.type === 'started') {
      if (started || terminated) fail(new Error('The outer Job runner emitted an invalid started record.'));
      else started = true;
      return;
    }
    if (message?.type === 'terminated') {
      if (!started || terminated || message.activeProcesses !== 0 || message.jobClosed !== true) {
        fail(new Error('The outer Job runner did not prove one empty, closed Job Object.'));
      } else {
        terminated = true;
      }
      return;
    }
    if (message?.type === 'spawn_error') {
      fail(new Error('The outer Job runner could not launch the contained harness.'));
      return;
    }
    if (message?.type === 'runner_error' && typeof message.phase === 'string') {
      fail(new Error(`The outer Job runner failed during ${message.phase}.`));
      return;
    }
    fail(new Error('The outer Job runner emitted an unexpected control record.'));
  }

  child.stdout.on('data', (chunk) => {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    while (true) {
      const newline = pending.indexOf(0x0A);
      if (newline < 0) return;
      const record = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      accept(record);
    }
  });
  child.stdout.once('error', (error) => fail(new Error(`Outer Job control stream failed: ${error.message}`)));

  return {
    finish() {
      if (pending.length !== 0) fail(new Error('The outer Job runner left an incomplete control record.'));
      if (!started) fail(new Error('The outer Job runner never acknowledged launch.'));
      if (!terminated) fail(new Error('The outer Job runner never proved an empty Job Object.'));
      if (failure !== undefined) throw failure;
    },
  };
}

function findInnerPassReport(logPath) {
  const reports = [];
  for (const line of readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value?.status === 'pass' && value?.target === 'isolated Tauri WebView2 dev harness') {
      reports.push(value);
    }
  }
  if (reports.length !== 1) {
    throw new Error(`The contained harness emitted ${reports.length} pass reports instead of one.`);
  }
  return reports[0];
}

function printLogTail(path) {
  try {
    const tail = readFileSync(path, 'utf8').slice(-4_000);
    if (tail.length > 0) console.error(`--- ${path} ---\n${tail}`);
  } catch {
    // The outer runner may have failed before creating its target log.
  }
}

function persistRunEvidence(runRoot) {
  const target = canonicalRepositoryTarget();
  const evidenceArea = join(target, 'piui-evidence');
  mkdirSync(evidenceArea, { recursive: true });
  if (realpathSync(evidenceArea) !== evidenceArea) throw new Error('Evidence area is a reparse escape.');
  const evidence = join(evidenceArea, `${process.pid}-${Date.now()}`);
  mkdirSync(evidence);
  if (realpathSync(evidence) !== evidence) throw new Error('Evidence destination changed identity.');
  // Copy only logs and screenshots after the outer Job has closed. Never copy
  // native homes, session data, package junctions, credentials or arbitrary files.
  for (const name of readdirSync(runRoot)) {
    const source = join(runRoot, name);
    if (name.endsWith('.log') && lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink()) {
      copyFileSync(source, join(evidence, name));
    }
  }
  const screenshots = join(runRoot, 'workspace-screenshots');
  if (existsSync(screenshots)) {
    if (!isPathInside(runRoot, realpathSync(screenshots))) throw new Error('Screenshot source escaped fixture.');
    for (const name of readdirSync(screenshots)) {
      const source = join(screenshots, name);
      if (name.endsWith('.png') && lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink()) {
        copyFileSync(source, join(evidence, name));
      }
    }
  }
  return evidence;
}

async function runController() {
  const cargoTarget = canonicalCargoTarget();
  buildJobRunner(cargoTarget);
  const canonicalArea = canonicalRepositoryE2eArea();
  const runRoot = join(canonicalArea, String(process.pid));
  await removeDirectoryWithRetries(runRoot, {
    remove: (path) => removeOwnedFixtureRoot(path, canonicalArea),
    wait: waitFor,
    boundMs: COMMAND_BOUND_MS,
    retryDelayMs: 100,
  });
  mkdirSync(runRoot);
  const canonicalRunRoot = realpathSync(runRoot);
  if (relative(runRoot, canonicalRunRoot) !== '') {
    throw new Error('The controller run root resolved through a reparse escape.');
  }

  const outerLog = join(canonicalRunRoot, 'outer-harness.log');
  const jobRunner = resolveJobRunner(cargoTarget);
  const innerHarness = resolve(import.meta.dirname, 'tauri-webview2-dialog-e2e.mjs');
  let child;
  let childClosed;
  let closeOutcome;
  let runFailure;
  let passReport;
  let evidenceDirectory;
  const cleanupErrors = [];
  try {
    child = spawn(jobRunner, [
      '--controlled', '--cleanup-bound-ms', String(COMMAND_BOUND_MS), '--log', outerLog,
      '--', process.execPath, innerHarness, ...process.argv.filter(argument => SCENARIO_FLAGS.includes(argument)),
    ], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, PIUI_E2E_RUN_ROOT: canonicalRunRoot, PIUI_E2E_CARGO_TARGET_DIR: cargoTarget },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const control = consumeControlStream(child);
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    childClosed = new Promise((resolveClose, rejectClose) => {
      child.once('error', rejectClose);
      child.once('close', (code, signal) => {
        closeOutcome = { code, signal };
        resolveClose(closeOutcome);
      });
    });
    const close = await waitForBounded(() => childClosed, INNER_HARNESS_BOUND_MS, 'Outer E2E Job');
    control.finish();
    if (close.code !== 0 || close.signal !== null) {
      const result = close.code === null ? `signal ${close.signal ?? 'unknown'}` : `exit code ${close.code}`;
      throw new Error(`The contained E2E harness failed with ${result}.`);
    }
    passReport = findInnerPassReport(outerLog);
  } catch (error) {
    runFailure = error;
  } finally {
    if (child !== undefined && closeOutcome === undefined) {
      try {
        if (child.stdin !== null && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
        await waitForBounded(() => childClosed, COMMAND_BOUND_MS, 'Outer E2E Job cleanup');
      } catch (error) {
        cleanupErrors.push(error);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        try {
          await waitForBounded(() => childClosed, COMMAND_BOUND_MS, 'Outer E2E Job fallback');
        } catch (fallbackError) {
          cleanupErrors.push(fallbackError);
        }
      }
    }
    if (runFailure !== undefined || cleanupErrors.length > 0) printLogTail(outerLog);
    try {
      if (closeOutcome !== undefined) {
        evidenceDirectory = persistRunEvidence(canonicalRunRoot);
        if (passReport) {
          passReport.screenshots = (passReport.screenshots ?? []).map((item) => {
            if (typeof item === 'string') return join(evidenceDirectory, basename(item));
            return { ...item, path: join(evidenceDirectory, basename(item.path)) };
          });
          writeFileSync(join(evidenceDirectory, 'report.json'), JSON.stringify(passReport, null, 2));
        }
        console.log(JSON.stringify({ evidenceDirectory }));
      }
    } catch (error) { cleanupErrors.push(error); }
    try {
      await removeDirectoryWithRetries(canonicalRunRoot, {
        remove: (path) => removeOwnedFixtureRoot(path, canonicalArea),
        wait: waitFor,
        boundMs: COMMAND_BOUND_MS,
        retryDelayMs: 100,
      });
      if (existsSync(canonicalRunRoot)) {
        throw new Error('The E2E run directory still exists after bounded controller cleanup.');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (runFailure !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([runFailure, ...cleanupErrors], 'The E2E harness and outside-Job cleanup failed.');
  }
  if (runFailure !== undefined) throw runFailure;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Outside-Job E2E cleanup failed.');
  console.log(JSON.stringify({
    ...passReport,
    checks: [
      ...passReport.checks,
      'outer-job-empty-before-fixture-removal',
      'fixture-removed',
    ],
  }));
}

await runController();
