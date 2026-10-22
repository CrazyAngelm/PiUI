import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runBridge, sidekickOperationHash, validateBoardOperation, validateSidekickOperation } from "./runner.mjs";

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

test("request ids carry a per-process epoch so a restarted bridge never reuses one", async () => {
  // One bridge process of a session: its first coordinator and board calls.
  const start = async () => {
    const bridge = harness(async (_config, _emit, coordinatorRequest, boardRequest) => ({
      prompt() {
        void coordinatorRequest({ type: "send", recipientMemberId: "member-b", body: "hello" }, { toolCallId: "call-1" }).catch(() => {});
        void boardRequest({ op: "roster" }).catch(() => {});
        return { accepted: true };
      },
      dispose() {},
    }));
    bridge.send({ ...config, params: { ...config.params, coordination: true, hostTools: ["board"] } });
    await bridge.wait(1);
    bridge.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
    await bridge.wait(4);
    const id = (type) => bridge.frames.find((frame) => frame.event?.type === type).event.requestId;
    return { bridge, coordinator: id("coordinatorRequest"), board: id("boardRequest") };
  };
  const before = await start();
  before.bridge.input.end();
  const after = await start();
  for (const { coordinator, board } of [before, after]) {
    assert.match(coordinator, /^piui-coordinator-[0-9a-f]{12}-1$/);
    assert.match(board, /^piui-board-[0-9a-f]{12}-1$/);
    assert.equal(coordinator.split("-")[2], board.split("-")[2], "one epoch per bridge process");
  }
  // The host keys durable send/spawn deduplication on `{session}-{requestId}`:
  // the first call after a restart must not look like a replay of the old one.
  assert.notEqual(after.coordinator, before.coordinator);
  assert.notEqual(after.board, before.board);
  after.bridge.send({ id: "old", method: "coordinatorResponse", params: { requestId: before.coordinator, response: { ok: true, result: null } } });
  await after.bridge.wait(5);
  assert.equal(after.bridge.frames.find((frame) => frame.id === "old").error.code, "stale-coordinator-request");
  after.bridge.input.end();
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

// Polls on macrotask turns: a sidekick request is emitted after its hash
// resolves, so the frame count alone cannot say when it has arrived.
async function settled(check) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

async function exchange(bridge, id, method, params) {
  bridge.send({ id, method, params });
  await settled(() => bridge.frames.some((frame) => frame.id === id));
  return bridge.frames.find((frame) => frame.id === id);
}

const sidekickFrames = (bridge) => bridge.frames.filter((frame) => frame.event?.type === "sidekickRequest");

test("sidekick operations need exact keys, types, enum values and bounded fields", () => {
  const valid = [
    { op: "brief", title: "Fix login", goal: "Make login work", doneWhen: ["Login passes"] },
    {
      op: "brief", title: "t", goal: "g", doneWhen: ["a", "b"], context: "c", scope: ["src/a.ts"], leaveAlone: ["src/b.ts"],
      constraints: ["no deps"], verify: ["run tests"], stopIf: ["blocked"], wait: true, waitSeconds: 30,
    },
    { op: "brief", title: "x".repeat(200), goal: "g", doneWhen: ["d"], scope: [], waitSeconds: 0 },
    { op: "wait" },
    { op: "wait", roundId: "round_1-A", waitSeconds: 540 },
    { op: "wait", waitSeconds: 0 },
    { op: "status" },
    { op: "message", briefId: "brief-1", text: "Also handle logout" },
    { op: "message", briefId: "brief-1", text: "More", wait: false, waitSeconds: 5 },
    { op: "steer", roundId: "round-1", text: "Use the existing helper" },
    { op: "stop", roundId: "round-1" },
    { op: "stop", roundId: "round-1", takeOver: true },
    { op: "diff" },
    { op: "diff", paths: ["src/a.ts", "src/b.ts"], page: 2, fingerprint: "abc123DEF" },
    { op: "diff", paths: [], page: 1000 },
    { op: "report", roundId: "round-1" },
    { op: "report", roundId: "round-1", page: 3 },
    { op: "close", briefId: "brief-1", outcome: "accepted" },
    { op: "close", briefId: "brief-1", outcome: "rejected", note: "Wrong approach" },
    { op: "close", briefId: "brief-1", outcome: "superseded", note: "" },
    { op: "reset" },
    { op: "reset", reason: "Context drifted" },
  ];
  for (const operation of valid) assert.equal(validateSidekickOperation(operation), true, JSON.stringify(operation));
  const invalid = [
    null, [], "status", {}, { type: "status" }, { op: 1 },
    // Unknown op and unknown keys, including scope the host derives itself.
    { op: "spawn" },
    { op: "status", extra: 1 },
    { op: "wait", workspaceId: "w" },
    { op: "reset", actor: "lead" },
    { op: "brief", title: "t", goal: "g", doneWhen: ["d"], role: "reviewer" },
    // Briefs need a non-empty doneWhen and bounded text.
    { op: "brief", title: "t", goal: "g" },
    { op: "brief", title: "t", goal: "g", doneWhen: [] },
    { op: "brief", title: "t", goal: "g", doneWhen: [""] },
    { op: "brief", title: "t", goal: "g", doneWhen: ["   "] },
    { op: "brief", title: "t", goal: "g", doneWhen: "done" },
    { op: "brief", title: "t", goal: "g", doneWhen: Array.from({ length: 41 }, (_, index) => `d${index}`) },
    { op: "brief", title: "t", goal: "g", doneWhen: ["x".repeat(4 * 1024 + 1)] },
    { op: "brief", goal: "g", doneWhen: ["d"] },
    { op: "brief", title: "t", doneWhen: ["d"] },
    { op: "brief", title: "", goal: "g", doneWhen: ["d"] },
    { op: "brief", title: "x".repeat(201), goal: "g", doneWhen: ["d"] },
    { op: "brief", title: "t", goal: "x".repeat(32 * 1024 + 1), doneWhen: ["d"] },
    { op: "brief", title: "t", goal: "g", doneWhen: ["d"], scope: [""] },
    { op: "brief", title: "t", goal: "g", doneWhen: ["d"], wait: "yes" },
    // Wait bounds follow SIDEKICK_LIMITS.waitSeconds.
    { op: "wait", waitSeconds: -1 },
    { op: "wait", waitSeconds: 541 },
    { op: "wait", waitSeconds: 1.5 },
    { op: "wait", waitSeconds: "5" },
    { op: "brief", title: "t", goal: "g", doneWhen: ["d"], waitSeconds: 3600 },
    { op: "message", briefId: "b", text: "t", waitSeconds: -5 },
    // Ids, pages and fingerprints.
    { op: "wait", roundId: "has space" },
    { op: "wait", roundId: "" },
    { op: "wait", roundId: "x".repeat(65) },
    { op: "message", briefId: "b" },
    { op: "message", text: "t" },
    { op: "message", briefId: "b", text: "   " },
    { op: "steer", roundId: "r" },
    { op: "stop" },
    { op: "stop", roundId: "r", takeOver: "yes" },
    { op: "diff", page: 0 },
    { op: "diff", page: 1.5 },
    { op: "diff", page: 1001 },
    { op: "diff", page: "2" },
    { op: "diff", fingerprint: "has-dash" },
    { op: "diff", fingerprint: "" },
    { op: "diff", fingerprint: "a".repeat(129) },
    { op: "diff", paths: [""] },
    { op: "diff", paths: "src/a.ts" },
    { op: "diff", paths: ["x".repeat(1025)] },
    { op: "report" },
    { op: "report", roundId: "r", page: 0 },
    // Close outcome and note.
    { op: "close", briefId: "b" },
    { op: "close", briefId: "b", outcome: "done" },
    { op: "close", outcome: "accepted" },
    { op: "close", briefId: "b", outcome: "accepted", note: "x".repeat(4 * 1024 + 1) },
    { op: "close", briefId: "b", outcome: "accepted", note: 5 },
    { op: "reset", reason: "x".repeat(2001) },
  ];
  for (const operation of invalid) assert.equal(validateSidekickOperation(operation), false, JSON.stringify(operation)?.slice(0, 80));
});

test("sidekick operation hash is canonical and distinguishes operations", async () => {
  const brief = { op: "brief", title: "t", goal: "g", doneWhen: ["a", "b"], scope: ["x"] };
  const reordered = { scope: ["x"], doneWhen: ["a", "b"], goal: "g", title: "t", op: "brief" };
  const hash = await sidekickOperationHash(brief);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await sidekickOperationHash(reordered), hash, "key order does not matter");
  assert.equal(await sidekickOperationHash({ ...brief }), hash, "a repeat call hashes the same");
  const others = [
    { ...brief, title: "other" },
    { ...brief, doneWhen: ["b", "a"] },
    { ...brief, wait: true },
    { op: "status" },
    { op: "wait" },
    { op: "wait", waitSeconds: 0 },
    { op: "stop", roundId: "r1" },
    { op: "stop", roundId: "r1", takeOver: true },
  ];
  const hashes = new Set([hash]);
  for (const operation of others) hashes.add(await sidekickOperationHash(operation));
  assert.equal(hashes.size, others.length + 1, "every different operation has its own hash");
});

test("sidekick requests carry a durable identity, are validated and single-use", async () => {
  let answered;
  let refused;
  const operation = { op: "wait", roundId: "r1" };
  const bridge = harness(async (_config, emit, _coordinatorRequest, _boardRequest, sidekickRequest) => ({
    prompt() {
      void sidekickRequest({ op: "status", extra: true }).catch((error) => { refused = error; });
      void sidekickRequest(operation, { toolCallId: "call-1" })
        .then((value) => { answered = value; emit({ type: "status", status: "idle" }); });
      void sidekickRequest({ op: "status" }).catch(() => {});
      return { accepted: true };
    },
    dispose() {},
  }));
  bridge.send({ ...config, params: { ...config.params, hostTools: ["sidekick"] } });
  await bridge.wait(1);
  bridge.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
  await settled(() => sidekickFrames(bridge).length === 2);
  assert.equal(refused.bridgeCode, "invalid-sidekick-operation");
  const [first, second] = sidekickFrames(bridge).map((frame) => frame.event);
  assert.match(first.requestId, /^piui-sidekick-[0-9a-f]{12}-1$/);
  assert.deepEqual(first.operation, operation);
  const epoch = first.requestId.split("-")[2];
  assert.deepEqual(first.identity, { epoch, seq: 1, callRef: "call-1", opHash: await sidekickOperationHash(operation) });
  assert.equal(first.identity.opHash, await sidekickOperationHash({ roundId: "r1", op: "wait" }));
  assert.equal(second.requestId, `piui-sidekick-${epoch}-2`, "a refused operation does not consume a sequence number");
  assert.equal(second.identity.seq, 2);
  assert.equal(Object.hasOwn(second.identity, "callRef"), false, "no tool call id, no callRef");
  assert.equal(second.identity.opHash, await sidekickOperationHash({ op: "status" }));

  const malformed = await exchange(bridge, "bad", "sidekickResponse", { requestId: first.requestId, result: { text: "no ok flag" } });
  assert.equal(malformed.error.code, "invalid-sidekick-response");
  const extra = await exchange(bridge, "extra", "sidekickResponse", { requestId: first.requestId, result: { ok: true, text: "t" }, note: 1 });
  assert.equal(extra.error.code, "invalid-sidekick-response");
  const unknown = await exchange(bridge, "unknown", "sidekickResponse", { requestId: `piui-sidekick-${epoch}-99`, result: { ok: true, text: "t" } });
  assert.equal(unknown.error.code, "stale-sidekick-request");
  const result = { ok: false, text: "The round is not running." };
  const accepted = await exchange(bridge, "answer", "sidekickResponse", { requestId: first.requestId, result });
  assert.equal(accepted.ok, true);
  await settled(() => answered !== undefined);
  assert.deepEqual(answered, result, "a sidekick refusal is still the agent's result");
  const duplicate = await exchange(bridge, "duplicate", "sidekickResponse", { requestId: first.requestId, result });
  assert.equal(duplicate.error.code, "stale-sidekick-request");
  // Other host tool channels cannot answer a sidekick request.
  const board = await exchange(bridge, "board", "boardResponse", { requestId: second.requestId, result: { ok: true } });
  assert.equal(board.error.code, "stale-board-request");
  const coordinator = await exchange(bridge, "coordinator", "coordinatorResponse", { requestId: second.requestId, response: { ok: true, result: null } });
  assert.equal(coordinator.error.code, "stale-coordinator-request");
  bridge.input.end();
});

test("sidekick requests are refused when the tool is off or the operation is invalid", async () => {
  const outcomes = {};
  const attempt = async (name, params, operation) => {
    const bridge = harness(async (_config, _emit, _coordinatorRequest, _boardRequest, sidekickRequest) => ({
      prompt() { void sidekickRequest(operation).catch((error) => { outcomes[name] = error.bridgeCode; }); return { accepted: true }; },
      dispose() {},
    }));
    bridge.send({ ...config, params: { ...config.params, ...params } });
    await bridge.wait(1);
    await exchange(bridge, "prompt", "prompt", { text: "go", mode: "prompt" });
    await settled(() => outcomes[name] !== undefined);
    // Give a (wrongly) scheduled hash time to resolve and emit.
    await sidekickOperationHash({ op: "status" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sidekickFrames(bridge).length, 0, `${name} never reaches the host`);
    bridge.input.end();
  };
  await attempt("no host tools", {}, { op: "status" });
  await attempt("board only", { hostTools: ["board"] }, { op: "status" });
  await attempt("coordination only", { coordination: true }, { op: "status" });
  await attempt("no done criteria", { hostTools: ["sidekick"] }, { op: "brief", title: "t", goal: "g" });
  await attempt("empty done criteria", { hostTools: ["sidekick"] }, { op: "brief", title: "t", goal: "g", doneWhen: [] });
  await attempt("unknown op", { hostTools: ["sidekick"] }, { op: "spawn" });
  await attempt("unknown key", { hostTools: ["sidekick"] }, { op: "status", extra: true });
  await attempt("oversized wait", { hostTools: ["sidekick"] }, { op: "wait", waitSeconds: 541 });
  assert.deepEqual(outcomes, {
    "no host tools": "sidekick-disabled",
    "board only": "sidekick-disabled",
    "coordination only": "sidekick-disabled",
    "no done criteria": "invalid-sidekick-operation",
    "empty done criteria": "invalid-sidekick-operation",
    "unknown op": "invalid-sidekick-operation",
    "unknown key": "invalid-sidekick-operation",
    "oversized wait": "invalid-sidekick-operation",
  });
});

test("interrupt, turn end and abort settle a waiting sidekick tool", async () => {
  const rejected = {};
  let signalled;
  const bridge = harness(async (_config, emit, _coordinatorRequest, _boardRequest, sidekickRequest) => ({
    prompt({ text }) {
      if (text === "abort") {
        const controller = new AbortController();
        const call = sidekickRequest({ op: "status" }, { signal: controller.signal }).catch((error) => { signalled = error.bridgeCode; });
        controller.abort();
        return call.then(() => ({ accepted: true }));
      }
      void sidekickRequest({ op: "wait" }, { toolCallId: text }).catch((error) => { rejected[text] = error.bridgeCode; });
      if (text === "turn") emit({ type: "turnCompleted" });
      return { accepted: true };
    },
    interrupt() {},
    dispose() {},
  }));
  bridge.send({ ...config, params: { ...config.params, hostTools: ["sidekick"] } });
  await bridge.wait(1);
  await exchange(bridge, "interrupt-prompt", "prompt", { text: "interrupt", mode: "prompt" });
  await settled(() => sidekickFrames(bridge).length === 1);
  await exchange(bridge, "interrupt", "interrupt", {});
  await settled(() => rejected.interrupt !== undefined);
  assert.equal(rejected.interrupt, "sidekick-cancelled");

  await exchange(bridge, "turn-prompt", "prompt", { text: "turn", mode: "prompt" });
  await settled(() => rejected.turn !== undefined);
  assert.equal(rejected.turn, "sidekick-cancelled");

  await exchange(bridge, "abort-prompt", "prompt", { text: "abort", mode: "prompt" });
  assert.equal(signalled, "sidekick-cancelled");
  await sidekickOperationHash({ op: "status" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sidekickFrames(bridge).filter((frame) => frame.event.operation.op === "status").length, 0, "an aborted call is never sent to the host");
  bridge.input.end();
});

test("a retired sidekick request fails its late host response so the host can redeliver", async () => {
  const outcomes = {};
  const controllers = { gone: new AbortController(), early: new AbortController() };
  controllers.early.abort();
  const bridge = harness(async (_config, _emit, _coordinatorRequest, _boardRequest, sidekickRequest) => ({
    prompt() {
      void sidekickRequest({ op: "wait" }, { signal: controllers.gone.signal }).then(() => { outcomes.gone = "resolved"; }, (error) => { outcomes.gone = error.bridgeCode; });
      // The caller was already gone: nothing is sent to the host.
      void sidekickRequest({ op: "status" }, { signal: controllers.early.signal }).then(() => { outcomes.early = "resolved"; }, (error) => { outcomes.early = error.bridgeCode; });
      return { accepted: true };
    },
    dispose() {},
  }));
  bridge.send({ ...config, params: { ...config.params, hostTools: ["sidekick"] } });
  await bridge.wait(1);
  bridge.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
  await settled(() => sidekickFrames(bridge).length === 1);
  const [request] = sidekickFrames(bridge).map((frame) => frame.event);
  assert.equal(request.operation.op, "wait");
  assert.equal(outcomes.early, "sidekick-cancelled");
  // The MCP client disconnected while the host was still working.
  controllers.gone.abort();
  await settled(() => outcomes.gone !== undefined);
  assert.equal(outcomes.gone, "sidekick-cancelled");
  const late = await exchange(bridge, "late", "sidekickResponse", { requestId: request.requestId, result: { ok: true, text: "report" } });
  assert.equal(late.ok, false, "a retired request is not acknowledged");
  assert.equal(late.error.code, "stale-sidekick-request");
  await sidekickOperationHash({ op: "status" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sidekickFrames(bridge).length, 1, "the already-cancelled call never reached the host");
  bridge.input.end();
});

test("the host is acknowledged only after the adapter confirms the native sidekick write", async () => {
  let confirmWrite;
  let delivered;
  let answered;
  const bridge = harness(async (_config, _emit, _coordinatorRequest, _boardRequest, sidekickRequest) => ({
    prompt() {
      void sidekickRequest({ op: "wait" }, {
        toolCallId: "call-1",
        deliver: async (result) => {
          delivered = result;
          await new Promise((resolve) => { confirmWrite = resolve; });
        },
      }).then((value) => { answered = value; });
      return { accepted: true };
    },
    dispose() {},
  }));
  bridge.send({ ...config, params: { ...config.params, hostTools: ["sidekick"] } });
  await bridge.wait(1);
  bridge.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
  await settled(() => sidekickFrames(bridge).length === 1);
  const [request] = sidekickFrames(bridge).map((frame) => frame.event);
  const result = { ok: true, text: "report" };
  bridge.send({ id: "answer", method: "sidekickResponse", params: { requestId: request.requestId, result } });
  await settled(() => delivered !== undefined && typeof confirmWrite === "function");
  assert.deepEqual(delivered, result);
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.frames.some((frame) => frame.id === "answer"), false, "no acknowledgement while the native write is unconfirmed");
  assert.equal(answered, undefined);
  confirmWrite();
  await settled(() => bridge.frames.some((frame) => frame.id === "answer"));
  assert.deepEqual(bridge.frames.find((frame) => frame.id === "answer"), { id: "answer", ok: true, result: null });
  await settled(() => answered !== undefined);
  assert.deepEqual(answered, result);
  // The request is retired once answered.
  const duplicate = await exchange(bridge, "duplicate", "sidekickResponse", { requestId: request.requestId, result });
  assert.equal(duplicate.error.code, "stale-sidekick-request");
  bridge.input.end();
});

test("a failed native sidekick write is a distinct error the host can see, not an acknowledgement", async () => {
  let outcome;
  const bridge = harness(async (_config, _emit, _coordinatorRequest, _boardRequest, sidekickRequest) => ({
    prompt() {
      void sidekickRequest({ op: "wait" }, {
        deliver: async () => { throw new Error("EPIPE write after end SECRET-MUST-NOT-LEAK"); },
      }).then(() => { outcome = "resolved"; }, (error) => { outcome = error.bridgeCode; });
      return { accepted: true };
    },
    dispose() {},
  }));
  bridge.send({ ...config, params: { ...config.params, hostTools: ["sidekick"] } });
  await bridge.wait(1);
  bridge.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
  await settled(() => sidekickFrames(bridge).length === 1);
  const [request] = sidekickFrames(bridge).map((frame) => frame.event);
  const failed = await exchange(bridge, "answer", "sidekickResponse", { requestId: request.requestId, result: { ok: true, text: "report" } });
  assert.equal(failed.ok, false, "a failed write is never acknowledged");
  assert.equal(failed.error.code, "sidekick-delivery-failed");
  assert.notEqual(failed.error.code, "stale-sidekick-request", "a retired request keeps its own code");
  assert.doesNotMatch(JSON.stringify(failed), /SECRET-MUST-NOT-LEAK|EPIPE/);
  await settled(() => outcome !== undefined);
  assert.equal(outcome, "sidekick-delivery-failed");
  bridge.input.end();
});

test("an adapter that does not use deliver keeps the direct acknowledgement", async () => {
  let answered;
  const bridge = harness(async (_config, _emit, _coordinatorRequest, _boardRequest, sidekickRequest) => ({
    prompt() { void sidekickRequest({ op: "status" }).then((value) => { answered = value; }); return { accepted: true }; },
    dispose() {},
  }));
  bridge.send({ ...config, params: { ...config.params, hostTools: ["sidekick"] } });
  await bridge.wait(1);
  bridge.send({ id: "prompt", method: "prompt", params: { text: "go", mode: "prompt" } });
  await settled(() => sidekickFrames(bridge).length === 1);
  const [request] = sidekickFrames(bridge).map((frame) => frame.event);
  const accepted = await exchange(bridge, "answer", "sidekickResponse", { requestId: request.requestId, result: { ok: true, text: "t" } });
  assert.equal(accepted.ok, true);
  await settled(() => answered !== undefined);
  bridge.input.end();
});
