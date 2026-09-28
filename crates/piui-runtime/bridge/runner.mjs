// Common host-private native adapter bridge runner.
// Production injects exactly one factory through __PIUI_BRIDGE_FACTORY__.

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const METHODS = new Set([
  "initialize", "snapshot", "prompt", "interrupt", "models", "resources", "catalogModels",
  "setModel", "respond", "rename", "dispose", "coordinatorResponse", "boardResponse",
  "openSession", "sessionRequest", "composerCapabilities", "compact", "setMode", "composerCatalog",
]);
const MAX_DETAILS_BYTES = 4 * 1024;

const BOARD_STATUSES = new Set(["backlog", "todo", "inProgress", "inReview", "blocked", "done", "cancelled"]);
const BOARD_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);
const BOARD_LIMITS = Object.freeze({
  title: 200, query: 500, handle: 64, reason: 2000, label: 64, labels: 12,
  bodyBytes: 16 * 1024, descriptionBytes: 64 * 1024,
});

// Strict `BoardToolOperationV1` check (contracts/board-v1.ts): exact key sets,
// types, enum values and length caps. The host validates again; this keeps
// malformed agent input off the host channel.
export function validateBoardOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation) || typeof operation.op !== "string") return false;
  const utf8Bytes = (value) => Buffer.byteLength(value, "utf8");
  const text = (value, max) => typeof value === "string" && value.length <= max;
  const nonEmpty = (value, max) => text(value, max) && value.trim().length > 0;
  const card = (value) => Number.isSafeInteger(value) && value > 0;
  const description = (value) => typeof value === "string" && utf8Bytes(value) <= BOARD_LIMITS.descriptionBytes;
  const priority = (value) => BOARD_PRIORITIES.has(value);
  const labels = (value) => Array.isArray(value) && value.length <= BOARD_LIMITS.labels
    && value.every((label) => nonEmpty(label, BOARD_LIMITS.label));
  const shapes = {
    context: { optional: { query: (value) => text(value, BOARD_LIMITS.query) } },
    search: { required: { query: (value) => nonEmpty(value, BOARD_LIMITS.query) }, optional: { includeClosed: (value) => typeof value === "boolean" } },
    list: { optional: { status: (value) => BOARD_STATUSES.has(value) } },
    get: { required: { card } },
    create: {
      required: { title: (value) => nonEmpty(value, BOARD_LIMITS.title) },
      optional: { description, priority, labels, status: (value) => value === "backlog" || value === "todo", confirmNew: (value) => typeof value === "boolean" },
    },
    update: { required: { card }, optional: { title: (value) => nonEmpty(value, BOARD_LIMITS.title), description, priority, labels } },
    move: { required: { card, to: (value) => BOARD_STATUSES.has(value) }, optional: { reason: (value) => text(value, BOARD_LIMITS.reason) } },
    comment: { required: { card, body: (value) => typeof value === "string" && value.trim().length > 0 && utf8Bytes(value) <= BOARD_LIMITS.bodyBytes } },
    claim: { required: { card } },
    release: { required: { card } },
    link: { required: { card } },
    roster: {},
    assign: { required: { card, handle: (value) => nonEmpty(value, BOARD_LIMITS.handle) } },
    handoff: {
      required: { handle: (value) => nonEmpty(value, BOARD_LIMITS.handle), title: (value) => nonEmpty(value, BOARD_LIMITS.title) },
      optional: { description, priority },
    },
  };
  if (!Object.hasOwn(shapes, operation.op)) return false;
  const required = shapes[operation.op].required ?? {};
  const optional = shapes[operation.op].optional ?? {};
  for (const key of Object.keys(operation)) {
    if (key === "op") continue;
    const check = Object.hasOwn(required, key) ? required[key] : Object.hasOwn(optional, key) ? optional[key] : undefined;
    if (!check || !check(operation[key])) return false;
  }
  return Object.keys(required).every((key) => Object.hasOwn(operation, key));
}

function safeFailure(id, code, message, details) {
  return { id, ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

function writeFrame(output, value) {
  output.write(`${JSON.stringify(value)}\n`);
}

function safeAdapterError(error) {
  const code = typeof error?.bridgeCode === "string" ? error.bridgeCode : "native-operation-failed";
  const message = typeof error?.safeMessage === "string"
    ? error.safeMessage
    : "The native runtime could not complete the request.";
  // Optional adapter-built safe details (for example an ACP agent's sign-in
  // method names). Bounded plain data only; never a raw native error.
  const details = error?.safeDetails;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const text = JSON.stringify(details);
    if (text.length <= MAX_DETAILS_BYTES) return { code, message, details: JSON.parse(text) };
  }
  return { code, message };
}

export function runBridge(factory, input = process.stdin, output = process.stdout) {
  if (typeof factory !== "function") {
    throw new TypeError("A native adapter factory is required.");
  }

  let pending = Buffer.alloc(0);
  let initialized = false;
  let initializePromise;
  let adapter;
  let accepting = true;
  let disposing;
  const inFlight = new Set();
  const coordinatorPending = new Map();
  let coordinatorSequence = 0;

  const boardPending = new Map();
  let boardSequence = 0;

  const rejectPending = (pendingMap, code, message) => {
    const current = [...pendingMap.values()];
    pendingMap.clear();
    for (const slot of current) {
      const error = Object.assign(new Error(code), { bridgeCode: code, safeMessage: message });
      slot.reject(error);
    }
  };
  // Host tool calls belong to one native turn: its end, an interrupt, EOF or
  // dispose settles every waiting coordinator and board call as a failure.
  const rejectCoordinatorPending = (code = "coordinator-cancelled", message = "The coordinator request was cancelled.") => {
    rejectPending(coordinatorPending, code, message);
    rejectPending(boardPending, "board-cancelled", "The board request was cancelled.");
  };

  const validateCoordinatorOperation = (operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation) || typeof operation.type !== "string") return false;
    const keys = Object.keys(operation).sort().join(",");
    if (operation.type === "roster") return keys === "type";
    if (operation.type === "send") return keys === "body,recipientMemberId,type" && typeof operation.recipientMemberId === "string" && typeof operation.body === "string";
    if (operation.type === "observe" || operation.type === "wait") return keys === "targetMemberId,type" && typeof operation.targetMemberId === "string";
    if (operation.type === "spawnAgent") return keys === "instructions,name,profileId,type" && [operation.profileId, operation.name, operation.instructions].every(v => typeof v === "string");
    if (operation.type === "spawn") return keys === "stepId,type" && typeof operation.stepId === "string";
    return false;
  };

  const coordinatorRequest = (operation, metadata = {}) => {
    if (!initializeConfig?.coordination) return Promise.reject(Object.assign(new Error("unsupported"), { bridgeCode: "coordinator-disabled", safeMessage: "Coordinator tools are not enabled for this session." }));
    if (!validateCoordinatorOperation(operation)) return Promise.reject(Object.assign(new Error("invalid"), { bridgeCode: "invalid-coordinator-operation", safeMessage: "The coordinator operation is invalid." }));
    const requestId = `piui-coordinator-${++coordinatorSequence}`;
    return new Promise((resolve, reject) => {
      const slot = { resolve, reject, toolCallId: metadata?.toolCallId };
      coordinatorPending.set(requestId, slot);
      if (metadata?.signal && typeof metadata.signal.addEventListener === "function") {
        metadata.signal.addEventListener("abort", () => {
          if (coordinatorPending.delete(requestId)) reject(Object.assign(new Error("cancelled"), { bridgeCode: "coordinator-cancelled", safeMessage: "The coordinator request was cancelled." }));
        }, { once: true });
      }
      emit({ type: "coordinatorRequest", requestId, operation });
    });
  };

  // Board host tool (`hostTools: ["board"]`), independent of coordination.
  const boardRequest = (operation, metadata = {}) => {
    const enabled = Array.isArray(initializeConfig?.hostTools) && initializeConfig.hostTools.includes("board");
    if (!enabled) return Promise.reject(Object.assign(new Error("unsupported"), { bridgeCode: "board-disabled", safeMessage: "Board tools are not enabled for this chat." }));
    if (!validateBoardOperation(operation)) return Promise.reject(Object.assign(new Error("invalid"), { bridgeCode: "invalid-board-operation", safeMessage: "The board operation is invalid. Check `op` and its fields." }));
    const requestId = `piui-board-${++boardSequence}`;
    return new Promise((resolve, reject) => {
      boardPending.set(requestId, { resolve, reject });
      if (metadata?.signal && typeof metadata.signal.addEventListener === "function") {
        metadata.signal.addEventListener("abort", () => {
          if (boardPending.delete(requestId)) reject(Object.assign(new Error("cancelled"), { bridgeCode: "board-cancelled", safeMessage: "The board request was cancelled." }));
        }, { once: true });
      }
      emit({ type: "boardRequest", requestId, operation });
    });
  };

  let initializeConfig;

  const emit = (event) => {
    if (event && typeof event === "object") {
      if (event.type === 'pooledEvent') { writeFrame(output, {sessionId:event.sessionId,event:event.event}); return; }
      if (event.type === "turnCompleted") rejectCoordinatorPending();
      writeFrame(output, { event });
    }
  };

  const disposeAdapter = async () => {
    if (!disposing) {
      disposing = (async () => {
        accepting = false;
        rejectCoordinatorPending();
        const current = adapter ?? (initializePromise ? await initializePromise.catch(() => undefined) : undefined);
        if (current && typeof current.dispose === "function") {
          await Promise.resolve(current.dispose()).catch(() => undefined);
        }
      })();
    }
    return disposing;
  };

  const dispatch = async (request) => {
    const id = typeof request?.id === "string" ? request.id : "";
    if (!id || !request || typeof request !== "object" || Array.isArray(request)) {
      writeFrame(output, safeFailure(id, "invalid-request", "The native bridge request is invalid."));
      return;
    }
    if (typeof request.method !== "string" || !METHODS.has(request.method)) {
      writeFrame(output, safeFailure(id, "unsupported-method", "The native bridge method is not supported."));
      return;
    }
    const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
      ? request.params
      : {};

    if (request.method === "initialize") {
      if (initialized) {
        writeFrame(output, safeFailure(id, "already-initialized", "The native bridge is already initialized."));
        return;
      }
      initialized = true;
      initializeConfig = params;
      initializePromise = Promise.resolve().then(() => factory(params, emit, coordinatorRequest, boardRequest));
      try {
        adapter = await initializePromise;
        if (!adapter || typeof adapter !== "object") throw new TypeError("invalid adapter");
        writeFrame(output, { id, ok: true, result: { initialized: true } });
      } catch (error) {
        const failure = safeAdapterError(error);
        writeFrame(output, safeFailure(id, failure.code, failure.message, failure.details));
        accepting = false;
      }
      return;
    }

    if (!initialized) {
      writeFrame(output, safeFailure(id, "not-initialized", "The native bridge is not initialized."));
      return;
    }

    if (request.method === "coordinatorResponse") {
      const requestId = typeof params.requestId === "string" ? params.requestId : "";
      const response = params.response;
      const slot = coordinatorPending.get(requestId);
      if (!slot) {
        writeFrame(output, safeFailure(id, "stale-coordinator-request", "The coordinator request is invalid or no longer pending."));
        return;
      }
      const parameterKeys = Object.keys(params).sort().join(",");
      const responseKeys = response && typeof response === "object" ? Object.keys(response).sort().join(",") : "";
      const success = response?.ok === true && responseKeys === "ok,result";
      const failure = response?.ok === false && responseKeys === "error,ok"
        && response.error && typeof response.error === "object"
        && Object.keys(response.error).sort().join(",") === "code,message"
        && typeof response.error.code === "string" && typeof response.error.message === "string";
      if (parameterKeys !== "requestId,response" || (!success && !failure)) {
        writeFrame(output, safeFailure(id, "invalid-coordinator-response", "The coordinator response is invalid."));
        return;
      }
      coordinatorPending.delete(requestId);
      if (success) slot.resolve(response.result);
      else slot.reject(Object.assign(new Error(response.error.code), { bridgeCode: response.error.code, safeMessage: response.error.message }));
      writeFrame(output, { id, ok: true, result: null });
      return;
    }

    if (request.method === "boardResponse") {
      const requestId = typeof params.requestId === "string" ? params.requestId : "";
      const slot = boardPending.get(requestId);
      if (!slot) {
        writeFrame(output, safeFailure(id, "stale-board-request", "The board request is invalid or no longer pending."));
        return;
      }
      const result = params.result;
      const parameterKeys = Object.keys(params).sort().join(",");
      if (parameterKeys !== "requestId,result" || !result || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean") {
        writeFrame(output, safeFailure(id, "invalid-board-response", "The board response is invalid."));
        return;
      }
      boardPending.delete(requestId);
      // A board refusal (`ok:false`) is still a result the agent reads.
      slot.resolve(result);
      writeFrame(output, { id, ok: true, result: null });
      return;
    }

    let current;
    try {
      current = adapter ?? await initializePromise;
      if (!accepting && request.method !== "dispose") {
        writeFrame(output, safeFailure(id, "not-running", "The native runtime is not running."));
        return;
      }
      const operation = current?.[request.method];
      if (typeof operation !== "function") {
        writeFrame(output, safeFailure(id, "unsupported-method", "The native runtime does not support this method."));
        return;
      }
      // Each request runs independently. A long native turn must therefore not
      // serialize interrupt or approval responses behind another operation.
      let result;
      if (request.method === "dispose") result = await disposeAdapter();
      else if (request.method === "interrupt") {
        try { result = await operation.call(current, params); }
        finally { rejectCoordinatorPending(); }
      } else result = await operation.call(current, params);
      writeFrame(output, { id, ok: true, result: result ?? null });
    } catch (error) {
      const failure = safeAdapterError(error);
      writeFrame(output, safeFailure(id, failure.code, failure.message, failure.details));
    }
  };

  const failTransport = () => {
    if (!accepting) return;
    accepting = false;
    emit({ type: "error", message: "The native bridge received a malformed request." });
    void disposeAdapter();
  };

  const acceptFrame = (frame) => {
    if (!accepting) return;
    if (frame.length > 0 && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, -1);
    if (frame.length === 0) return;
    let request;
    try {
      request = JSON.parse(frame.toString("utf8"));
    } catch {
      failTransport();
      return;
    }
    const task = dispatch(request).finally(() => inFlight.delete(task));
    inFlight.add(task);
  };

  input.on("data", (chunk) => {
    if (!accepting) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (pending.length + bytes.length > MAX_FRAME_BYTES && !bytes.includes(0x0a)) {
      failTransport();
      return;
    }
    pending = Buffer.concat([pending, bytes]);
    let delimiter;
    while (accepting && (delimiter = pending.indexOf(0x0a)) !== -1) {
      const frame = pending.subarray(0, delimiter);
      pending = pending.subarray(delimiter + 1);
      if (frame.length > MAX_FRAME_BYTES) {
        failTransport();
        return;
      }
      acceptFrame(frame);
    }
    if (pending.length > MAX_FRAME_BYTES) failTransport();
  });

  input.on("end", () => {
    rejectCoordinatorPending();
    if (pending.length !== 0) failTransport();
    void Promise.allSettled([...inFlight]).then(disposeAdapter);
  });
  input.on("error", failTransport);

  return { dispose: disposeAdapter };
}

if (typeof globalThis.__PIUI_BRIDGE_FACTORY__ === "function") {
  runBridge(globalThis.__PIUI_BRIDGE_FACTORY__);
}
