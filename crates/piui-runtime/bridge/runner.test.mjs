import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runBridge, validateBoardOperation } from "./runner.mjs";

function harness(factory) {
  const input = new PassThrough();
  const output = new PassThrough();
  let bytes = "";
  const frames = [];
  const waiters = [];
  output.on("data", (chunk) => {
    bytes += chunk.toString("utf8");
    let index;
    while ((index = bytes.indexOf("\n")) !== -1) {
      const line = bytes.slice(0, index);
      bytes = bytes.slice(index + 1);
      if (line) frames.push(JSON.parse(line));
      while (waiters.length && frames.length >= waiters[0].count) waiters.shift().resolve();
    }
  });
  runBridge(factory, input, output);
  return {
    input,
    frames,
    async wait(count) {
      if (frames.length >= count) return;
      await new Promise((resolve) => waiters.push({ count, resolve }));
    },
    send(value) { input.write(`${JSON.stringify(value)}\n`); },
  };
}

const config = { id: "init", method: "initialize", params: { harness: "pi", cwd: "C:/trusted" } };

test("initializes once and rejects a duplicate", async () => {
  let created = 0;
  const bridge = harness(async () => { created += 1; return { dispose() {} }; });
  bridge.send(config);
  await bridge.wait(1);
  bridge.send({ ...config, id: "again" });
  await bridge.wait(2);
  assert.equal(created, 1);
  assert.deepEqual(bridge.frames.map((frame) => frame.ok), [true, false]);
  assert.equal(bridge.frames[1].error.code, "already-initialized");
  bridge.input.end();
});

test("dispatches parallel requests without blocking interrupt", async () => {
  let release;
  const promptFinished = new Promise((resolve) => { release = resolve; });
  const bridge = harness(async () => ({
    async prompt() { await promptFinished; return { accepted: true }; },
    interrupt() { release(); return { interrupted: true }; },
    dispose() {},
  }));
  bridge.send(config);
  await bridge.wait(1);
  bridge.send({ id: "prompt", method: "prompt", params: { text: "secret", mode: "prompt" } });
  bridge.send({ id: "interrupt", method: "interrupt", params: {} });
  await bridge.wait(3);
  assert.equal(bridge.frames[1].id, "interrupt");
  assert.equal(bridge.frames[2].id, "prompt");
  bridge.input.end();
});

test("uses LF only and accepts a fragmented frame", async () => {
  const bridge = harness(async () => ({ snapshot: () => ({ status: "idle" }), dispose() {} }));
  const frame = `${JSON.stringify(config)}\n`;
  bridge.input.write(frame.slice(0, 7));
  bridge.input.write(frame.slice(7));
  await bridge.wait(1);
  bridge.input.write('{"id":"bad","method":"snapshot","params":{}}\u2028{"id":"second"}\n');
  await bridge.wait(2);
  assert.equal(bridge.frames[1].event.type, "error");
  assert.equal(bridge.frames[1].event.message, "The native bridge received a malformed request.");
  bridge.input.end();
});

test("EOF disposes once and incomplete EOF fails closed", async () => {
  let disposed = 0;
  const bridge = harness(async () => ({ dispose() { disposed += 1; } }));
  bridge.send(config);
  await bridge.wait(1);
  bridge.input.write('{"id":"partial"');
  bridge.input.end();
  await bridge.wait(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, 1);
  assert.equal(bridge.frames[1].event.type, "error");
});

test("adapter owns approval freshness and raw errors stay hidden", async () => {
  const approvals = new Set(["live"]);
  const bridge = harness(async () => ({
    respond({ requestId }) {
      if (!approvals.delete(requestId)) {
        const error = new Error("raw-native-request-secret");
        error.bridgeCode = "stale-approval";
        error.safeMessage = "The approval request is no longer pending.";
        throw error;
      }
    },
    dispose() {},
  }));
  bridge.send(config);
  await bridge.wait(1);
  bridge.send({ id: "first", method: "respond", params: { requestId: "live", decision: "deny" } });
  bridge.send({ id: "stale", method: "respond", params: { requestId: "live", decision: "deny" } });
  await bridge.wait(3);
  const stale = bridge.frames.find((frame) => frame.id === "stale");
  assert.equal(stale.error.code, "stale-approval");
  assert.doesNotMatch(JSON.stringify(stale), /raw-native-request-secret/);
  bridge.input.end();
});

test("coordinator requests are origin-bound, nonblocking, and single-use", async () => {
  let coordinated;
  const bridge = harness(async (_config, emit, coordinatorRequest) => ({
    prompt() {
      void coordinatorRequest({ type: "send", recipientMemberId: "member-b", body: "hello" }, { toolCallId: "native-secret" })
        .then((value) => { coordinated = value; emit({ type: "status", status: "idle" }); });
      return { accepted: true };
    },
    interrupt() {},
    dispose() {},
  }));
  bridge.send({ ...config, params: { ...config.params, coordination: true } });
  await bridge.wait(1);
  bridge.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
  await bridge.wait(3);
  const request = bridge.frames.find((frame) => frame.event?.type === "coordinatorRequest");
  assert.ok(request);
  assert.doesNotMatch(JSON.stringify(request), /native-secret/);
  const response = { requestId: request.event.requestId, response: { ok: true, result: { delivered: true } } };
  bridge.send({ id: "coordinate", method: "coordinatorResponse", params: response });
  await bridge.wait(5);
  assert.deepEqual(coordinated, { delivered: true });
  bridge.send({ id: "duplicate", method: "coordinatorResponse", params: response });
  await bridge.wait(6);
  assert.equal(bridge.frames.find((frame) => frame.id === "duplicate").error.code, "stale-coordinator-request");
  bridge.input.end();
});

test("interrupt settles a waiting coordinator tool", async () => {
  let rejected;
  const bridge = harness(async (_config, _emit, coordinatorRequest) => ({
    prompt() {
      void coordinatorRequest({ type: "roster" }, { toolCallId: "tool" }).catch((error) => { rejected = error.bridgeCode; });
      return { accepted: true };
    },
    interrupt() {},
    dispose() {},
  }));
  bridge.send({ ...config, params: { ...config.params, coordination: true } });
  await bridge.wait(1);
  bridge.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
  await bridge.wait(3);
  bridge.send({ id: "interrupt", method: "interrupt", params: {} });
  await bridge.wait(4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected, "coordinator-cancelled");
  bridge.input.end();
});

test("failure frames carry only bounded adapter-built safe details", async () => {
  const signIn = Object.assign(new Error("raw native text"), {
    bridgeCode: "acp-sign-in-required",
    safeMessage: "Sign in first.",
    safeDetails: { authMethods: ["Agent login"] },
  });
  const bridge = harness(async () => { throw signIn; });
  bridge.send(config);
  await bridge.wait(1);
  assert.deepEqual(bridge.frames[0].error, { code: "acp-sign-in-required", message: "Sign in first.", details: { authMethods: ["Agent login"] } });
  bridge.input.end();

  const oversized = Object.assign(new Error("x"), { bridgeCode: "failed", safeMessage: "Failed.", safeDetails: { text: "x".repeat(5000) } });
  const other = harness(async () => ({
    async setMode() { throw oversized; },
    async snapshot() { throw Object.assign(new Error("secret"), { safeDetails: ["not", "an", "object"] }); },
    dispose() {},
  }));
  other.send(config);
  await other.wait(1);
  other.send({ id: "mode", method: "setMode", params: { modeId: "plan" } });
  other.send({ id: "snapshot", method: "snapshot", params: {} });
  await other.wait(3);
  assert.deepEqual(other.frames.find((frame) => frame.id === "mode").error, { code: "failed", message: "Failed." });
  assert.deepEqual(Object.keys(other.frames.find((frame) => frame.id === "snapshot").error).sort(), ["code", "message"]);
  other.input.end();
});

test("board operations need exact keys, types, enum values and bounded text", () => {
  const valid = [
    { op: "context" },
    { op: "context", query: "login" },
    { op: "search", query: "login", includeClosed: false },
    { op: "list" },
    { op: "list", status: "inReview" },
    { op: "get", card: 42 },
    { op: "create", title: "Fix login", description: "d", priority: "high", labels: ["auth"], status: "backlog", confirmNew: true },
    { op: "update", card: 1, title: "t", labels: [] },
    { op: "move", card: 1, to: "done", reason: "Shipped" },
    { op: "comment", card: 1, body: "x".repeat(16 * 1024) },
    { op: "claim", card: 1 },
    { op: "release", card: 1 },
    { op: "link", card: 1 },
    { op: "roster" },
    { op: "assign", card: 1, handle: "reviewer" },
    { op: "handoff", handle: "reviewer", title: "Review", description: "d", priority: "low" },
  ];
  for (const operation of valid) assert.equal(validateBoardOperation(operation), true, JSON.stringify(operation));
  const invalid = [
    null, [], "context", {}, { type: "roster" },
    // Unknown keys, including scope the host derives itself.
    { op: "roster", extra: 1 },
    { op: "get", card: 1, workspaceId: "w" },
    { op: "context", actor: "me" },
    // Unknown op and enum values.
    { op: "delete", card: 1 },
    { op: "list", status: "open" },
    { op: "create", title: "t", status: "inProgress" },
    { op: "update", card: 1, priority: "p0" },
    { op: "move", card: 1, to: "archived" },
    // Types and required fields.
    { op: "get" },
    { op: "get", card: "1" },
    { op: "get", card: 0 },
    { op: "get", card: 1.5 },
    { op: "search" },
    { op: "search", query: "   " },
    { op: "create", title: "" },
    { op: "create", title: "t", labels: "auth" },
    { op: "create", title: "t", labels: Array.from({ length: 13 }, (_, index) => `l${index}`) },
    { op: "create", title: "t", confirmNew: "yes" },
    { op: "assign", card: 1 },
    { op: "handoff", title: "t" },
    // Length caps.
    { op: "create", title: "x".repeat(201) },
    { op: "create", title: "t", description: "x".repeat(64 * 1024 + 1) },
    { op: "comment", card: 1, body: "x".repeat(16 * 1024 + 1) },
    { op: "comment", card: 1, body: "é".repeat(8 * 1024 + 1) },
    { op: "search", query: "x".repeat(501) },
    { op: "context", query: "x".repeat(501) },
  ];
  for (const operation of invalid) assert.equal(validateBoardOperation(operation), false, JSON.stringify(operation)?.slice(0, 80));
});

test("board requests are separate from coordination, validated and single-use", async () => {
  let answered;
  let refused;
  let disabled;
  const bridge = harness(async (_config, emit, _coordinatorRequest, boardRequest) => ({
    prompt() {
      void boardRequest({ op: "roster", extra: true }).catch((error) => { refused = error.bridgeCode; });
      void boardRequest({ op: "get", card: 7 }, { toolCallId: "native-secret" })
        .then((value) => { answered = value; emit({ type: "status", status: "idle" }); });
      return { accepted: true };
    },
    dispose() {},
  }));
  bridge.send({ ...config, params: { ...config.params, hostTools: ["board"] } });
  await bridge.wait(1);
  bridge.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
  await bridge.wait(3);
  const request = bridge.frames.find((frame) => frame.event?.type === "boardRequest");
  assert.deepEqual(request.event.operation, { op: "get", card: 7 });
  assert.doesNotMatch(JSON.stringify(request), /native-secret/);
  assert.equal(bridge.frames.filter((frame) => frame.event?.type === "boardRequest").length, 1, "invalid operations never reach the host");
  assert.equal(refused, "invalid-board-operation");
  bridge.send({ id: "bad", method: "boardResponse", params: { requestId: request.event.requestId, result: { card: 7 } } });
  await bridge.wait(4);
  assert.equal(bridge.frames.find((frame) => frame.id === "bad").error.code, "invalid-board-response");
  const result = { ok: false, code: "FORBIDDEN", message: "Not allowed." };
  bridge.send({ id: "answer", method: "boardResponse", params: { requestId: request.event.requestId, result } });
  await bridge.wait(6);
  assert.deepEqual(answered, result, "a board refusal is still the agent's result");
  bridge.send({ id: "duplicate", method: "boardResponse", params: { requestId: request.event.requestId, result } });
  await bridge.wait(7);
  assert.equal(bridge.frames.find((frame) => frame.id === "duplicate").error.code, "stale-board-request");
  bridge.send({ id: "coordinator", method: "coordinatorResponse", params: { requestId: request.event.requestId, response: { ok: true, result: null } } });
  await bridge.wait(8);
  assert.equal(bridge.frames.find((frame) => frame.id === "coordinator").error.code, "stale-coordinator-request");
  bridge.input.end();

  const off = harness(async (_config, _emit, _coordinatorRequest, boardRequest) => ({
    prompt() { void boardRequest({ op: "roster" }).catch((error) => { disabled = error.bridgeCode; }); return { accepted: true }; },
    dispose() {},
  }));
  off.send({ ...config, params: { ...config.params, coordination: true } });
  await off.wait(1);
  off.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
  await off.wait(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disabled, "board-disabled", "coordination does not enable the board");
  off.input.end();
});

test("interrupt settles a waiting board tool", async () => {
  let rejected;
  const bridge = harness(async (_config, _emit, _coordinatorRequest, boardRequest) => ({
    prompt() {
      void boardRequest({ op: "context" }, { toolCallId: "tool" }).catch((error) => { rejected = error.bridgeCode; });
      return { accepted: true };
    },
    interrupt() {},
    dispose() {},
  }));
  bridge.send({ ...config, params: { ...config.params, hostTools: ["board"] } });
  await bridge.wait(1);
  bridge.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
  await bridge.wait(3);
  bridge.send({ id: "interrupt", method: "interrupt", params: {} });
  await bridge.wait(4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected, "board-cancelled");
  bridge.input.end();
});
