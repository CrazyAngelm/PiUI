import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runBridge } from "./runner.mjs";

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
