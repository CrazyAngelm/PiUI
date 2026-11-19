import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPiAdapter } from "./pi.mjs";

// Native Pi branches (ADR-079): Pi copies its own session and the adapter only
// reads the source. These tests drive the fake Pi RPC fixture and read back the
// arguments the adapter launched it with.
const fixture = fileURLToPath(new URL("./fixtures/pi-rpc-fixture.mjs", import.meta.url));
const piEntryId = (entryId) => `pi-entry-${createHash("sha256").update(entryId).digest("hex").slice(0, 24)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TWO_TURNS = ["--history-two-turns"];

async function launcher() {
  const directory = await mkdtemp(join(tmpdir(), "piui-pi-branch-"));
  const record = join(directory, "launch.json");
  const entry = join(directory, "cli.js");
  await writeFile(entry, `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2) }));\nimport(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
  const source = join(directory, "source.jsonl");
  await writeFile(source, `${JSON.stringify({ type: "session", version: 3, id: "source-session", timestamp: "2026-11-19T10:00:00.000Z", cwd: process.cwd() })}\n`);
  return { directory, entry, record, source };
}

/** Runs `body` with an opener for one branch of a fresh fixture source; always cleans up. */
async function withBranch(fork, overrides, extraArgs, body) {
  const base = await launcher();
  const events = [];
  const open = () => createPiAdapter({
    harness: "pi", cwd: process.cwd(), sessionDir: process.cwd(), permissionMode: "native", runtimeProgram: process.execPath,
    runtimeArgs: [base.entry, ...extraArgs],
    ...(fork === null ? {} : { fork: { nativeId: "source-session", nativePath: base.source, ...fork } }),
    ...overrides,
  }, (event) => events.push(event));
  try { await body({ open, events, source: base.source, launch: async () => JSON.parse(await readFile(base.record, "utf8")) }); }
  finally { await rm(base.directory, { recursive: true, force: true }); }
}

test("a whole-chat branch uses Pi's own --fork into a new session id and keeps the name and model flags", async () => {
  const settings = { title: "Chat (branch)", model: { provider: "fixture", id: "m", name: "M" }, thinkingLevel: "medium" };
  await withBranch({}, settings, TWO_TURNS, async ({ open, events, source, launch }) => {
    const adapter = await open();
    try {
      const args = (await launch()).args.slice(TWO_TURNS.length); // the fixture's own flags come first
      assert.deepEqual(args.slice(0, 7), ["--mode", "rpc", "--approve", "--session-dir", process.cwd(), "--fork", source]);
      assert.equal(args[7], "--session-id");
      assert.match(args[8], UUID, "the child gets an id of its own, never the source's");
      assert.ok(args.includes("--name") && args.includes("Chat (branch)"));
      assert.deepEqual([args.includes("--provider"), args.includes("--model"), args.includes("--thinking")], [true, true, true]);
      for (const flag of ["--session", "--resume", "--continue", "--no-session"]) assert.ok(!args.includes(flag), `${flag} cannot accompany --fork`);
      assert.ok(!args.includes("source-session"), "the source id is never sent as a session id");
      // Pi has already copied everything: the first snapshot shows it and no RPC fork is needed.
      assert.deepEqual((await adapter.snapshot()).blocks.map((block) => [block.kind, block.text]), [["user", "first question"], ["assistant", "first answer"], ["user", "second question"], ["assistant", "second answer"]]);
      assert.ok(events.some((event) => event.type === "binding" && event.nativeId === "native-fixture"));
    } finally { await adapter.dispose(); }
  });
});

test("a branch cut before a message opens the source read-only, forks over RPC and keeps what came before", async () => {
  const settings = { title: "Chat (branch)", model: { provider: "fixture", id: "m", name: "M" }, thinkingLevel: "medium" };
  await withBranch({ beforeBlockId: piEntryId("t-user-2") }, settings, TWO_TURNS, async ({ open, events, source, launch }) => {
    const adapter = await open();
    try {
      const args = (await launch()).args.slice(TWO_TURNS.length); // the fixture's own flags come first
      assert.deepEqual(args.slice(0, 7), ["--mode", "rpc", "--approve", "--session-dir", process.cwd(), "--session", source]);
      // Anything that could write to the source waits until the copy exists.
      for (const flag of ["--fork", "--session-id", "--name", "--provider", "--model", "--thinking"]) assert.ok(!args.includes(flag), `${flag} must not reach the source`);
      const snapshot = await adapter.snapshot();
      assert.deepEqual(snapshot.blocks.map((block) => [block.kind, block.text]), [["user", "first question"], ["assistant", "first answer"]]);
      assert.equal(snapshot.nativeId, "native-branch", "the binding is the copy, not the source");
      assert.equal(snapshot.nativePath, "host/branch.jsonl");
      assert.equal(snapshot.title, "Chat (branch)", "the name is set on the copy once it exists");
      assert.ok(events.some((event) => event.type === "binding" && event.nativeId === "native-branch" && event.nativePath === "host/branch.jsonl"));
      assert.ok(!events.some((event) => event.type === "binding" && event.nativeId === "native-fixture"));
    } finally { await adapter.dispose(); }
  });
});

test("a branch cut before the first message starts with nothing inherited", async () => {
  await withBranch({ beforeBlockId: piEntryId("t-user-1") }, {}, TWO_TURNS, async ({ open }) => {
    const adapter = await open();
    try { assert.deepEqual((await adapter.snapshot()).blocks, []); }
    finally { await adapter.dispose(); }
  });
});

test("a branch refuses a cut that is gone or is not a user message, and a fork Pi declines", async () => {
  const cases = [
    [piEntryId("gone"), TWO_TURNS, "branch-point-not-found"],
    [piEntryId("t-answer-1"), TWO_TURNS, "branch-point-not-found"],
    ["not-a-pi-block", TWO_TURNS, "branch-point-not-found"],
    [piEntryId("t-user-2"), [...TWO_TURNS, "--fork-cancelled"], "branch-unsupported"],
    [piEntryId("t-user-2"), [...TWO_TURNS, "--fork-rejects"], "branch-unsupported"],
    // A source whose entries do not hold the message has nothing to cut before.
    [piEntryId("t-user-2"), [], "branch-point-not-found"],
  ];
  for (const [beforeBlockId, args, bridgeCode] of cases) {
    await withBranch({ beforeBlockId }, {}, args, async ({ open }) => {
      await assert.rejects(open(), { bridgeCode }, `${beforeBlockId} ${args.join(" ")}`);
    });
  }
});

test("a branch needs a readable source file and never leaks native error text", async () => {
  await withBranch({ nativePath: undefined }, {}, TWO_TURNS, async ({ open }) => {
    await assert.rejects(open(), { bridgeCode: "branch-unsupported" });
  });
  await withBranch({ nativePath: join(tmpdir(), "piui-no-such-pi-session.jsonl") }, {}, TWO_TURNS, async ({ open }) => {
    await assert.rejects(open(), { bridgeCode: "branch-unsupported" });
  });
  await withBranch({ beforeBlockId: piEntryId("t-user-2") }, {}, [...TWO_TURNS, "--fork-rejects"], async ({ open }) => {
    await assert.rejects(open(), (error) => error.bridgeCode === "branch-unsupported" && !JSON.stringify([error.message, error.safeMessage]).includes("SECRET-MUST-NOT-LEAK"));
  });
});

test("a malformed branch reference fails before Pi starts", async () => {
  const bad = [
    { extra: "field" },
    { nativeId: "" },
    { nativeId: 7 },
    { nativePath: "relative/source.jsonl" },
    { beforeBlockId: "" },
    { beforeBlockId: "x".repeat(257) },
    { beforeBlockId: 3 },
  ];
  for (const fork of bad) {
    await withBranch(fork, {}, TWO_TURNS, async ({ open }) => {
      await assert.rejects(open(), { bridgeCode: "invalid-session" }, JSON.stringify(fork));
    });
  }
  // A branch is a new session: it cannot also resume one, run as a catalog or coordinate.
  for (const overrides of [{ nativeId: "saved" }, { nativePath: join(tmpdir(), "saved.jsonl") }, { catalogOnly: true }, { coordination: true }]) {
    await withBranch({}, overrides, TWO_TURNS, async ({ open, launch }) => {
      await assert.rejects(open(), (error) => ["invalid-session", "unsupported-policy"].includes(error.bridgeCode), JSON.stringify(overrides));
      await assert.rejects(launch(), { code: "ENOENT" }, "no Pi process was launched");
    });
  }
});

test("the Nano lane never branches natively", async () => {
  const base = await launcher();
  try {
    await assert.rejects(createPiAdapter({
      harness: "nano", cwd: process.cwd(), sessionDir: process.cwd(), permissionMode: "read-only", runtimeProgram: process.execPath, runtimeArgs: [base.entry],
      nano: { agentDir: base.directory, guardExtension: null },
      fork: { nativeId: "source-session", nativePath: base.source },
    }, () => {}), (error) => ["branch-unsupported", "invalid-request"].includes(error.bridgeCode));
    await assert.rejects(readFile(base.record), { code: "ENOENT" }, "no Pi process was launched");
  } finally { await rm(base.directory, { recursive: true, force: true }); }
});
