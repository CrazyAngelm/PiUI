#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name?.startsWith("--") || value === undefined) fail("invalid arguments");
    result[name.slice(2)] = value;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args["package-root"] || !args.workspace || !args["daemon-socket"] || !args["kernel-python"]) fail("--package-root, --workspace, --daemon-socket, and --kernel-python are required");
if (!args["daemon-socket"].includes("piui-prime-sdk-")) fail("--daemon-socket must be an explicit PiUI-owned non-default fixture endpoint");
const packageRoot = realpathSync(resolve(args["package-root"]));
const workspace = realpathSync(resolve(args.workspace));
process.env.PRIME_AGENT_KERNEL_PYTHON = realpathSync(resolve(args["kernel-python"]));
process.env.PRIME_AGENT_INSTALL_UV = "0";
const packageJsonPath = join(packageRoot, "package.json");
if (!existsSync(packageJsonPath)) fail("package.json is unavailable");
const manifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(packageJsonPath, "utf8")));
if (manifest.name !== "prime-agent" || manifest.version !== "0.9.2") fail("expected prime-agent@0.9.2");

const sdk = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
const piAi = await import(pathToFileURL(join(packageRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href);
const cwd = join(workspace, "project");
const agentDir = join(workspace, "agent");
const sessionDir = join(workspace, "sessions");
const { mkdir, readFile, rm } = await import("node:fs/promises");
await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true }), mkdir(sessionDir, { recursive: true })]);

const authStorage = sdk.AuthStorage.inMemory({}, { usePrimeCliConfig: false });
const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
authStorage.setRuntimeApiKey("piui-synthetic", "synthetic-fixture-key");

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part) => part?.type === "text" ? part.text : "").join("\n");
}
function syntheticUsage() {
  return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function syntheticStream(model, context, options) {
  const stream = piAi.createAssistantMessageEventStream();
  queueMicrotask(() => {
    const output = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: syntheticUsage(), stopReason: "stop", timestamp: Date.now() };
    const last = context.messages.at(-1);
    const text = messageText(last);
    stream.push({ type: "start", partial: output });
    if (options?.signal?.aborted) {
      output.stopReason = "aborted";
      stream.push({ type: "error", reason: "aborted", error: output });
      stream.end();
      return;
    }
    let toolCall;
    if (last?.role !== "toolResult" && text.includes("PIUI_SYNTH_IPYTHON")) {
      toolCall = { type: "toolCall", id: `synthetic-${Date.now()}`, name: "ipython", arguments: { code: "synthetic_kernel_value = 40 + 2\nprint(synthetic_kernel_value)" } };
    } else if (last?.role !== "toolResult" && text.includes("PIUI_SYNTH_RLM")) {
      toolCall = { type: "toolCall", id: `synthetic-${Date.now()}`, name: "ipython", arguments: { code: "fixture_child = await rlm('PIUI_SYNTH_CHILD', name='fixture-child')\nprint(fixture_child.name)" } };
    }
    if (toolCall) {
      output.content.push(toolCall);
      output.stopReason = "toolUse";
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
      stream.push({ type: "done", reason: "toolUse", message: output });
    } else {
      const responseText = text.includes("PIUI_SYNTH_CHILD") ? "synthetic child completed" : "synthetic native tool completed";
      output.content.push({ type: "text", text: responseText });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: responseText, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: responseText, partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
    }
    stream.end();
  });
  return stream;
}
modelRegistry.registerProvider("piui-synthetic", {
  name: "PiUI lifecycle fixture",
  baseUrl: "http://127.0.0.1.invalid",
  apiKey: "synthetic-fixture-key",
  api: "piui-synthetic-api",
  streamSimple: syntheticStream,
  models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 }],
});
const settingsManager = sdk.SettingsManager.inMemory({
  telemetry: { enabled: false },
  compaction: { enabled: false },
  retry: { enabled: false },
});
const model = modelRegistry.find("piui-synthetic", "fixture");
if (!model) fail("the pinned package exposes no built-in model metadata");

const createRuntime = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
  const services = await sdk.createAgentSessionServices({
    cwd: runtimeCwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    telemetryDisabled: true,
    noBuiltinHerdrReporter: true,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      bundledSkillsDir: null,
      systemPrompt: "PiUI Prime lifecycle fixture. No provider call is permitted.",
    },
  });
  return {
    ...(await sdk.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      thinkingLevel: "off",
      tools: ["ipython"],
      includeGoals: true,
      prewarmIpythonKernel: false,
      telemetryDisabled: true,
      executionMode: "sdk",
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
  cwd,
  agentDir,
  sessionManager: sdk.SessionManager.create(cwd, sessionDir),
});
const connection = new sdk.InProcessAgentConnection(runtime);
await connection.bindHeadlessExtensions();

let bashRun;
let bashPidFile;
let closing = false;
const descendantFixture = join(resolve(import.meta.dirname), "descendant-fixture.mjs");

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeSessionPath(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+\.jsonl$/.test(name)) {
    throw new Error("session must be one JSONL basename");
  }
  const candidate = resolve(sessionDir, name);
  const rel = relative(sessionDir, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("session escapes isolated root");
  return candidate;
}

async function waitForPidFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error("descendant fixture did not publish PIDs");
}

async function stopActivity() {
  await connection.abort();
  await connection.abortBash();
  if (bashRun) {
    await bashRun.catch(() => undefined);
    bashRun = undefined;
  }
}

async function handle(command) {
  if (!command || typeof command !== "object" || Array.isArray(command) || typeof command.id !== "string" || typeof command.type !== "string") {
    throw new Error("command requires string id and type");
  }
  switch (command.type) {
    case "get_state": {
      const state = await connection.getState();
      return { sessionId: state.sessionId, sessionFile: state.sessionFile ? state.sessionFile.split(/[\\/]/).at(-1) : null, isStreaming: state.isStreaming };
    }
    case "flush_session": {
      runtime.session.sessionManager.flushNow();
      const file = runtime.session.sessionFile;
      if (!file) throw new Error("persistent session has no file");
      return { sessionId: runtime.session.sessionId, sessionFile: file.split(/[\\/]/).at(-1) };
    }
    case "new_session": {
      const result = await connection.newSession({ setup: async (manager) => manager.flushNow() });
      return { ...result, sessionId: runtime.session.sessionId, sessionFile: runtime.session.sessionFile?.split(/[\\/]/).at(-1) ?? null };
    }
    case "switch_session": {
      const path = safeSessionPath(command.session);
      if (!existsSync(path)) throw new Error("session does not exist in isolated root");
      const result = await connection.switchSession(path);
      return { ...result, sessionId: runtime.session.sessionId, sessionFile: runtime.session.sessionFile?.split(/[\\/]/).at(-1) ?? null };
    }
    case "run_ipython_fixture": {
      const events = [];
      const unsubscribe = connection.subscribe((event) => {
        if (event.type === "session_event" && event.event.type.startsWith("tool_execution_")) events.push(event.event.type);
      });
      try {
        await connection.promptAndWait("PIUI_SYNTH_IPYTHON");
      } finally {
        unsubscribe();
      }
      return { toolEvents: events, lastAssistantText: await connection.getLastAssistantText() };
    }
    case "run_rlm_fixture": {
      await connection.promptAndWait("PIUI_SYNTH_RLM");
      const deadline = Date.now() + 10000;
      let snapshots = [];
      while (Date.now() < deadline) {
        snapshots = await connection.getRlmChildSnapshots();
        if (snapshots.length && snapshots.every((item) => ["done", "failed", "cancelled"].includes(item.status))) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      return { children: snapshots.map((item) => ({ id: item.id, status: item.status, sessionName: item.sessionName ?? item.name ?? null, toolUseCount: item.toolUseCount ?? 0 })) };
    }
    case "get_coordination_capability": {
      const result = {};
      for (const [name, operation] of [["agentMessage", () => connection.getAgentMessageStatus()], ["heartbeat", () => connection.addCronJob("1h", "fixture")]]) {
        try { await operation(); result[name] = "available"; }
        catch (error) { result[name] = error instanceof Error ? error.message : String(error); }
      }
      return result;
    }
    case "abort": {
      await stopActivity();
      return { idle: !runtime.session.isStreaming };
    }
    case "start_descendant_fixture": {
      if (bashRun) throw new Error("fixture already running");
      bashPidFile = join(workspace, `descendants-${process.pid}.json`);
      await rm(bashPidFile, { force: true });
      const quotedNode = JSON.stringify(process.execPath);
      const quotedFixture = JSON.stringify(descendantFixture);
      const quotedPidFile = JSON.stringify(bashPidFile);
      bashRun = connection.executeBashAndWait(`${quotedNode} ${quotedFixture} --pid-file ${quotedPidFile}`)
        .finally(() => { bashRun = undefined; });
      return await waitForPidFile(bashPidFile, 5000);
    }
    case "shutdown": {
      await cleanup();
      return { closed: true };
    }
    default:
      throw new Error(`unsupported fixture command: ${command.type}`);
  }
}

let pending = Promise.resolve();
let bytes = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  bytes = Buffer.concat([bytes, chunk]);
  while (true) {
    const lf = bytes.indexOf(0x0a);
    if (lf < 0) break;
    let record = bytes.subarray(0, lf);
    bytes = bytes.subarray(lf + 1);
    if (record.at(-1) === 0x0d) record = record.subarray(0, -1);
    const text = record.toString("utf8");
    if (!text.trim()) continue;
    pending = pending.then(async () => {
      let command;
      try {
        command = JSON.parse(text);
        const data = await handle(command);
        send({ id: command.id, type: "response", success: true, data });
        if (command.type === "shutdown") process.exitCode = 0;
      } catch (error) {
        send({ id: command?.id ?? null, type: "response", success: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
});

async function cleanup() {
  if (closing) return;
  closing = true;
  await stopActivity();
  await connection.dispose();
}

process.stdin.on("end", () => {
  pending = pending.then(async () => {
    if (bytes.length && bytes.toString("utf8").trim()) process.exitCode = 2;
    await cleanup();
  }).catch((error) => {
    process.stderr.write(`cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
});
process.on("SIGTERM", () => { void cleanup().finally(() => process.exit(143)); });
process.on("SIGINT", () => { void cleanup().finally(() => process.exit(130)); });

send({ type: "ready", protocol: 1, package: "prime-agent@0.9.2", transport: "sdk-in-process-child", daemonContact: "none", daemonSocketGuard: "accepted-not-used", pid: process.pid });
