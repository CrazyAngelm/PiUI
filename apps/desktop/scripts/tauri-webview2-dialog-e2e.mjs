// Windows WebView2 interaction proof for an isolated Tauri dev harness.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebviewAutomationServer } from './webview-automation.mjs';
import { runWorkspaceWebview2Proof } from './workspace-webview2-e2e.mjs';

const WORKSPACE_SCENARIO = process.argv.includes('--workspace');

if (process.platform !== 'win32') {
  throw new Error('This WebView2 proof is Windows-only; run the Linux WebKit harness separately.');
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(SCRIPT_DIR, '..');
const REPOSITORY_ROOT = resolve(DESKTOP_ROOT, '..', '..');
const STARTUP_BOUND_MS = 30_000;
const BUILD_BOUND_MS = 600_000;
const COMMAND_BOUND_MS = 5_000;
const TAURI_DATABASE_FILE = 'piui-foundation.sqlite';
const PRIME_RUNTIME_SESSION = Object.freeze({
  fileName: 'prime-runtime.jsonl',
  nativeId: 'fixture-prime-session',
  name: 'Prime fixture C',
});

function isPathInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function assertFixturePath(fixtureRoot, path, label) {
  const canonicalFixtureRoot = realpathSync(fixtureRoot);
  const canonicalPath = realpathSync(path);
  if (!isPathInside(canonicalFixtureRoot, canonicalPath)) {
    throw new Error(`${label} escaped the owned E2E fixture.`);
  }
}

function canonicalRepositoryTarget() {
  const canonicalRepository = realpathSync(REPOSITORY_ROOT);
  const expectedTarget = join(canonicalRepository, 'target');
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

function assertIsolatedTauriData(fixture) {
  const databasePath = join(fixture.tauriAppData, TAURI_DATABASE_FILE);
  if (!existsSync(databasePath)) {
    throw new Error('The isolated Tauri app-data database was not created.');
  }
  if (readdirSync(fixture.webviewData).length === 0) {
    throw new Error('The isolated WebView2 profile was not created.');
  }
  assertFixturePath(fixture.fixtureRoot, fixture.tauriAppData, 'Tauri app-data directory');
  assertFixturePath(fixture.fixtureRoot, databasePath, 'Tauri app-data database');
  assertFixturePath(fixture.fixtureRoot, fixture.webviewData, 'WebView2 profile directory');
  assertFixturePath(fixture.fixtureRoot, fixture.temporaryDirectory, 'runtime temporary directory');
}

function assertPrimeRuntimeWasNotLaunched(fixture) {
  const rootJsonl = readdirSync(fixture.primeSessions, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort();
  const expected = ['prime-one.jsonl', 'prime-two.jsonl'].sort();
  if (JSON.stringify(rootJsonl) !== JSON.stringify(expected)) {
    throw new Error('The read-only Prime flow created or changed the isolated runtime session set.');
  }
}

function writeSyntheticSession(path, header, records) {
  writeFileSync(path, `${[header, ...records].map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function writeMockExtensionRuntime(packageRoot, agentDirectoryEnvironment) {
  const dist = join(packageRoot, 'dist');
  mkdirSync(join(dist, 'core'), { recursive: true });
  writeFileSync(join(dist, 'core', 'settings-manager.js'), `export const SettingsManager = {
  create() {
    const settings = { extensions: [], packages: [] };
    return {
      getGlobalSettings: () => settings,
      setExtensionPaths: (extensions) => { settings.extensions = extensions; },
      setPackages: (packages) => { settings.packages = packages; },
    };
  },
};
`, 'utf8');
  writeFileSync(join(dist, 'core', 'package-manager.js'), `export class DefaultPackageManager {
  async resolve() { return { extensions: [] }; }
}
`, 'utf8');
  writeFileSync(join(dist, 'config.js'), `export function getAgentDir() {
  return process.env[${JSON.stringify(agentDirectoryEnvironment)}] ?? process.cwd();
}
`, 'utf8');
}

function createMockPrimeCli(packageRoot) {
  const cliPath = join(packageRoot, 'dist', 'bundle', 'cli.js');
  mkdirSync(dirname(cliPath), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'prime-agent',
    version: '0.8.1',
    type: 'module',
    bin: { 'prime-agent': 'dist/bundle/cli.js' },
  }, null, 2));
  writeMockExtensionRuntime(packageRoot, 'PRIME_AGENT_CODING_AGENT_DIR');
  // This fixture uses only the two explicit fixture paths below. It never
  // opens provider, network, auth, home, or user application data. Startup
  // adds one root source so catalog binding can be proven without a prompt.
  writeFileSync(cliPath, String.raw`import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const state = {
  sessionId: ${JSON.stringify(PRIME_RUNTIME_SESSION.nativeId)},
  sessionName: ${JSON.stringify(PRIME_RUNTIME_SESSION.name)},
  messageCount: 0,
  pendingMessageCount: 1,
  isStreaming: false,
  isCompacting: false,
  autoCompactionEnabled: true,
  steeringMode: 'all',
  followUpMode: 'all',
  thinkingLevel: 'medium',
  goal: {
    goalId: 'fixture-goal',
    status: 'active',
    objective: 'Synthetic Prime goal',
    tokensUsed: 7,
    tokenBudget: 20,
    timeUsedSeconds: 1,
    continuationsUsed: 0,
  },
  sessionActions: { active: { kind: 'fixture' }, queuedCount: 1 },
};
const fixtureSessionFileName = ${JSON.stringify(PRIME_RUNTIME_SESSION.fileName)};

function isInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function fixtureDirectory(environment) {
  const value = process.env[environment];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Missing isolated Prime fixture directory.');
  }
  const canonical = realpathSync(value);
  if (!lstatSync(canonical).isDirectory()) {
    throw new Error('Prime fixture directory is not a directory.');
  }
  return canonical;
}

function createFixtureRootSession() {
  const fixtureRoot = fixtureDirectory('PIUI_E2E_FIXTURE_ROOT');
  const sessionRoot = fixtureDirectory('PRIME_AGENT_SESSION_DIR');
  const projectRoot = fixtureDirectory('PIUI_E2E_PRIME_PROJECT');
  if (!isInside(fixtureRoot, sessionRoot) || !isInside(fixtureRoot, projectRoot)) {
    throw new Error('Prime fixture paths escaped the owned fixture root.');
  }
  if (relative(projectRoot, realpathSync(process.cwd())) !== '') {
    throw new Error('Prime fixture runtime did not start in its isolated project.');
  }
  const sessionFile = join(sessionRoot, fixtureSessionFileName);
  if (!isInside(sessionRoot, sessionFile)) {
    throw new Error('Prime fixture session path escaped its isolated root.');
  }
  writeFileSync(sessionFile, JSON.stringify({
    type: 'session',
    version: 3,
    id: state.sessionId,
    name: state.sessionName,
    cwd: projectRoot,
  }) + '\n', { encoding: 'utf8', flag: 'wx' });
}

createFixtureRootSession();

let emittedActivities = false;
let pending = Buffer.alloc(0);
let failed = false;

function failProtocol() {
  failed = true;
  process.exitCode = 1;
}

function emit(frame) {
  if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(frame) + '\n');
}

function dataFor(type) {
  switch (type) {
    case 'get_state': return state;
    case 'get_available_models': return {
      models: [{ provider: 'fixture', id: 'fixture-model', label: 'Fixture model' }],
    };
    case 'get_commands': return { commands: [] };
    case 'get_heartbeat': return { heartbeat: null };
    case 'list_schedules': return { jobs: [] };
    default: return {};
  }
}

function handleRecord(record) {
  if (record.length === 0) return failProtocol();
  let request;
  try {
    request = JSON.parse(record.toString('utf8'));
  } catch {
    return failProtocol();
  }
  if (typeof request.id !== 'string' || typeof request.type !== 'string') return failProtocol();
  emit({ type: 'response', id: request.id, command: request.type, success: true, data: dataFor(request.type) });
  if (request.type === 'get_state' && !emittedActivities) {
    emittedActivities = true;
    setTimeout(() => {
      emit({
        type: 'rlm_child_update',
        child: {
          id: 'fixture-child-id',
          label: 'fixture-hidden-child-label',
          status: 'running',
          model: 'fixture-model',
          activity: { kind: 'executing', toolName: 'read' },
          toolUseCount: 2,
          tokenCount: 42,
        },
      });
      // The adapter must render this as a payload-free compatibility activity.
      emit({ type: 'fixture_future_event', untrusted: 'fixture-hidden-payload' });
    }, 25);
  }
}

// This peer follows the same LF-only framing contract as the adapter: only
// byte 0x0A terminates a record, and an optional preceding CR is accepted.
process.stdin.on('data', (chunk) => {
  if (failed) return;
  pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
  while (true) {
    const newline = pending.indexOf(0x0A);
    if (newline < 0) return;
    let record = pending.subarray(0, newline);
    pending = pending.subarray(newline + 1);
    if (record.length > 0 && record[record.length - 1] === 0x0D) record = record.subarray(0, -1);
    handleRecord(record);
    if (failed) return;
  }
});
process.stdin.on('end', () => {
  if (pending.length !== 0) failProtocol();
});
process.stdin.on('error', failProtocol);
`, 'utf8');
  return cliPath;
}

function createMockPiCli(packageRoot) {
  const cliPath = join(packageRoot, 'dist', 'cli.js');
  mkdirSync(dirname(cliPath), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: '0.82.1',
    type: 'module',
    bin: { pi: 'dist/cli.js' },
  }, null, 2));
  writeMockExtensionRuntime(packageRoot, 'PI_CODING_AGENT_DIR');
  // The normal proof never launches Pi. This sentinel makes accidental launch
  // fail without a provider or filesystem side effect.
  writeFileSync(cliPath, "throw new Error('The isolated Pi extension fixture is not a runtime.');\n", 'utf8');
  return cliPath;
}

function createIsolatedFixture(fixtureRoot) {
  const piSessions = join(fixtureRoot, 'pi-sessions');
  const primeSessions = join(fixtureRoot, 'prime-sessions');
  const piAgentDir = join(fixtureRoot, 'pi-agent');
  const primeAgentDir = join(fixtureRoot, 'prime-agent');
  const piProject = join(fixtureRoot, 'pi-project');
  const primeProject = join(fixtureRoot, 'prime-project');
  const tauriAppData = join(fixtureRoot, 'tauri-app-data');
  const webviewData = join(fixtureRoot, 'webview-data');
  const temporaryDirectory = join(fixtureRoot, 'tmp');
  const appDataRoaming = join(fixtureRoot, 'appdata-roaming');
  const appDataLocal = join(fixtureRoot, 'appdata-local');
  const home = join(fixtureRoot, 'home');
  for (const path of [
    piSessions,
    primeSessions,
    piAgentDir,
    primeAgentDir,
    piProject,
    primeProject,
    tauriAppData,
    webviewData,
    temporaryDirectory,
    appDataRoaming,
    appDataLocal,
    home,
  ]) mkdirSync(path, { recursive: true });
  const fixtureRootCanonical = realpathSync(fixtureRoot);
  const primeProjectCanonical = realpathSync(primeProject);
  const tauriAppDataCanonical = realpathSync(tauriAppData);
  const webviewDataCanonical = realpathSync(webviewData);
  const temporaryDirectoryCanonical = realpathSync(temporaryDirectory);

  writeSyntheticSession(join(piSessions, 'pi-compatibility.jsonl'), {
    type: 'session', version: 3, id: 'fixture-pi-compatibility', name: 'Pi compatibility fixture', cwd: piProject,
  }, [
    { type: 'message', id: 'fixture-pi-user', message: { role: 'user', content: 'Synthetic Pi history' } },
    { type: 'fixture_future_session_entry', untrusted: 'fixture-hidden-payload' },
  ]);
  writeSyntheticSession(join(primeSessions, 'prime-one.jsonl'), {
    type: 'session', version: 3, id: 'fixture-prime-one', name: 'Prime fixture one', cwd: primeProject,
  }, [
    { type: 'message', id: 'fixture-prime-one-user', message: { role: 'user', content: 'Synthetic Prime history one' } },
  ]);
  writeSyntheticSession(join(primeSessions, 'prime-two.jsonl'), {
    type: 'session', version: 3, id: 'fixture-prime-two', name: 'Prime fixture two', cwd: primeProject,
  }, [
    { type: 'message', id: 'fixture-prime-two-user', message: { role: 'user', content: 'Synthetic Prime history two' } },
  ]);

  return {
    fixtureRoot: fixtureRootCanonical,
    piSessions,
    primeSessions,
    piAgentDir,
    primeAgentDir,
    piProject,
    primeProject,
    primeProjectCanonical,
    tauriAppData: tauriAppDataCanonical,
    webviewData: webviewDataCanonical,
    temporaryDirectory: temporaryDirectoryCanonical,
    appDataRoaming,
    appDataLocal,
    home,
    piCli: createMockPiCli(join(fixtureRoot, 'pi-package')),
    primeCli: createMockPrimeCli(join(fixtureRoot, 'prime-agent-package')),
  };
}

function exposeNativeCodeForWorkspaceFixture(fixture) {
  // Junctions expose installed CODE only. Native homes below the owned fixture
  // stay empty; no auth or user settings are inspected or copied.
  const realNpmRoot = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : undefined;
  const fixtureNpmRoot = join(fixture.appDataRoaming, 'npm', 'node_modules');
  mkdirSync(fixtureNpmRoot, { recursive: true });
  for (const [name, version] of [['prime-agent', '0.9.2'], ['@openai/codex', '0.147.0']]) {
    if (!realNpmRoot) continue;
    const candidate = join(realNpmRoot, name);
    const manifestPath = join(candidate, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== name || manifest.version !== version) continue;
    const destination = join(fixtureNpmRoot, name);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(realpathSync(candidate), destination, 'junction');
  }
  const codexHome = join(fixture.fixtureRoot, 'codex-home');
  mkdirSync(codexHome);
  return codexHome;
}

async function allocateLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Could not allocate an E2E loopback port.');
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

function resolveOwnedRunRoot() {
  const configured = process.env.PIUI_E2E_RUN_ROOT;
  if (typeof configured !== 'string' || configured.length === 0 || !isAbsolute(configured)) {
    throw new Error('PIUI_E2E_RUN_ROOT must name the controller-owned absolute run directory.');
  }
  const canonicalArea = canonicalRepositoryE2eArea();
  const expectedRoot = resolve(configured);
  const canonicalRoot = realpathSync(configured);
  if (
    dirname(expectedRoot) !== canonicalArea
    || relative(expectedRoot, canonicalRoot) !== ''
  ) {
    throw new Error('PIUI_E2E_RUN_ROOT must be an exact, non-reparse child of target/piui-e2e.');
  }
  return canonicalRoot;
}

function resolveJobRunner() {
  const configured = process.env.PIUI_E2E_JOB_RUNNER;
  if (typeof configured !== 'string' || configured.length === 0) {
    throw new Error('PIUI_E2E_JOB_RUNNER must name the feature-gated controlled job runner.');
  }
  if (!isAbsolute(configured) || !existsSync(configured)) {
    throw new Error('PIUI_E2E_JOB_RUNNER must be an existing absolute path.');
  }
  const canonicalRunner = realpathSync(configured);
  const repositoryTarget = canonicalRepositoryTarget();
  if (!isPathInside(repositoryTarget, canonicalRunner)) {
    throw new Error('PIUI_E2E_JOB_RUNNER must stay inside the canonical repository target.');
  }
  return canonicalRunner;
}

function spawnLogged(jobRunner, program, args, options, logPath) {
  let child;
  try {
    child = spawn(jobRunner, [
      '--controlled', '--cleanup-bound-ms', String(COMMAND_BOUND_MS), '--log', logPath,
      '--', program, ...args,
    ], { ...options, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (error) {
    throw new Error(`Could not start the controlled job runner: ${error.message}`, { cause: error });
  }

  let startOutcome;
  let terminationOutcome;
  let closeOutcome;
  let failureOutcome;
  let resolveStarted;
  let resolveTerminated;
  let resolveClosed;
  let resolveFailure;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const terminated = new Promise((resolve) => { resolveTerminated = resolve; });
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  // This promise resolves only for a failure, so callers can race an in-flight
  // Readiness or automation poll against an immediately observed runner failure.
  const failure = new Promise((resolve) => { resolveFailure = resolve; });
  const fail = (error) => {
    if (failureOutcome !== undefined) return;
    failureOutcome = error;
    resolveFailure(error);
  };

  let pendingControl = Buffer.alloc(0);
  const acceptControl = (record) => {
    if (record.length === 0 || record.includes(0x0D)) {
      fail(new Error('The controlled job runner emitted a non-LF control record.'));
      return;
    }
    let message;
    try {
      message = JSON.parse(record.toString('utf8'));
    } catch (error) {
      fail(new Error(`The controlled job runner emitted invalid JSON: ${error.message}`, { cause: error }));
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      fail(new Error('The controlled job runner emitted a non-object control record.'));
      return;
    }
    switch (message.type) {
      case 'started':
        if (startOutcome !== undefined || terminationOutcome !== undefined) {
          fail(new Error('The controlled job runner emitted an invalid duplicate started record.'));
          return;
        }
        startOutcome = message;
        resolveStarted(message);
        return;
      case 'terminated':
        if (startOutcome === undefined || terminationOutcome !== undefined) {
          fail(new Error('The controlled job runner emitted terminated before a single started record.'));
          return;
        }
        if (message.activeProcesses !== 0 || message.jobClosed !== true) {
          fail(new Error('The controlled job runner did not prove an empty, closed Job Object.'));
          return;
        }
        terminationOutcome = message;
        resolveTerminated(message);
        return;
      case 'spawn_error':
        fail(new Error('The controlled job runner could not start its contained target.'));
        return;
      case 'runner_error':
        fail(new Error(`The controlled job runner failed during ${message.phase ?? 'an unknown phase'}.`));
        return;
      default:
        fail(new Error('The controlled job runner emitted an unexpected control record.'));
    }
  };
  const consumeControl = (chunk) => {
    pendingControl = pendingControl.length === 0 ? Buffer.from(chunk) : Buffer.concat([pendingControl, chunk]);
    while (true) {
      const newline = pendingControl.indexOf(0x0A);
      if (newline < 0) return;
      const record = pendingControl.subarray(0, newline);
      pendingControl = pendingControl.subarray(newline + 1);
      acceptControl(record);
    }
  };

  // Register all launch listeners before returning. This synchronously owns
  // spawn and control-stream failures while startup waits are in progress.
  child.once('error', (error) => {
    fail(new Error(`The controlled job runner could not start: ${error.message}`, { cause: error }));
  });
  if (child.stdout === null) {
    fail(new Error('The controlled job runner did not expose its control stream.'));
  } else {
    child.stdout.on('data', consumeControl);
    child.stdout.once('error', (error) => {
      fail(new Error(`The controlled job runner control stream failed: ${error.message}`, { cause: error }));
    });
  }
  child.once('close', (code, signal) => {
    closeOutcome = { code, signal };
    resolveClosed(closeOutcome);
    if (pendingControl.length !== 0) {
      fail(new Error('The controlled job runner closed with an incomplete LF control record.'));
    }
    if (startOutcome === undefined) {
      fail(new Error('The controlled job runner closed before post-assign/post-resume acknowledgement.'));
    }
    if (terminationOutcome === undefined) {
      fail(new Error('The controlled job runner closed without a terminated Job Object proof.'));
    }
    if (code !== 0 || signal !== null) {
      const result = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
      fail(new Error(`The controlled job runner exited with ${result}.`));
    }
  });
  return {
    child,
    started,
    terminated,
    closed,
    failure,
    reportFailure: fail,
    get startOutcome() { return startOutcome; },
    get terminationOutcome() { return terminationOutcome; },
    get closeOutcome() { return closeOutcome; },
    get failureOutcome() { return failureOutcome; },
  };
}

function childFailureError(error, label) {
  return new Error(`${label} failed: ${error.message}`, { cause: error });
}

function childReadinessError(error, label) {
  return new Error(`${label} stopped before readiness: ${error.message}`, { cause: error });
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

function childClosedBeforeReadinessError(close, label) {
  const result = close.code === null ? `signal ${close.signal ?? 'unknown'}` : `exit code ${close.code}`;
  return new Error(`${label} stopped before readiness with ${result}.`);
}

async function raceChildFailure(
  operation,
  ownedChild,
  label,
  errorFactory = childReadinessError,
  closeIsFailure = true,
) {
  if (ownedChild === undefined) return operation();
  if (ownedChild.failureOutcome !== undefined) throw errorFactory(ownedChild.failureOutcome, label);
  if (closeIsFailure && ownedChild.closeOutcome !== undefined) {
    throw childClosedBeforeReadinessError(ownedChild.closeOutcome, label);
  }
  const contenders = [
    Promise.resolve().then(operation).then(
      (value) => ({ kind: 'operation', value }),
      (error) => ({ kind: 'operation-error', error }),
    ),
    ownedChild.failure.then((error) => ({ kind: 'child-failure', error })),
  ];
  if (closeIsFailure) {
    contenders.push(ownedChild.closed.then((close) => ({ kind: 'child-close', close })));
  }
  const winner = await Promise.race(contenders);
  if (winner.kind === 'child-failure') throw errorFactory(winner.error, label);
  if (winner.kind === 'child-close') throw childClosedBeforeReadinessError(winner.close, label);
  if (winner.kind === 'operation-error') throw winner.error;
  if (ownedChild.failureOutcome !== undefined) throw errorFactory(ownedChild.failureOutcome, label);
  if (closeIsFailure && ownedChild.closeOutcome !== undefined) {
    throw childClosedBeforeReadinessError(ownedChild.closeOutcome, label);
  }
  return winner.value;
}

async function waitForStarted(ownedChild, boundMs, label) {
  const started = await waitForBounded(
    () => raceChildFailure(() => ownedChild.started, ownedChild, label, childFailureError, false),
    boundMs,
    `${label} controlled launch`,
  );
  if (started.type !== 'started') throw new Error(`${label} did not receive a controlled start acknowledgement.`);
}

async function waitForExit(ownedChild, boundMs, label) {
  const close = await waitForBounded(
    () => raceChildFailure(() => ownedChild.closed, ownedChild, label, childFailureError, false),
    boundMs,
    label,
  );
  if (close.code !== 0 || close.signal !== null) {
    const result = close.code === null ? `signal ${close.signal ?? 'unknown'}` : `exit code ${close.code}`;
    throw new Error(`${label} failed with ${result}.`);
  }
  if (ownedChild.terminationOutcome?.activeProcesses !== 0 || ownedChild.terminationOutcome?.jobClosed !== true) {
    throw new Error(`${label} exited without a valid terminated Job Object proof.`);
  }
}

function waitFor(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitForHttp(url, boundMs, label, ownedChild) {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    const response = await raceChildFailure(async () => {
      try {
        return await fetch(url, { signal: AbortSignal.timeout(1_000) });
      } catch {
        // The bounded harness startup can race the first connection.
        return undefined;
      }
    }, ownedChild, label);
    if (response?.ok) return;
    await raceChildFailure(() => waitFor(100), ownedChild, label);
  }
  throw new Error(`${label} did not become ready.`);
}

async function waitForAutomationPage(
  automation,
  expectedPageUrl,
  boundMs,
  ownedChild,
  minimumGeneration = 0,
) {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    const page = automation.currentPage;
    if (
      automation.generation > minimumGeneration
      && page !== undefined
      && page.href.startsWith(expectedPageUrl)
    ) return page;
    await raceChildFailure(() => waitFor(100), ownedChild, 'Tauri WebView2');
  }
  throw new Error('No stable debug-only WebView automation page became ready.');
}

function compilerArtifactFromBuildLog(buildLog, cargoTargetDirectory) {
  const canonicalCargoTarget = realpathSync(cargoTargetDirectory);
  const artifacts = new Set();
  for (const line of readFileSync(buildLog, 'utf8').split(/\r?\n/)) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message === null || typeof message !== 'object') continue;
    if (
      message.reason !== 'compiler-artifact'
      || message.target?.name !== 'piui-desktop'
      || !message.target?.kind?.includes('bin')
      || typeof message.executable !== 'string'
      || message.executable.length === 0
    ) continue;
    const executable = isAbsolute(message.executable)
      ? message.executable
      : resolve(REPOSITORY_ROOT, message.executable);
    if (!existsSync(executable)) {
      throw new Error(`Cargo reported a missing piui-desktop executable: ${executable}`);
    }
    const canonicalExecutable = realpathSync(executable);
    if (!isPathInside(canonicalCargoTarget, canonicalExecutable)) {
      throw new Error('Cargo reported a piui-desktop executable outside its forced target directory.');
    }
    artifacts.add(canonicalExecutable);
  }
  if (artifacts.size !== 1) {
    throw new Error(`Cargo did not report exactly one piui-desktop executable (found ${artifacts.size}).`);
  }
  return [...artifacts][0];
}

function requestContainedTermination(ownedChild, label) {
  const input = ownedChild.child.stdin;
  if (input === null || input === undefined || input.destroyed || input.writableEnded) {
    ownedChild.reportFailure(new Error(`${label} runner stdin is unavailable for controlled cleanup.`));
    return;
  }
  const reportInputError = (error) => {
    ownedChild.reportFailure(new Error(`${label} runner stdin failed during controlled cleanup: ${error.message}`, { cause: error }));
  };
  input.once('error', reportInputError);
  try {
    input.end();
  } catch (error) {
    input.removeListener('error', reportInputError);
    ownedChild.reportFailure(new Error(`${label} runner stdin could not begin controlled cleanup: ${error.message}`, { cause: error }));
  }
}

async function awaitControlledTermination(ownedChild, boundMs, label) {
  await waitForBounded(async () => {
    const terminated = await raceChildFailure(
      () => ownedChild.terminated,
      ownedChild,
      label,
      childFailureError,
      false,
    );
    if (terminated.activeProcesses !== 0 || terminated.jobClosed !== true) {
      throw new Error(`${label} did not prove an empty, closed Job Object.`);
    }
    const close = await raceChildFailure(
      () => ownedChild.closed,
      ownedChild,
      label,
      childFailureError,
      false,
    );
    if (close.code !== 0 || close.signal !== null) {
      const result = close.code === null ? `signal ${close.signal ?? 'unknown'}` : `exit code ${close.code}`;
      throw new Error(`${label} controlled runner closed with ${result}.`);
    }
  }, boundMs, `${label} controlled cleanup`);
}

async function terminateContained(ownedChild, label) {
  if (ownedChild === undefined) return;
  const child = ownedChild.child;
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  if (ownedChild.closeOutcome !== undefined) {
    // A failed build/target can still have a proven empty, closed Job. Do not
    // re-label its nonzero exit as a second cleanup failure and hide diagnostics.
    if (ownedChild.terminationOutcome !== undefined) return;
    throw new Error(`${label} exited without proving an empty, closed Job Object.`);
  }
  if (child.pid === undefined) {
    if (ownedChild.failureOutcome !== undefined) throw childFailureError(ownedChild.failureOutcome, label);
    return;
  }

  let cleanupError;
  try {
    if (ownedChild.terminationOutcome === undefined) requestContainedTermination(ownedChild, label);
    await awaitControlledTermination(ownedChild, COMMAND_BOUND_MS, label);
    return;
  } catch (error) {
    cleanupError = error;
  }

  // The runner owns the Job Object. Never tree-kill the target; closing only
  // this wrapper's handle is the bounded fallback when its control proof fails.
  let fallbackError;
  try {
    if (!hasExited()) child.kill();
    await waitForBounded(() => ownedChild.closed, COMMAND_BOUND_MS, `${label} runner fallback`);
  } catch (error) {
    fallbackError = error;
  }
  if (fallbackError !== undefined) {
    throw new AggregateError([cleanupError, fallbackError], `${label} contained cleanup and wrapper fallback failed.`);
  }
  throw cleanupError;
}

async function runDialogProof(automation, expectedPageUrl, harness) {
  await waitForAutomationPage(
    automation,
    expectedPageUrl,
    STARTUP_BOUND_MS,
    harness?.ownedChild,
  );
  async function evaluate(expression) {
    return automation.evaluate(expression);
  }
  async function waitFor(expression) {
    const deadline = Date.now() + COMMAND_BOUND_MS;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(`Boolean(${expression})`)) return true;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Execution context was destroyed')) throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error('DOM condition timeout.');
  }
  function assert(value, message) { if (!value) throw new Error(message); }

  async function reloadPage() {
    const before = automation.generation;
    await automation.reload();
    await waitForAutomationPage(
      automation,
      expectedPageUrl,
      COMMAND_BOUND_MS,
      harness?.ownedChild,
      before,
    );
  }

  async function invokeTauri(commandName, args) {
    return evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(commandName)}, ${JSON.stringify(args)})`);
  }

  async function waitForFixtureCatalog(projectId, accepts) {
    const deadline = performance.now() + STARTUP_BOUND_MS;
    let catalog = await invokeTauri('refresh_session_catalog', { projectId });
    while (!accepts(catalog)) {
      if (performance.now() >= deadline) return catalog;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      catalog = catalog.freshness === 'refreshing'
        ? await invokeTauri('get_session_catalog', { projectId })
        : await invokeTauri('refresh_session_catalog', { projectId });
    }
    return catalog;
  }

  let fixtureProjectIds;

  async function setupFixtureProjects(fixture) {
    await waitFor(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`);
    const piProject = await invokeTauri('add_project_v10', {
      path: fixture.piProject,
      agentKind: 'pi',
    });
    const primeProject = await invokeTauri('add_project_v10', {
      path: fixture.primeProject,
      agentKind: 'prime-agent',
    });
    assert(typeof piProject?.id === 'string', 'The isolated Pi project was not registered through the typed host command.');
    assert(typeof primeProject?.id === 'string', 'The isolated Prime project was not registered through the typed host command.');
    fixtureProjectIds = { pi: piProject.id, prime: primeProject.id };
    const trustedPi = await invokeTauri('set_project_trust', {
      projectId: piProject.id,
      trustState: 'trusted',
    });
    const trustedPrime = await invokeTauri('set_project_trust', {
      projectId: primeProject.id,
      trustState: 'trusted',
    });
    assert(trustedPi?.trustState === 'trusted', 'The isolated Pi project did not become trusted.');
    assert(trustedPrime?.trustState === 'trusted', 'The isolated Prime project did not become trusted.');
    const piCatalog = await invokeTauri('refresh_session_catalog', { projectId: piProject.id });
    const primeCatalog = await invokeTauri('refresh_session_catalog', { projectId: primeProject.id });
    assert(
      piCatalog?.sessions?.some((session) => session.title === 'Pi compatibility fixture'),
      'The typed host refresh did not index the isolated Pi compatibility session.',
    );
    assert(
      primeCatalog?.sessions?.filter((session) => session.title.startsWith('Prime fixture')).length === 2,
      'The typed host refresh did not index exactly two Prime root sessions.',
    );
    await reloadPage();
    await waitFor(`document.querySelector('button[aria-label="Add a project folder"]')`);
    // Wait until App's asynchronous bootstrap project selection has performed
    // its synchronous state transition. Without this, it can close Settings
    // after the dialog proof has already clicked the Settings control.
    await waitFor(`document.querySelectorAll('button.project-row').length === 2
      && document.querySelector('.project-group.selected .project-row')`);
  }

  async function selectProjectByName(name) {
    const selected = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button.project-row')]
        .find((item) => item.textContent?.includes(${JSON.stringify(name)}));
      if (button?.getAttribute('aria-expanded') !== 'true') button?.click();
      return Boolean(button);
    })()`);
    assert(selected, `Could not select isolated project ${name}.`);
  }

  async function selectProjectSessionByName(name) {
    const selected = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.project-group.selected button.session-row')]
        .find((item) => item.textContent?.includes(${JSON.stringify(name)}));
      button?.click();
      return Boolean(button);
    })()`);
    assert(selected, `Could not select isolated session ${name}.`);
  }

  async function runFixtureRegressionProof() {
    await selectProjectByName('pi-project');
    try {
      await waitFor(`[
        ...document.querySelectorAll('.project-group.selected button.session-row'),
      ].some((item) => item.textContent?.includes('Pi compatibility fixture'))`);
    } catch (error) {
      const diagnostic = await evaluate(`(() => ({
        selectedProject: document.querySelector('.project-group.selected .project-row')?.textContent?.trim(),
        selectedSessions: [...document.querySelectorAll('.project-group.selected button.session-row')]
          .map((item) => item.textContent?.trim()),
        selectedText: document.querySelector('.project-group.selected')?.textContent?.trim(),
      }))()`);
      const hostCatalog = fixtureProjectIds === undefined
        ? undefined
        : await invokeTauri('get_session_catalog', { projectId: fixtureProjectIds.pi });
      throw new Error(`Pi fixture catalog did not become ready: ${JSON.stringify({
        ...diagnostic,
        hostFreshness: hostCatalog?.freshness,
        hostSequence: hostCatalog?.sequence,
        hostSessions: hostCatalog?.sessions?.map((session) => session.title),
      })}`, { cause: error });
    }
    const piCatalog = await evaluate(`(() => ({
      selectedProject: document.querySelector('.project-group.selected .project-row')?.textContent?.trim(),
      sessions: [...document.querySelectorAll('.project-group.selected button.session-row')]
        .map((item) => item.textContent?.trim()),
      primeActivityVisible: document.querySelector('details.prime-activity') !== null,
    }))()`);
    assert(piCatalog.selectedProject?.includes('pi-project'), 'Pi regression setup did not keep the selected project in Pi mode.');
    assert(piCatalog.sessions.includes('Pi compatibility fixture'), 'Pi regression setup did not discover the isolated Pi session.');
    assert(!piCatalog.primeActivityVisible, 'Pi mode incorrectly rendered a Prime activity disclosure.');

    await selectProjectSessionByName('Pi compatibility fixture');
    await waitFor(`document.querySelector('details.fallback-disclosure')`);
    const fallback = await evaluate(`(() => {
      const disclosure = document.querySelector('details.fallback-disclosure');
      return {
        title: disclosure?.querySelector('.activity-title')?.textContent?.trim(),
        compatibilityLabel: disclosure?.textContent?.includes('Compatibility view') ?? false,
        rawPayloadHidden: !document.body.textContent.includes('fixture-hidden-payload'),
      };
    })()`);
    assert(fallback.title === 'Unrecognized session entry', 'Pi unknown session data lost the generic fallback title.');
    assert(fallback.compatibilityLabel, 'Pi generic fallback did not identify its compatibility view.');
    assert(fallback.rawPayloadHidden, 'Pi generic fallback disclosed the synthetic unknown payload.');
    assert(await evaluate(`(() => {
      const summary = document.querySelector('details.fallback-disclosure > summary');
      summary?.click();
      return Boolean(summary);
    })()`), 'Pi generic fallback disclosure was not operable.');
    await waitFor(`document.querySelector('details.fallback-disclosure')?.open === true`);

    await selectProjectByName('prime-project');
    await waitFor(`[
      ...document.querySelectorAll('.project-group.selected button.session-row'),
    ].filter((item) => item.textContent?.includes('Prime fixture')).length === 2`);
    const primeCatalog = await evaluate(`(() => ({
      sessions: [...document.querySelectorAll('.project-group.selected button.session-row')]
        .map((item) => item.textContent?.trim()),
      projectNewSession: [...document.querySelectorAll('.project-group.selected .session-actions button')]
        .some((item) => item.getAttribute('aria-label')?.startsWith('Start a new Prime Agent session in ')),
      primaryNewChat: (() => {
        const item = document.querySelector('.side-actions .nav-button--primary');
        return item ? { disabled: item.disabled, label: item.getAttribute('aria-label') } : null;
      })(),
    }))()`);
    assert(
      primeCatalog.sessions.length === 2
      && primeCatalog.sessions.includes('Prime fixture one')
      && primeCatalog.sessions.includes('Prime fixture two'),
      'Prime read-only catalog did not show exactly the two isolated root sessions.',
    );
    assert(!primeCatalog.projectNewSession, 'Prime read-only project exposed a New session action.');
    assert(
      primeCatalog.primaryNewChat?.disabled === true
      && primeCatalog.primaryNewChat?.label === 'New session unavailable for read-only Prime Agent history',
      'The global New chat action did not fail closed for the selected Prime project.',
    );
    assert(await evaluate(`(() => {
      const button = [...document.querySelectorAll('.project-group.selected button.session-row')]
        .find((item) => item.textContent?.includes('Prime fixture one'));
      button?.click();
      return Boolean(button);
    })()`), 'The read-only Prime session row was not operable.');
    await waitFor(`document.querySelector('.history-scroll')?.textContent.includes('Synthetic Prime history one')`);
    await waitFor(`document.querySelector('.chat-notice[role="status"]')?.textContent.includes('shared daemon')`);
    const liveGate = await evaluate(`(() => ({
      notice: document.querySelector('.chat-notice[role="status"]')?.textContent?.trim(),
      sessions: [...document.querySelectorAll('.project-group.selected button.session-row')]
        .map((item) => item.textContent?.trim()),
      history: document.querySelector('.history-scroll')?.textContent,
      composer: document.querySelector('#chat-draft') !== null,
      runtimeTrigger: document.querySelector('button[aria-label="Load available models from Prime Agent"]') !== null,
      activity: document.querySelector('details.prime-activity') !== null,
    }))()`);
    assert(liveGate.notice?.includes('shared daemon') && liveGate.notice?.includes('Read-only history remains available.'), 'Prime live-runtime containment gate is not explained.');
    assert(
      liveGate.sessions.length === 2
      && liveGate.sessions.includes('Prime fixture one')
      && liveGate.sessions.includes('Prime fixture two'),
      'Prime live-runtime gate changed the isolated read-only session catalog.',
    );
    assert(liveGate.history?.includes('Synthetic Prime history one'), 'Prime read-only history did not remain readable.');
    assert(!liveGate.composer && !liveGate.runtimeTrigger && !liveGate.activity, 'Prime live-runtime gate exposed an unsafe interaction surface.');

    return [
      'isolated-pi-generic-fallback',
      'prime-project-multiple-sessions',
      'prime-read-only-history',
      'prime-live-runtime-containment-gate',
    ];
  }

  async function runSafeModeRegressionProof() {
    await selectProjectByName('prime-project');
    await waitFor(`[...document.querySelectorAll('.project-group.selected button.session-row')]
      .some((item) => item.textContent?.includes('Prime fixture one'))`);
    await selectProjectSessionByName('Prime fixture one');
    await waitFor(`document.querySelector('.safe-mode-banner') && document.querySelector('.chat-notice')`);
    const safeMode = await evaluate(`(() => ({
      banner: document.querySelector('.safe-mode-banner')?.textContent?.trim(),
      notice: document.querySelector('.chat-notice')?.textContent?.trim(),
      composer: document.querySelector('#chat-draft') !== null,
      runtimeTrigger: document.querySelector('button[aria-label="Load available models from Prime Agent"]') !== null,
      activity: document.querySelector('details.prime-activity') !== null,
    }))()`);
    assert(safeMode.banner?.includes('Safe mode.') && safeMode.banner?.includes('runtime actions are disabled'), 'Safe mode did not retain its project-wide runtime warning.');
    assert(safeMode.notice?.includes('Safe mode is on. Runtime actions are disabled.'), 'Safe mode did not replace the live runtime surface.');
    assert(!safeMode.composer && !safeMode.runtimeTrigger && !safeMode.activity, 'Safe mode exposed a live Prime runtime interaction.');
    return ['safe-mode-runtime-disabled'];
  }

  {
    await evaluate('true');
    if (harness?.setupProjects) await setupFixtureProjects(harness.fixture);
    await waitFor(`document.querySelector('button[aria-label="Add a project folder"]')`);
    assert(await evaluate(`document.querySelector('button[aria-label="Add a project folder"]').click(); true`), 'Add-project trigger did not run.');
    await waitFor(`document.querySelector('dialog.add-project-modal[open]')`);
    const opened = await evaluate(`(() => {
      const dialog = document.querySelector('dialog.add-project-modal[open]');
      const radios = [...dialog.querySelectorAll('input[name="agent-kind"]')];
      return {
        ariaModal: dialog.getAttribute('aria-modal'),
        labelledBy: dialog.getAttribute('aria-labelledby'),
        describedBy: dialog.getAttribute('aria-describedby'),
        radioValues: radios.map((radio) => radio.value),
        activeValue: document.activeElement?.value,
        description: dialog.querySelector('#add-project-description')?.textContent,
      };
    })()`);
    assert(opened.ariaModal === 'true', 'Runtime chooser is not modal.');
    assert(opened.labelledBy === 'add-project-title' && opened.describedBy === 'add-project-description', 'Runtime chooser lacks an accessible name or description.');
    assert(JSON.stringify(opened.radioValues) === JSON.stringify(['pi', 'prime-agent']), 'Runtime chooser lacks the explicit Pi/Prime Agent choices.');
    assert(opened.activeValue === 'pi', 'Initial focus did not enter the runtime chooser.');
    assert(opened.description.includes('Pi and Prime Agent sessions never mix'), 'Isolation decision is not visible to the user.');
    await automation.dispatchKey({ key: 'Tab', code: 'Tab', shiftKey: true });
    assert(await evaluate(`document.querySelector('dialog.add-project-modal').contains(document.activeElement)`), 'Shift+Tab escaped the modal.');
    assert(await evaluate(`document.activeElement?.classList.contains('primary')`), 'Backward focus wrapping did not reach the final control.');
    await automation.dispatchKey({ key: 'Tab', code: 'Tab' });
    assert(await evaluate(`document.activeElement?.value === 'pi'`), 'Forward focus wrapping did not return to the first control.');
    const primeChoice = await evaluate(`(() => {
      const radio = document.querySelector('input[value="prime-agent"]');
      radio.click();
      return { checked: radio.checked, label: radio.closest('label')?.textContent };
    })()`);
    assert(primeChoice.checked && primeChoice.label.includes('Prime Agent'), 'Prime Agent choice is not operable or labelled.');
    await automation.dispatchKey({ key: 'Escape', code: 'Escape' });
    await waitFor(`!document.querySelector('dialog.add-project-modal') && document.activeElement?.getAttribute('aria-label') === 'Add a project folder'`);
    assert(await evaluate(`document.activeElement?.getAttribute('aria-label') === 'Add a project folder'`), 'Closing the modal did not restore trigger focus.');

    assert(await evaluate(`document.querySelector('button[aria-label="Open PiUI settings"]').click(); true`), 'Settings trigger did not run.');
    await waitFor(`document.querySelector('.settings-nav')`);
    assert(await evaluate(`(() => {
      const button = [...document.querySelectorAll('.settings-nav button')].find((item) => item.textContent.includes('Extensions'));
      button?.click();
      return Boolean(button);
    })()`), 'Extensions settings did not open.');
    await waitFor(`document.querySelector('.runtime-inventory') && document.querySelector('.extension-empty') && document.querySelector('.refresh-extensions')?.textContent === 'Refresh'`);
    const piInventory = await evaluate(`(() => {
      const group = document.querySelector('.runtime-inventory');
      const buttons = [...group.querySelectorAll('button')];
      return {
        label: group.getAttribute('aria-label'),
        names: buttons.map((button) => button.textContent.trim()),
        pressed: buttons.map((button) => button.getAttribute('aria-pressed')),
        note: document.querySelector('.runtime-boundary')?.textContent,
      };
    })()`);
    assert(piInventory.label === 'Extension runtime', 'Extension runtime selector is not labelled.');
    assert(JSON.stringify(piInventory.names) === JSON.stringify(['Pi', 'Prime Agent']), 'Extension inventories do not expose both runtime choices.');
    assert(JSON.stringify(piInventory.pressed) === JSON.stringify(['true', 'false']), 'Pi inventory is not the explicit default.');
    assert(piInventory.note.includes('not enabled for Prime Agent automatically'), 'Pi inventory isolation is not explained.');

    assert(await evaluate(`(() => {
      const button = [...document.querySelectorAll('.runtime-inventory button')].find((item) => item.textContent.trim() === 'Prime Agent');
      button?.click();
      return Boolean(button);
    })()`), 'Prime Agent inventory choice did not run.');
    await waitFor(`document.querySelector('.runtime-inventory button[aria-pressed="true"]')?.textContent.trim() === 'Prime Agent' && document.querySelector('.extension-empty') && document.querySelector('.refresh-extensions')?.textContent === 'Refresh'`);
    assert(await evaluate(`document.querySelector('.runtime-boundary')?.textContent.includes('compatibility is not assumed')`), 'Prime extension compatibility boundary is not visible.');
    const checks = ['explicit-runtime-choice', 'accessible-modal', 'focus-trap', 'escape-focus-restore', 'separate-extension-inventories'];
    if (harness?.regression === 'normal') checks.push(...await runFixtureRegressionProof());
    if (harness?.regression === 'safe') checks.push(...await runSafeModeRegressionProof());
    return checks;
  }
}

function printLogTails(paths) {
  for (const path of paths) {
    try {
      const tail = readFileSync(path, 'utf8').slice(-2_000);
      if (tail.length > 0) console.error(`--- ${path} ---\n${tail}`);
    } catch {
      // The corresponding contained target may not have started.
    }
  }
}

async function runIsolatedHarness() {
  const jobRunner = resolveJobRunner();
  const devPort = await allocateLoopbackPort();
  const pageOrigin = `http://127.0.0.1:${devPort}`;
  const identifier = `dev.piui.desktop.e2e${process.pid}`;
  // Keep every fixture on the workspace volume. Rust accepts only a canonical
  // <repo>/target/piui-e2e/<run> root for the WebView automation seam.
  const fixtureRoot = resolveOwnedRunRoot();
  const viteLog = join(fixtureRoot, 'vite.log');
  const buildLog = join(fixtureRoot, 'build.log');
  const appLog = join(fixtureRoot, 'app.log');
  const safeAppLog = join(fixtureRoot, 'safe-app.log');
  let automation;
  let vite;
  let build;
  let app;
  let runFailure;
  let runFailed = false;
  let cleanupFailure;
  let passReport;
  try {
    automation = await createWebviewAutomationServer({
      allowedOrigin: pageOrigin,
      commandBoundMs: COMMAND_BOUND_MS,
    });
    const fixture = createIsolatedFixture(fixtureRoot);
    // Cargo itself writes only to the canonical workspace target. The fixture
    // remains a sibling-owned run directory below that target.
    const cargoTargetDirectory = canonicalRepositoryTarget();
    const overlay = {
      identifier,
      // This suite proves the retained v10 compatibility view. The workspace
      // suite exercises the default v11 entry separately.
      build: { devUrl: WORKSPACE_SCENARIO ? pageOrigin : `${pageOrigin}/?view=classic` },
      app: {
        windows: [{
          label: 'main', title: 'PiUI E2E', width: 1180, height: 780,
          minWidth: 720, minHeight: 540, resizable: true, devtools: false,
          // The debug-only typed builder creates this window with the
          // absolute fixture profile; config dataDirectory values are relative.
          create: false,
        }],
        // Production keeps the stricter checked-in CSP. Only this generated
        // debug overlay permits the injected loopback driver and its eval seam.
        security: {
          csp: `default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' asset:; font-src 'self'; connect-src 'self' http://127.0.0.1:${automation.port}; frame-src 'none'; frame-ancestors 'none'; form-action 'none'`,
        },
      },
    };
    // Workspace lifecycle UI tests do not inherit provider credentials or Node
    // preload hooks. The classic fixture retains its original environment.
    const inheritedEnvironment = WORKSPACE_SCENARIO
      ? Object.fromEntries(['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'ComSpec', 'COMSPEC', 'SystemDrive', 'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'ALLUSERSPROFILE']
          .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))
      : process.env;
    const runtimeEnvironment = {
      ...inheritedEnvironment,
      // Every app, session, agent, profile, and temporary root is an owned fixture path.
      // The debug automation seam accepts only canonical paths below this fixture.
      USERPROFILE: fixture.home,
      HOME: fixture.home,
      APPDATA: fixture.appDataRoaming,
      LOCALAPPDATA: fixture.appDataLocal,
      TMP: fixture.temporaryDirectory,
      TEMP: fixture.temporaryDirectory,
      TMPDIR: fixture.temporaryDirectory,
      PIUI_E2E_APP_DATA_DIR: fixture.tauriAppData,
      PIUI_E2E_WEBVIEW_DATA_DIR: fixture.webviewData,
      PIUI_E2E_FIXTURE_ROOT: fixture.fixtureRoot,
      PIUI_E2E_PRIME_PROJECT: fixture.primeProjectCanonical,
      PI_CODING_AGENT_DIR: fixture.piAgentDir,
      PI_CODING_AGENT_SESSION_DIR: fixture.piSessions,
      PRIME_AGENT_CODING_AGENT_DIR: fixture.primeAgentDir,
      PRIME_AGENT_SESSION_DIR: fixture.primeSessions,
      PRIME_AGENT_CODING_AGENT_SESSION_DIR: fixture.primeSessions,
      PIUI_PI_CLI: fixture.piCli,
      PIUI_PI_NODE: process.execPath,
      PIUI_PRIME_AGENT_CLI: fixture.primeCli,
      PIUI_PRIME_AGENT_NODE: process.execPath,
      PIUI_E2E_AUTOMATION_PAGE_ORIGIN: pageOrigin,
      PIUI_E2E_AUTOMATION_PORT: String(automation.port),
      PIUI_E2E_AUTOMATION_TOKEN: automation.token,
      TAURI_WEBVIEW_AUTOMATION: 'true',
    };
    if (WORKSPACE_SCENARIO) {
      runtimeEnvironment.CODEX_HOME = exposeNativeCodeForWorkspaceFixture(fixture);
      runtimeEnvironment.PIUI_NODE = process.execPath;
      // Native workspace tests must never run the classic synthetic CLI peers.
      delete runtimeEnvironment.PIUI_PI_CLI;
      delete runtimeEnvironment.PIUI_PRIME_AGENT_CLI;
    }
    vite = spawnLogged(
      jobRunner,
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `pnpm --filter @piui/desktop exec vite --host 127.0.0.1 --port ${devPort} --strictPort`],
      { cwd: REPOSITORY_ROOT, windowsHide: true },
      viteLog,
    );
    await waitForStarted(vite, COMMAND_BOUND_MS, 'Vite');
    await waitForHttp(`http://127.0.0.1:${devPort}`, STARTUP_BOUND_MS, 'Vite', vite);

    build = spawnLogged(
      jobRunner,
      'cargo', [
        'build', '--quiet', '--package', 'piui-desktop', '--bin', 'piui-desktop',
        '--features', 'e2e-webview-automation', '--message-format=json-render-diagnostics',
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: cargoTargetDirectory,
          TAURI_CONFIG: JSON.stringify(overlay),
        },
        windowsHide: true,
      },
      buildLog,
    );
    await waitForStarted(build, COMMAND_BOUND_MS, 'Tauri E2E build');
    await waitForExit(build, BUILD_BOUND_MS, 'Tauri E2E build');
    const executable = compilerArtifactFromBuildLog(buildLog, cargoTargetDirectory);

    app = spawnLogged(
      jobRunner,
      executable, [],
      { cwd: REPOSITORY_ROOT, windowsHide: true, env: runtimeEnvironment },
      appLog,
    );
    await waitForStarted(app, COMMAND_BOUND_MS, 'Tauri WebView2');
    await waitForAutomationPage(automation, pageOrigin, STARTUP_BOUND_MS, app);
    assertIsolatedTauriData(fixture);
    let screenshotSequence = 0;
    const ownedWindowMeasurements = [];
    async function ownedWindowOperation(args) {
      const log = join(fixtureRoot, `window-operation-${++screenshotSequence}.log`);
      const operation = spawnLogged(jobRunner, 'py', ['-3.13', join(SCRIPT_DIR, 'capture-webview.py'),
        '--parent-pid', String(app.child.pid), ...args],
      { cwd: REPOSITORY_ROOT, windowsHide: true }, log);
      try {
        await waitForStarted(operation, COMMAND_BOUND_MS, 'Owned window operation');
        await waitForExit(operation, COMMAND_BOUND_MS, 'Owned window operation');
        return JSON.parse(readFileSync(log, 'utf8').trim());
      } finally {
        await terminateContained(operation, 'Owned window operation');
      }
    }
    const workspaceCallbacks = {
      captureScreenshot: async ({ name, path }) => {
        if (!isPathInside(fixtureRoot, path)) throw new Error('Screenshot escaped owned fixture.');
        const captured = await ownedWindowOperation(['--output', path]);
        ownedWindowMeasurements.push({ name, width: captured.width, height: captured.height, memory: captured.memory });
        return path;
      },
      resizeWindow: async ({ width, height }) => {
        await ownedWindowOperation(['--resize', String(width), String(height), '--resize-only']);
      },
    };
    const normalResult = WORKSPACE_SCENARIO
      ? await runWorkspaceWebview2Proof({ automation, expectedPageUrl: pageOrigin,
          harness: { fixture, ownedChild: app, appOwnerPid: app.child.pid }, mode: 'normal',
          commandBoundMs: COMMAND_BOUND_MS, startupBoundMs: STARTUP_BOUND_MS, ...workspaceCallbacks })
      : { checks: await runDialogProof(automation, pageOrigin, {
          fixture, ownedChild: app, setupProjects: true, regression: 'normal',
        }) };
    const normalChecks = normalResult.checks;

    // A separate contained process proves that safe mode prevents the same
    // project from exposing a live runtime surface.
    await terminateContained(app, 'Tauri WebView2');
    app = undefined;
    const safeModeMinimumGeneration = automation.generation;
    app = spawnLogged(
      jobRunner,
      executable, ['--safe-mode'],
      { cwd: REPOSITORY_ROOT, windowsHide: true, env: runtimeEnvironment },
      safeAppLog,
    );
    await waitForStarted(app, COMMAND_BOUND_MS, 'safe-mode Tauri WebView2');
    await waitForAutomationPage(
      automation,
      pageOrigin,
      STARTUP_BOUND_MS,
      app,
      safeModeMinimumGeneration,
    );
    const safeResult = WORKSPACE_SCENARIO
      ? await runWorkspaceWebview2Proof({ automation, expectedPageUrl: pageOrigin,
          harness: { fixture, ownedChild: app, appOwnerPid: app.child.pid }, mode: 'safe',
          commandBoundMs: COMMAND_BOUND_MS, startupBoundMs: STARTUP_BOUND_MS, ...workspaceCallbacks })
      : { checks: await runDialogProof(automation, pageOrigin, { fixture, ownedChild: app, regression: 'safe' }) };
    const safeChecks = safeResult.checks;
    if (!WORKSPACE_SCENARIO) assertPrimeRuntimeWasNotLaunched(fixture);
    passReport = {
      status: 'pass',
      target: 'isolated Tauri WebView2 dev harness',
      scenario: WORKSPACE_SCENARIO ? 'workspace-v11' : 'classic-v10',
      native: normalResult.native,
      timings: { normal: normalResult.timings, safe: safeResult.timings },
      ownedWindowMeasurements,
      screenshots: [...(normalResult.screenshots ?? []), ...(safeResult.screenshots ?? [])],
      webviewVersion: automation.currentPage?.webviewVersion ?? 'unknown',
      checks: [
        ...normalChecks,
        ...safeChecks,
        'debug-only-loopback-webview-automation',
        ...(WORKSPACE_SCENARIO ? ['no-provider-credentials-in-fixture'] : ['prime-runtime-not-launched']),
      ],
    };
  } catch (error) {
    runFailed = true;
    runFailure = error;
  } finally {
    const cleanupResults = await Promise.allSettled([
      terminateContained(app, 'Tauri WebView2'),
      terminateContained(build, 'Tauri E2E build'),
      terminateContained(vite, 'Vite'),
    ]);
    const cleanupErrors = cleanupResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    try {
      await waitForBounded(
        () => automation?.close(),
        COMMAND_BOUND_MS,
        'WebView automation cleanup',
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (runFailed || cleanupErrors.length > 0) {
      printLogTails([viteLog, buildLog, appLog, safeAppLog]);
    }
    if (cleanupErrors.length > 0) {
      cleanupFailure = new AggregateError(cleanupErrors, 'One or more contained E2E processes failed cleanup.');
    }
  }
  if (runFailed && cleanupFailure !== undefined) {
    throw new AggregateError([runFailure, cleanupFailure], 'The E2E harness and its contained cleanup failed.');
  }
  if (runFailed) throw runFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  console.log(JSON.stringify(passReport));
}

await runIsolatedHarness();
