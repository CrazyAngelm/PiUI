// Ported from Nano Web wwwroot/js/hermes-intelligent-ui.js.
// Agent JSON is untrusted: text nodes and allowlisted attributes only, with
// the source interpreter and limits. No networking, navigation, or executable markup.
// Per-message scopes own state, streaming adoption, observers, and cleanup.
export const intelligentUiLanguage = "hermes-ui";
export const intelligentUiCodeSelector = `.message-markdown pre > code.language-${intelligentUiLanguage}`;
let formatLocale = "en-US";
export function setIntelligentUiLocale(locale) {
    formatLocale = locale === "ru-RU" ? "ru-RU" : "en-US";
}
const label = (host, key, args) => host?.label?.(key, args)
    ?? key.replace(/\{(\d+)\}/g, (_, i) => args?.[Number(i)] ?? "");
function renderUnsupportedNode(runtime, node) {
    const name = [node.title, node.caption, node.alt, node.file, node.src, node.type]
        .find(value => typeof value === "string" && value.trim());
    return el("p", "hui__note", label(runtime.host, "Not shown in this app: {0}", [name ?? ""]));
}
const maxSourceLength = 200000;
const maxNodes = 1500;
const maxDepth = 24;
const maxTableRows = 500;
const tableRowsStep = 25;
const staleAfterMs = 8000;
const maxStoredStates = 200;
const expressionCache = new Map();
const detachedTtlMs = 5000;
const newScope = () => ({ stateStore: new Map(), hosts: new WeakMap(), liveBlocks: new Set(), disposed: false });
const legacyScope = newScope();
export function createIntelligentUiScope() {
    const scope = newScope();
    return {
        enhance: (root, host) => enhanceIntelligentUi(root, host, scope),
        dispose() {
            scope.disposed = true;
            for (const block of scope.liveBlocks)
                removeScopedBlock(block, scope);
            scope.liveBlocks.clear();
            scope.stateStore.clear();
            scope.hosts = new WeakMap();
        }
    };
}
export function enhanceIntelligentUi(root, host, scope = legacyScope) {
    if (scope.disposed)
        return;
    const { hosts } = scope;
    for (const code of root.querySelectorAll(intelligentUiCodeSelector)) {
        if (scope === legacyScope && code.closest('.shared-conversation-mount'))
            continue;
        const pre = code.parentElement;
        const source = code.textContent ?? "";
        const current = hosts.get(pre);
        if (current && current.source === source) {
            continue;
        }
        const slot = blockSlot(pre, code);
        const previous = current ?? adoptDetached(slot, source, scope);
        hosts.set(pre, mountBlock(pre, source, host, slot, previous, scope));
    }
    if (scope === legacyScope)
        sweepDetached(scope);
    else {
        for (const mounted of scope.liveBlocks) {
            if (!root.contains(mounted.pre) || !mounted.pre.querySelector(':scope > code.language-hermes-ui'))
                removeScopedBlock(mounted, scope);
        }
    }
}
function removeScopedBlock(mounted, scope) {
    mounted.dispose();
    mounted.container.remove();
    mounted.pre.classList.remove('hui-host', 'hui-host--raw');
    delete mounted.pre.dataset.codeBlock;
    scope.hosts.delete(mounted.pre);
    scope.liveBlocks.delete(mounted);
}
function blockSlot(pre, code) {
    const owner = pre.closest(".message-markdown");
    const index = owner ? Array.prototype.indexOf.call(owner.querySelectorAll(intelligentUiCodeSelector), code) : -1;
    return { owner, index };
}
function adoptDetached(slot, source, scope) {
    const detached = Array.from(scope.liveBlocks).filter(mounted => !mounted.container.isConnected);
    return detached.find(mounted => mounted.slot.owner === slot.owner && mounted.slot.index === slot.index)
        ?? detached.find(mounted => mounted.source === source)
        ?? detached.find(mounted => mounted.slot.index === slot.index && source.startsWith(mounted.source));
}
function sweepDetached(scope) {
    const { liveBlocks } = scope;
    const now = Date.now();
    for (const mounted of liveBlocks) {
        if (mounted.container.isConnected) {
            mounted.detachedAt = null;
            continue;
        }
        mounted.detachedAt ??= now;
        if (now - mounted.detachedAt > detachedTtlMs) {
            mounted.dispose();
            liveBlocks.delete(mounted);
        }
    }
}
function mountBlock(pre, source, host, slot, previous, scope) {
    const { liveBlocks } = scope;
    pre.classList.add("hui-host");
    pre.dataset.codeBlock = "1";
    if (previous && previous.source === source) {
        attachContainer(previous, pre, slot);
        return previous;
    }
    let container = previous?.container;
    if (previous) {
        previous.dispose();
        liveBlocks.delete(previous);
        container.classList.remove("hui--raw");
    }
    else {
        container = el("div", "hui hui--enter");
        container.setAttribute("role", "group");
        container.addEventListener("animationend", (event) => {
            if (event.target === container) {
                container.classList.remove("hui--enter");
            }
        });
    }
    const mounted = { source, pre, slot, container, scope, host, raw: false, detachedAt: null, dispose: () => { } };
    liveBlocks.add(mounted);
    attachContainer(mounted, pre, slot);
    if (source.length > maxSourceLength) {
        clearContainer(container, false);
        showRaw(mounted, label(host, "The interface is too large. Showing its source."));
        return mounted;
    }
    const parsed = parseSpec(source);
    const spec = normalizeSpec(parsed.value);
    if (!spec) {
        if (parsed.closed) {
            clearContainer(container, false);
            showRaw(mounted, label(host, "The interface has an error. Showing its source."));
            return mounted;
        }
        container.classList.add("hui--streaming");
        if (!container.querySelector(":scope > .hui__skeleton")) {
            clearContainer(container, false);
            container.append(skeleton(host));
        }
        mounted.dispose = scheduleStale(mounted);
        return mounted;
    }
    const stale = Array.from(container.children).filter(child => !child.classList.contains("hui__progress"));
    const key = hashString(parsed.closed ? source : `stream:${spec.title ?? ""}`);
    const runtime = createRuntime(spec, key, host?.forSource?.(source, () => mounted.pre) ?? host, container, scope);
    renderRoot(runtime, spec, parsed.closed);
    stale.forEach(child => child.remove());
    mounted.dispose = () => runtime.dispose();
    if (!parsed.closed) {
        const cancelStale = scheduleStale(mounted);
        const disposeRuntime = mounted.dispose;
        mounted.dispose = () => {
            cancelStale();
            disposeRuntime();
        };
    }
    return mounted;
}
function attachContainer(mounted, pre, slot) {
    const { container } = mounted;
    if (container.parentElement !== pre) {
        if (container.parentElement) {
            container.classList.remove("hui--enter");
        }
        pre.append(container);
    }
    mounted.pre = pre;
    mounted.slot = slot;
    mounted.detachedAt = null;
    pre.classList.toggle("hui-host--raw", mounted.raw);
}
function clearContainer(container, keepProgress) {
    for (const child of Array.from(container.children)) {
        if (!keepProgress || !child.classList.contains("hui__progress")) {
            child.remove();
        }
    }
}
function scheduleStale(mounted) {
    const { container } = mounted;
    const timer = window.setTimeout(() => {
        if (!container.isConnected || !mounted.scope.liveBlocks.has(mounted)) {
            return;
        }
        container.classList.remove("hui--streaming");
        container.querySelector(":scope > .hui__progress")?.remove();
        if (!container.querySelector(".hui__body")) {
            container.replaceChildren();
            showRaw(mounted, label(mounted.host, "The interface is incomplete. Showing its source."));
            return;
        }
        container.append(el("p", "hui__note", label(mounted.host, "The answer was cut off. Part of the interface may be missing.")));
    }, staleAfterMs);
    return () => window.clearTimeout(timer);
}
function showRaw(mounted, message) {
    mounted.raw = true;
    mounted.pre.classList.add("hui-host--raw");
    mounted.container.classList.add("hui--raw");
    mounted.container.append(el("p", "hui__note", message));
}
function skeleton(host) {
    const box = el("div", "hui__skeleton");
    box.setAttribute("aria-label", label(host, "Building the interface"));
    for (let index = 0; index < 3; index++) {
        box.append(el("span", "hui__skeleton-line"));
    }
    return box;
}
export function parseSpec(source) {
    const text = source.trim();
    try {
        return { value: JSON.parse(text), closed: true };
    }
    catch {
    }
    try {
        return parsePartialJson(text);
    }
    catch {
        return { value: null, closed: true };
    }
}
export function parsePartialJson(text) {
    const end = Symbol("end");
    const length = text.length;
    let index = 0;
    const skipSpace = () => {
        while (index < length && /\s/.test(text[index])) {
            index++;
        }
    };
    const readString = (partialAllowed) => {
        index++;
        let out = "";
        while (index < length) {
            const char = text[index++];
            if (char === "\"") {
                return out;
            }
            if (char !== "\\") {
                out += char;
                continue;
            }
            if (index >= length) {
                break;
            }
            const escape = text[index++];
            if (escape === "u") {
                if (index + 4 > length) {
                    index = length;
                    break;
                }
                out += String.fromCharCode(parseInt(text.slice(index, index + 4), 16));
                index += 4;
                continue;
            }
            out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[escape] ?? escape;
        }
        return partialAllowed ? out : end;
    };
    const readNumber = () => {
        const match = /^-?\d*\.?\d*(?:[eE][+-]?\d*)?/.exec(text.slice(index));
        const raw = match ? match[0] : "";
        if (!raw) {
            throw new Error("number");
        }
        index += raw.length;
        const value = parseFloat(raw);
        return Number.isFinite(value) ? value : end;
    };
    const readValue = () => {
        skipSpace();
        if (index >= length) {
            return end;
        }
        const char = text[index];
        if (char === "{") {
            return readObject();
        }
        if (char === "[") {
            return readArray();
        }
        if (char === "\"") {
            return readString(true);
        }
        if (char === "-" || (char >= "0" && char <= "9")) {
            return readNumber();
        }
        for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
            if (text.startsWith(literal, index)) {
                index += literal.length;
                return value;
            }
            if (literal.startsWith(text.slice(index))) {
                index = length;
                return end;
            }
        }
        throw new Error("token");
    };
    let rootClosed = false;
    const readObject = () => {
        index++;
        const result = {};
        for (;;) {
            skipSpace();
            if (index >= length) {
                return result;
            }
            const char = text[index];
            if (char === "}") {
                index++;
                result[closedMark] = true;
                return result;
            }
            if (char === ",") {
                index++;
                continue;
            }
            if (char !== "\"") {
                throw new Error("key");
            }
            const key = readString(false);
            if (key === end) {
                return result;
            }
            skipSpace();
            if (index >= length) {
                return result;
            }
            if (text[index] !== ":") {
                throw new Error("colon");
            }
            index++;
            const value = readValue();
            if (value === end) {
                return result;
            }
            if (!unsafeKeys.has(key)) {
                result[key] = value;
            }
        }
    };
    const readArray = () => {
        index++;
        const result = [];
        for (;;) {
            skipSpace();
            if (index >= length) {
                return result;
            }
            const char = text[index];
            if (char === "]") {
                index++;
                result[closedMark] = true;
                return result;
            }
            if (char === ",") {
                index++;
                continue;
            }
            const value = readValue();
            if (value === end) {
                return result;
            }
            result.push(value);
        }
    };
    const value = readValue();
    rootClosed = value !== null && typeof value === "object" && value[closedMark] === true;
    skipSpace();
    return { value: value === end ? null : value, closed: rootClosed && index >= length };
}
const closedMark = Symbol("closed");
function normalizeSpec(value) {
    if (Array.isArray(value)) {
        return { body: value, state: {} };
    }
    if (!value || typeof value !== "object") {
        return null;
    }
    const body = Array.isArray(value.body) ? value.body
        : Array.isArray(value.children) ? value.children
            : typeof value.type === "string" ? [value]
                : null;
    if (!body) {
        return null;
    }
    return {
        title: typeof value.title === "string" ? value.title : null,
        subtitle: typeof value.subtitle === "string" ? value.subtitle : null,
        state: value.state && typeof value.state === "object" && !Array.isArray(value.state) ? value.state : {},
        computed: value.computed && typeof value.computed === "object" && !Array.isArray(value.computed) ? value.computed : {},
        body
    };
}
function createRuntime(spec, key, host, container, scope) {
    const { stateStore } = scope;
    const initial = cloneJson(spec.state);
    const stored = stateStore.get(key);
    const state = { ...initial, ...(stored ?? {}) };
    const effects = [];
    const cleanups = [];
    const dead = new WeakSet();
    let nodeCount = 0;
    let disposed = false;
    let scheduled = false;
    let owner = null;
    const computedValues = new Map();
    const runtime = {
        spec,
        key,
        host,
        container,
        state,
        initial,
        changed: stored !== undefined,
        effects,
        cleanups,
        scope(extra) {
            return createScope(state, spec.computed, extra, computedValues);
        },
        invalidate() {
            computedValues.clear();
        },
        effect(run) {
            const runOwner = owner;
            const bound = () => {
                const previous = owner;
                owner = runOwner;
                try {
                    run();
                }
                finally {
                    owner = previous;
                }
            };
            effects.push(bound);
            runOwner?.effects.push(bound);
            safeRun(bound);
        },
        own(render) {
            const parent = owner;
            const part = { effects: [], cleanups: [], nodes: 0, disposed: false };
            owner = part;
            try {
                render();
            }
            finally {
                owner = parent;
            }
            const dispose = () => {
                if (part.disposed) {
                    return;
                }
                part.disposed = true;
                const gone = new Set(part.effects.splice(0));
                gone.forEach(run => dead.add(run));
                const kept = effects.filter(run => !gone.has(run));
                effects.length = 0;
                effects.push(...kept);
                nodeCount = Math.max(0, nodeCount - part.nodes);
                part.nodes = 0;
                const holder = parent ? parent.cleanups : cleanups;
                const at = holder.indexOf(dispose);
                if (at >= 0) {
                    holder.splice(at, 1);
                }
                for (const cleanup of part.cleanups.splice(0)) {
                    try {
                        cleanup();
                    }
                    catch {
                    }
                }
            };
            (parent ? parent.cleanups : cleanups).push(dispose);
            return dispose;
        },
        set(name, value) {
            if (disposed || !isSafeName(name)) {
                return;
            }
            state[name] = value;
            computedValues.clear();
            runtime.changed = true;
            remember(key, state, scope);
            runtime.schedule();
        },
        reset() {
            for (const name of Object.keys(state)) {
                delete state[name];
            }
            Object.assign(state, cloneJson(initial));
            computedValues.clear();
            stateStore.delete(key);
            runtime.changed = false;
            runtime.flush();
        },
        schedule() {
            if (scheduled) {
                return;
            }
            scheduled = true;
            queueMicrotask(() => {
                scheduled = false;
                runtime.flush();
            });
        },
        flush() {
            if (disposed) {
                return;
            }
            for (const run of effects.slice()) {
                if (!dead.has(run)) {
                    safeRun(run);
                }
            }
        },
        resetNodeCount() {
            nodeCount = 0;
        },
        countNode() {
            nodeCount++;
            if (owner) {
                owner.nodes++;
            }
            return nodeCount <= maxNodes;
        },
        onDispose(cleanup) {
            (owner ? owner.cleanups : cleanups).push(cleanup);
        },
        dispose() {
            disposed = true;
            effects.length = 0;
            for (const cleanup of cleanups.splice(0)) {
                try {
                    cleanup();
                }
                catch {
                }
            }
        }
    };
    return runtime;
}
function safeRun(run) {
    try {
        run();
    }
    catch {
    }
}
function remember(key, state, scope) {
    const { stateStore } = scope;
    stateStore.delete(key);
    stateStore.set(key, cloneJson(state));
    while (stateStore.size > maxStoredStates) {
        stateStore.delete(stateStore.keys().next().value);
    }
}
function createScope(state, computed, extra, memo) {
    const evaluating = new Set();
    let base = null;
    const scope = {
        extra,
        get(name) {
            if (extra && Object.prototype.hasOwnProperty.call(extra, name)) {
                return extra[name];
            }
            if (Object.prototype.hasOwnProperty.call(state, name)) {
                return state[name];
            }
            if (!Object.prototype.hasOwnProperty.call(computed, name)) {
                return undefined;
            }
            if (extra) {
                base ??= createScope(state, computed, null, memo);
                return base.get(name);
            }
            if (memo?.has(name)) {
                return memo.get(name);
            }
            if (evaluating.has(name)) {
                return undefined;
            }
            evaluating.add(name);
            try {
                const value = resolveValue(computed[name], scope);
                memo?.set(name, value);
                return value;
            }
            finally {
                evaluating.delete(name);
            }
        }
    };
    return scope;
}
const maxTextLength = 20000;
function limitText(text) {
    return text.length > maxTextLength ? text.slice(0, maxTextLength) : text;
}
function isSafeName(name) {
    return typeof name === "string" && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)
        && name !== "__proto__" && name !== "constructor" && name !== "prototype";
}
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const aliasPaths = Symbol("aliases");
const maxIndex = 100000;
function parsePath(text) {
    if (typeof text !== "string" || text.length > 200) {
        return null;
    }
    const match = /^([\p{L}_$][\p{L}\p{N}_$]*)((?:\.[\p{L}_$][\p{L}\p{N}_$]*|\[\d{1,6}\])*)$/u.exec(text.trim());
    if (!match) {
        return null;
    }
    const path = [match[1]];
    for (const part of match[2].matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)) {
        path.push(part[1] !== undefined ? part[1] : Number(part[2]));
    }
    return path.every(segment => typeof segment === "number" ? segment <= maxIndex : !unsafeKeys.has(segment)) ? path : null;
}
function readPath(state, path) {
    let value = state;
    for (const segment of path) {
        value = member(value, segment);
        if (value === undefined) {
            return undefined;
        }
    }
    return value;
}
function sameValue(left, right) {
    if (Object.is(left, right)) {
        return true;
    }
    if (left && right && typeof left === "object" && typeof right === "object") {
        try {
            return JSON.stringify(left) === JSON.stringify(right);
        }
        catch {
            return false;
        }
    }
    return false;
}
function replaceAt(container, path, value) {
    const [key, ...rest] = path;
    if (typeof key === "number") {
        if (!Array.isArray(container) || key >= container.length) {
            return undefined;
        }
    }
    else if (container != null && (typeof container !== "object" || Array.isArray(container)
        || Object.getPrototypeOf(container) !== Object.prototype)) {
        return undefined;
    }
    const current = container == null ? undefined : member(container, key);
    const child = rest.length > 0 ? replaceAt(current, rest, value) : value;
    if (child === undefined) {
        return undefined;
    }
    const copy = Array.isArray(container) ? container.slice() : { ...(container ?? {}) };
    copy[key] = child;
    return copy;
}
function writePath(runtime, path, value, silent = false) {
    const [top, ...rest] = path;
    if (!isSafeName(top) || Object.prototype.hasOwnProperty.call(runtime.spec.computed, top)) {
        return false;
    }
    const normalized = value === undefined ? null : value;
    if (sameValue(readPath(runtime.state, path), normalized)) {
        return true;
    }
    const next = rest.length > 0 ? replaceAt(runtime.state[top], rest, normalized) : normalized;
    if (next === undefined) {
        return false;
    }
    if (silent) {
        runtime.state[top] = next;
        runtime.invalidate();
    }
    else {
        runtime.set(top, next);
    }
    return true;
}
function bindingFor(runtime, bind, scope) {
    const path = parsePath(bind);
    if (!path) {
        return null;
    }
    const alias = scope?.extra?.[aliasPaths]?.[path[0]];
    const resolve = () => {
        if (!alias) {
            return path;
        }
        const base = alias();
        return base ? [...base, ...path.slice(1)] : null;
    };
    return {
        path: resolve,
        get() {
            const target = resolve();
            return target ? readPath(runtime.state, target) : undefined;
        },
        set(value) {
            const target = resolve();
            return target ? writePath(runtime, target, value) : false;
        },
        init(fallback) {
            const target = resolve();
            if (!target || fallback === undefined) {
                return;
            }
            if (target.length === 1 && !Object.prototype.hasOwnProperty.call(runtime.state, target[0])) {
                ensureInitial(runtime, target[0], fallback);
            }
            else if (readPath(runtime.state, target) == null) {
                writePath(runtime, target, fallback, true);
            }
        }
    };
}
function copyValue(value) {
    if (value === undefined) {
        return null;
    }
    if (value && typeof value === "object") {
        try {
            return JSON.parse(JSON.stringify(value));
        }
        catch {
            return null;
        }
    }
    return value;
}
function cloneJson(value) {
    try {
        return JSON.parse(JSON.stringify(value ?? {}));
    }
    catch {
        return {};
    }
}
export function resolveValue(value, scope) {
    if (typeof value === "string") {
        if (value.startsWith("=")) {
            return evaluate(value.slice(1), scope);
        }
        if (value.includes("{{")) {
            return interpolate(value, scope);
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(item => resolveValue(item, scope));
    }
    if (value && typeof value === "object") {
        const result = {};
        for (const [name, item] of Object.entries(value)) {
            result[name] = resolveValue(item, scope);
        }
        return result;
    }
    return value;
}
export function interpolate(template, scope) {
    return template.replace(/\{\{[^}]*$/, "").replace(/\{\{([\s\S]+?)\}\}/g, (_, expression) => {
        const value = evaluate(expression, scope);
        return typeof value === "number" ? formatValue(value, "auto") : value == null ? "" : String(value);
    });
}
export function evaluate(expression, scope) {
    let compiled = expressionCache.get(expression);
    if (!compiled) {
        try {
            compiled = compileExpression(expression);
        }
        catch {
            compiled = () => undefined;
        }
        if (expressionCache.size > 2000) {
            expressionCache.clear();
        }
        expressionCache.set(expression, compiled);
    }
    try {
        return compiled(scope);
    }
    catch {
        return undefined;
    }
}
function tokenize(source) {
    const tokens = [];
    let index = 0;
    while (index < source.length) {
        const rest = source.slice(index);
        const space = /^\s+/.exec(rest);
        if (space) {
            index += space[0].length;
            continue;
        }
        const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
        if (number) {
            tokens.push({ type: "num", value: parseFloat(number[0]) });
            index += number[0].length;
            continue;
        }
        const quote = rest[0];
        if (quote === "'" || quote === "\"") {
            let out = "";
            let cursor = 1;
            while (cursor < rest.length && rest[cursor] !== quote) {
                if (rest[cursor] === "\\" && cursor + 1 < rest.length) {
                    cursor++;
                    out += rest[cursor] === "n" ? "\n" : rest[cursor];
                }
                else {
                    out += rest[cursor];
                }
                cursor++;
            }
            if (cursor >= rest.length) {
                throw new Error("string");
            }
            tokens.push({ type: "str", value: out });
            index += cursor + 1;
            continue;
        }
        const name = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(rest);
        if (name) {
            tokens.push({ type: "name", value: name[0] });
            index += name[0].length;
            continue;
        }
        const operator = /^(?:===|!==|==|!=|<=|>=|&&|\|\||\?\?|[-+*/%^()[\],.?:!<>])/.exec(rest);
        if (operator) {
            tokens.push({ type: "op", value: operator[0] });
            index += operator[0].length;
            continue;
        }
        throw new Error(`token ${rest[0]}`);
    }
    return tokens;
}
const binaryPrecedence = {
    "??": 1, "||": 2, "&&": 3,
    "==": 4, "!=": 4, "===": 4, "!==": 4,
    "<": 5, ">": 5, "<=": 5, ">=": 5,
    "+": 6, "-": 6,
    "*": 7, "/": 7, "%": 7,
    "^": 8
};
function compileExpression(source) {
    const tokens = tokenize(source);
    let position = 0;
    const peek = () => tokens[position];
    const isOp = (value) => peek()?.type === "op" && peek().value === value;
    const expect = (value) => {
        if (!isOp(value)) {
            throw new Error(`expected ${value}`);
        }
        position++;
    };
    const parseTernary = () => {
        const condition = parseBinary(1);
        if (!isOp("?")) {
            return condition;
        }
        position++;
        const whenTrue = parseTernary();
        expect(":");
        const whenFalse = parseTernary();
        return scope => (truthy(condition(scope)) ? whenTrue(scope) : whenFalse(scope));
    };
    const parseBinary = (minPrecedence) => {
        let left = parseUnary();
        for (;;) {
            const token = peek();
            const precedence = token?.type === "op" ? binaryPrecedence[token.value] : token?.type === "name"
                ? { and: 3, or: 2 }[token.value] : undefined;
            if (precedence === undefined || precedence < minPrecedence) {
                return left;
            }
            position++;
            const operator = token.value === "and" ? "&&" : token.value === "or" ? "||" : token.value;
            const right = parseBinary(operator === "^" ? precedence : precedence + 1);
            left = binary(operator, left, right);
        }
    };
    const parseUnary = () => {
        if (isOp("-")) {
            position++;
            const operand = parseUnary();
            return scope => -toNumber(operand(scope));
        }
        if (isOp("+")) {
            position++;
            const operand = parseUnary();
            return scope => toNumber(operand(scope));
        }
        if (isOp("!") || peek()?.type === "name" && peek().value === "not") {
            position++;
            const operand = parseUnary();
            return scope => !truthy(operand(scope));
        }
        return parsePostfix(parsePrimary());
    };
    const parseArguments = () => {
        const args = [];
        if (isOp(")")) {
            position++;
            return args;
        }
        for (;;) {
            args.push(parseTernary());
            if (isOp(",")) {
                position++;
                continue;
            }
            expect(")");
            return args;
        }
    };
    const parsePrimary = () => {
        const token = peek();
        if (!token) {
            throw new Error("unexpected end");
        }
        position++;
        if (token.type === "num" || token.type === "str") {
            const value = token.value;
            return () => value;
        }
        if (token.type === "name") {
            const name = token.value;
            if (name === "true" || name === "false" || name === "null") {
                const value = name === "true" ? true : name === "false" ? false : null;
                return () => value;
            }
            if (isOp("(")) {
                position++;
                const args = parseArguments();
                const fn = Object.prototype.hasOwnProperty.call(functions, name) ? functions[name] : null;
                if (!fn) {
                    throw new Error(`function ${name}`);
                }
                if (name === "if") {
                    return scope => (truthy(args[0]?.(scope)) ? args[1]?.(scope) : args[2]?.(scope));
                }
                return scope => fn(...args.map(arg => arg(scope)));
            }
            return scope => scope.get(name);
        }
        if (token.value === "(") {
            const inner = parseTernary();
            expect(")");
            return inner;
        }
        if (token.value === "[") {
            const items = [];
            if (isOp("]")) {
                position++;
                return () => [];
            }
            for (;;) {
                items.push(parseTernary());
                if (isOp(",")) {
                    position++;
                    continue;
                }
                expect("]");
                return scope => items.map(item => item(scope));
            }
        }
        throw new Error(`unexpected ${token.value}`);
    };
    const parsePostfix = (target) => {
        let current = target;
        for (;;) {
            if (isOp(".")) {
                position++;
                const token = peek();
                if (token?.type !== "name") {
                    throw new Error("member");
                }
                position++;
                const name = token.value;
                const object = current;
                current = scope => member(object(scope), name);
                continue;
            }
            if (isOp("[")) {
                position++;
                const property = parseTernary();
                expect("]");
                const object = current;
                current = scope => member(object(scope), property(scope));
                continue;
            }
            return current;
        }
    };
    const result = parseTernary();
    if (position !== tokens.length) {
        throw new Error("trailing");
    }
    return result;
}
function member(object, property) {
    if (object == null) {
        return undefined;
    }
    if (property === "length" && (Array.isArray(object) || typeof object === "string")) {
        return object.length;
    }
    const key = typeof property === "number" ? property : String(property);
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return undefined;
    }
    if (Array.isArray(object) || (typeof object === "object" && Object.getPrototypeOf(object) === Object.prototype)) {
        return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
    }
    return undefined;
}
function binary(operator, left, right) {
    switch (operator) {
        case "&&": return scope => { const value = left(scope); return truthy(value) ? right(scope) : value; };
        case "||": return scope => { const value = left(scope); return truthy(value) ? value : right(scope); };
        case "??": return scope => left(scope) ?? right(scope);
        case "+": return scope => {
            const a = left(scope);
            const b = right(scope);
            return typeof a === "string" || typeof b === "string" ? limitText(`${a ?? ""}${b ?? ""}`) : toNumber(a) + toNumber(b);
        };
        case "-": return scope => toNumber(left(scope)) - toNumber(right(scope));
        case "*": return scope => toNumber(left(scope)) * toNumber(right(scope));
        case "/": return scope => toNumber(left(scope)) / toNumber(right(scope));
        case "%": return scope => toNumber(left(scope)) % toNumber(right(scope));
        case "^": return scope => Math.pow(toNumber(left(scope)), toNumber(right(scope)));
        case "==":
        case "===": return scope => looseEquals(left(scope), right(scope));
        case "!=":
        case "!==": return scope => !looseEquals(left(scope), right(scope));
        case "<": return scope => compare(left(scope), right(scope)) < 0;
        case ">": return scope => compare(left(scope), right(scope)) > 0;
        case "<=": return scope => compare(left(scope), right(scope)) <= 0;
        case ">=": return scope => compare(left(scope), right(scope)) >= 0;
        default: throw new Error(operator);
    }
}
function looseEquals(a, b) {
    if (typeof a === "number" || typeof b === "number") {
        const left = toNumber(a);
        const right = toNumber(b);
        if (!Number.isNaN(left) && !Number.isNaN(right) && (typeof a !== "string" || a.trim() !== "") && (typeof b !== "string" || b.trim() !== "")) {
            return left === right;
        }
    }
    return a === b || String(a ?? "") === String(b ?? "") && a != null && b != null;
}
function compare(a, b) {
    if (typeof a === "string" && typeof b === "string") {
        return a.localeCompare(b, "ru");
    }
    return toNumber(a) - toNumber(b);
}
function truthy(value) {
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
}
export function toNumber(value) {
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    if (typeof value === "string") {
        const normalized = value.replace(/[\s ]/g, "").replace(",", ".");
        return normalized === "" ? NaN : Number(normalized);
    }
    return value == null ? NaN : Number(value);
}
const numbers = (values) => values.flat(2).map(toNumber).filter(Number.isFinite);
let uidCounter = 0;
const functions = {
    if: () => undefined,
    min: (...values) => Math.min(...numbers(values)),
    max: (...values) => Math.max(...numbers(values)),
    sum: (...values) => numbers(values).reduce((total, value) => total + value, 0),
    avg: (...values) => { const list = numbers(values); return list.length ? list.reduce((a, b) => a + b, 0) / list.length : NaN; },
    count: (value) => (Array.isArray(value) ? value.length : value == null ? 0 : 1),
    len: (value) => (Array.isArray(value) || typeof value === "string" ? value.length : 0),
    round: (value, digits = 0) => { const factor = 10 ** toNumber(digits); return Math.round(toNumber(value) * factor) / factor; },
    floor: (value) => Math.floor(toNumber(value)),
    ceil: (value) => Math.ceil(toNumber(value)),
    abs: (value) => Math.abs(toNumber(value)),
    sqrt: (value) => Math.sqrt(toNumber(value)),
    pow: (value, power) => Math.pow(toNumber(value), toNumber(power)),
    log: (value) => Math.log(toNumber(value)),
    exp: (value) => Math.exp(toNumber(value)),
    clamp: (value, low, high) => Math.min(Math.max(toNumber(value), toNumber(low)), toNumber(high)),
    number: (value) => toNumber(value),
    text: (value) => (value == null ? "" : String(value)),
    fmt: (value, format, digits) => formatValue(value, format ?? "auto", digits),
    pmt: (rate, periods, principal) => {
        const r = toNumber(rate);
        const n = toNumber(periods);
        const p = toNumber(principal);
        if (!Number.isFinite(r) || !Number.isFinite(n) || n <= 0) {
            return NaN;
        }
        return r === 0 ? p / n : (p * r) / (1 - Math.pow(1 + r, -n));
    },
    percent: (part, whole) => (toNumber(whole) === 0 ? NaN : (toNumber(part) / toNumber(whole)) * 100),
    includes: (list, value) => (Array.isArray(list) ? list.some(item => looseEquals(item, value)) : typeof list === "string" && list.includes(String(value))),
    join: (list, separator = ", ") => (Array.isArray(list) ? limitText(list.join(String(separator))) : ""),
    lower: (value) => String(value ?? "").toLocaleLowerCase("ru"),
    upper: (value) => String(value ?? "").toLocaleUpperCase("ru"),
    range: (start, stop, step = 1) => {
        const from = toNumber(start);
        const to = toNumber(stop);
        const by = toNumber(step) || 1;
        const result = [];
        for (let value = from; by > 0 ? value <= to : value >= to; value += by) {
            result.push(Math.round(value * 1e9) / 1e9);
            if (result.length >= 1000) {
                break;
            }
        }
        return result;
    },
    pluck: (list, field) => (Array.isArray(list) ? list.map(item => member(item, field)) : []),
    find: (list, field, value) => (Array.isArray(list) ? list.find(item => looseEquals(member(item, field), value)) : undefined),
    uid: () => `id${Date.now().toString(36)}${(uidCounter++).toString(36)}`,
    today: () => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    },
    days: (from, to) => {
        const start = Date.parse(from);
        const end = Date.parse(to);
        return Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 86400000) : NaN;
    },
    addDays: (date, amount) => {
        const value = Date.parse(date);
        return Number.isFinite(value) ? new Date(value + toNumber(amount) * 86400000).toISOString().slice(0, 10) : "";
    }
};
const currencyCodes = { rub: "RUB", "₽": "RUB", usd: "USD", "$": "USD", eur: "EUR", "€": "EUR", cny: "CNY", kzt: "KZT" };
export function formatValue(value, format = "auto", digits) {
    if (value === undefined || value === null || value === "") {
        return "—";
    }
    const kind = String(format ?? "auto").toLowerCase();
    if (kind === "text") {
        return String(value);
    }
    if (kind === "date" || kind === "datetime") {
        const time = Date.parse(value);
        if (!Number.isFinite(time)) {
            return String(value);
        }
        return new Intl.DateTimeFormat(formatLocale, kind === "date"
            ? { day: "numeric", month: "long", year: "numeric" }
            : { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(time));
    }
    const number = typeof value === "number" ? value : toNumber(value);
    if (!Number.isFinite(number)) {
        return typeof value === "string" ? value : "—";
    }
    const fraction = digits === undefined ? undefined : Math.max(0, Math.min(6, Math.trunc(toNumber(digits))));
    if (currencyCodes[kind]) {
        const precision = fraction ?? (Math.abs(number) >= 1000 || Number.isInteger(number) ? 0 : 2);
        return new Intl.NumberFormat(formatLocale, {
            style: "currency",
            currency: currencyCodes[kind],
            minimumFractionDigits: precision,
            maximumFractionDigits: precision
        }).format(number);
    }
    if (kind === "percent" || kind === "%") {
        return `${new Intl.NumberFormat(formatLocale, { maximumFractionDigits: fraction ?? 1 }).format(number)} %`;
    }
    if (kind === "compact") {
        return new Intl.NumberFormat(formatLocale, { notation: "compact", maximumFractionDigits: fraction ?? 1 }).format(number);
    }
    if (kind === "duration" || kind === "time") {
        return formatDuration(number, fraction ?? 0);
    }
    if (kind === "integer") {
        return new Intl.NumberFormat(formatLocale, { maximumFractionDigits: 0 }).format(number);
    }
    const precision = fraction ?? (Math.abs(number) >= 100 ? 0 : Math.abs(number) >= 1 ? 2 : 3);
    return new Intl.NumberFormat(formatLocale, { maximumFractionDigits: precision }).format(number);
}
function renderRoot(runtime, spec, complete) {
    const { container } = runtime;
    runtime.complete = complete;
    container.classList.toggle("hui--streaming", !complete);
    const progress = container.querySelector(":scope > .hui__progress");
    const place = (node) => container.insertBefore(node, progress);
    if (spec.title || spec.subtitle) {
        const header = el("header", "hui__header");
        const titles = el("div", "hui__titles");
        if (spec.title) {
            const title = el("h3", "hui__title");
            bindText(runtime, title, spec.title, runtime.scope());
            titles.append(title);
            container.setAttribute("aria-label", stringOf(resolveValue(spec.title, runtime.scope())));
        }
        if (spec.subtitle) {
            const subtitle = el("p", "hui__subtitle");
            bindText(runtime, subtitle, spec.subtitle, runtime.scope());
            titles.append(subtitle);
        }
        header.append(titles);
        if (Object.keys(runtime.initial).length > 0) {
            const reset = el("button", "hui__reset", label(runtime.host, "Reset"));
            reset.type = "button";
            reset.title = label(runtime.host, "Restore the initial values");
            reset.addEventListener("click", () => {
                runtime.reset();
                rerender(runtime, spec, complete);
            });
            runtime.effect(() => {
                reset.hidden = !runtime.changed;
            });
            header.append(reset);
        }
        place(header);
    }
    const body = el("div", "hui__body");
    renderChildren(runtime, body, spec.body, runtime.scope(), 0);
    place(body);
    if (complete) {
        progress?.remove();
    }
    else if (!progress) {
        container.append(el("div", "hui__progress"));
    }
    runtime.flush();
}
function rerender(runtime, spec, complete) {
    runtime.effects.length = 0;
    runtime.resetNodeCount();
    for (const cleanup of runtime.cleanups.splice(0)) {
        try {
            cleanup();
        }
        catch {
        }
    }
    runtime.container.replaceChildren();
    renderRoot(runtime, spec, complete || !runtime.container.classList.contains("hui--streaming"));
}
function renderChildren(runtime, parent, nodes, scope, depth) {
    if (!Array.isArray(nodes)) {
        return;
    }
    for (const node of nodes) {
        const element = renderNode(runtime, node, scope, depth + 1);
        if (element) {
            parent.append(element);
        }
    }
}
function renderNode(runtime, node, scope, depth) {
    if (depth > maxDepth || !runtime.countNode()) {
        return null;
    }
    if (typeof node === "string") {
        const paragraph = el("p", "hui-text");
        bindText(runtime, paragraph, node, scope);
        return paragraph;
    }
    if (!node || typeof node !== "object" || typeof node.type !== "string") {
        return null;
    }
    const type = node.type.toLowerCase();
    const renderer = renderers[type];
    if (!renderer) {
        return null;
    }
    let element;
    try {
        element = renderer(runtime, node, scope, depth);
    }
    catch {
        return null;
    }
    if (!element) {
        return null;
    }
    if (node.when !== undefined) {
        const condition = typeof node.when === "string" && !node.when.startsWith("=") ? `=${node.when}` : node.when;
        runtime.effect(() => {
            element.hidden = !truthy(resolveValue(condition, scope));
        });
    }
    return element;
}
function bindText(runtime, element, value, scope, format) {
    if (typeof value === "string" && (value.startsWith("=") || value.includes("{{"))) {
        runtime.effect(() => {
            const resolved = resolveValue(value, scope);
            setRichText(element, format ? formatValue(resolved, format) : stringOf(resolved));
        });
        return;
    }
    setRichText(element, format ? formatValue(value, format) : stringOf(value));
}
function stringOf(value) {
    if (value === undefined || value === null) {
        return "";
    }
    if (typeof value === "number") {
        return formatValue(value, "auto");
    }
    return typeof value === "string" ? value : String(value);
}
function setRichText(element, text) {
    element.replaceChildren();
    const pattern = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > last) {
            element.append(text.slice(last, match.index));
        }
        if (match[1] !== undefined) {
            element.append(el("strong", null, match[1]));
        }
        else if (match[2] !== undefined) {
            element.append(el("em", null, match[2]));
        }
        else if (match[3] !== undefined) {
            element.append(el("code", null, match[3]));
        }
        else {
            const link = el("span", "hui-link", match[4]);
            link.title = match[5] ?? "";
            element.append(link);
        }
        last = match.index + match[0].length;
    }
    if (last < text.length) {
        element.append(text.slice(last));
    }
}
const tones = new Set(["info", "success", "warning", "danger", "neutral", "accent"]);
const toneOf = (value, fallback = "neutral") => (tones.has(value) ? value : fallback);
const renderers = {
    row(runtime, node, scope, depth) {
        const row = el("div", "hui-row");
        if (node.align === "center" || node.align === "end" || node.align === "stretch") {
            row.dataset.align = node.align;
        }
        if (node.justify === "between" || node.justify === "center" || node.justify === "end") {
            row.dataset.justify = node.justify;
        }
        renderChildren(runtime, row, node.children, scope, depth);
        return row;
    },
    column(runtime, node, scope, depth) {
        const column = el("div", "hui-column");
        renderChildren(runtime, column, node.children, scope, depth);
        return column;
    },
    grid(runtime, node, scope, depth) {
        const grid = el("div", "hui-grid");
        const columns = Math.max(1, Math.min(4, Math.trunc(toNumber(node.columns)) || 2));
        grid.style.setProperty("--hui-columns", String(columns));
        renderChildren(runtime, grid, node.children, scope, depth);
        return grid;
    },
    card(runtime, node, scope, depth) {
        const card = el("section", `hui-card hui-tone--${toneOf(node.tone)}`);
        if (node.title) {
            const title = el("h4", "hui-card__title");
            bindText(runtime, title, node.title, scope);
            card.append(title);
        }
        if (node.subtitle) {
            const subtitle = el("p", "hui-card__subtitle");
            bindText(runtime, subtitle, node.subtitle, scope);
            card.append(subtitle);
        }
        renderChildren(runtime, card, node.children, scope, depth);
        return card;
    },
    tabs(runtime, node, scope, depth) {
        const tabs = Array.isArray(node.tabs) ? node.tabs.filter(tab => tab && typeof tab === "object") : [];
        if (tabs.length === 0) {
            return null;
        }
        const wrapper = el("div", "hui-tabs");
        const list = el("div", "hui-tabs__list");
        list.setAttribute("role", "tablist");
        const panels = [];
        const buttons = [];
        const stateName = bindingFor(runtime, node.bind, scope);
        const select = (index, focus) => {
            buttons.forEach((button, buttonIndex) => {
                const active = buttonIndex === index;
                button.setAttribute("aria-selected", String(active));
                button.tabIndex = active ? 0 : -1;
                panels[buttonIndex].hidden = !active;
            });
            if (focus) {
                buttons[index].focus();
            }
        };
        tabs.forEach((tab, index) => {
            const button = el("button", "hui-tabs__tab");
            button.type = "button";
            button.setAttribute("role", "tab");
            bindText(runtime, button, tab.label ?? label(runtime.host, "Tab {0}", [String(index + 1)]), scope);
            button.addEventListener("click", () => {
                select(index, false);
                stateName?.set(index);
            });
            button.addEventListener("keydown", (event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    const next = (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
                    select(next, true);
                }
            });
            const panel = el("div", "hui-tabs__panel");
            panel.setAttribute("role", "tabpanel");
            renderChildren(runtime, panel, tab.children, scope, depth);
            buttons.push(button);
            panels.push(panel);
            list.append(button);
        });
        wrapper.append(list, ...panels);
        const initial = stateName ? Math.trunc(toNumber(stateName.get())) : 0;
        select(Number.isInteger(initial) && initial >= 0 && initial < tabs.length ? initial : 0, false);
        return wrapper;
    },
    details(runtime, node, scope, depth) {
        const details = el("details", "hui-details");
        details.open = node.open === true;
        const summary = el("summary", null);
        bindText(runtime, summary, node.title ?? label(runtime.host, "Details"), scope);
        details.append(summary);
        const body = el("div", "hui-details__body");
        renderChildren(runtime, body, node.children, scope, depth);
        details.append(body);
        return details;
    },
    divider() {
        return el("hr", "hui-divider");
    },
    heading(runtime, node, scope) {
        const heading = el(node.level === 3 || node.level === "3" ? "h5" : "h4", "hui-heading");
        bindText(runtime, heading, node.text ?? "", scope);
        return heading;
    },
    text(runtime, node, scope) {
        const paragraph = el("p", "hui-text");
        if (node.tone === "muted" || node.tone === "strong" || node.tone === "small") {
            paragraph.dataset.tone = node.tone;
        }
        bindText(runtime, paragraph, node.text ?? node.value ?? "", scope, node.format);
        return paragraph;
    },
    callout(runtime, node, scope, depth) {
        const callout = el("div", `hui-callout hui-tone--${toneOf(node.tone, "info")}`);
        callout.setAttribute("role", node.tone === "danger" || node.tone === "warning" ? "alert" : "note");
        if (node.title) {
            const title = el("strong", "hui-callout__title");
            bindText(runtime, title, node.title, scope);
            callout.append(title);
        }
        if (node.text) {
            const text = el("p", "hui-callout__text");
            bindText(runtime, text, node.text, scope);
            callout.append(text);
        }
        renderChildren(runtime, callout, node.children, scope, depth);
        return callout;
    },
    badge(runtime, node, scope) {
        const badge = el("span", `hui-badge hui-tone--${toneOf(node.tone)}`);
        bindText(runtime, badge, node.text ?? "", scope);
        return badge;
    },
    badges(runtime, node, scope) {
        const row = el("div", "hui-badges");
        for (const item of Array.isArray(node.items) ? node.items : []) {
            const badge = el("span", `hui-badge hui-tone--${toneOf(item?.tone)}`);
            bindText(runtime, badge, typeof item === "string" ? item : item?.text ?? "", scope);
            row.append(badge);
        }
        return row;
    },
    list(runtime, node, scope) {
        const list = el(node.ordered ? "ol" : "ul", "hui-list");
        runtime.effect(() => {
            const items = resolveValue(node.items, scope);
            list.replaceChildren();
            for (const item of Array.isArray(items) ? items.slice(0, 200) : []) {
                const entry = el("li", null);
                setRichText(entry, stringOf(typeof item === "object" && item ? item.text ?? item.label ?? "" : item));
                list.append(entry);
            }
        });
        return list;
    },
    kv(runtime, node, scope) {
        const list = el("dl", "hui-kv");
        for (const item of Array.isArray(node.items) ? node.items : []) {
            if (!item || typeof item !== "object") {
                continue;
            }
            const term = el("dt", null);
            bindText(runtime, term, item.label ?? "", scope);
            const value = el("dd", null);
            bindText(runtime, value, item.value ?? "", scope, item.format);
            list.append(term, value);
        }
        return list;
    },
    stat(runtime, node, scope) {
        const stat = el("div", `hui-stat hui-tone--${toneOf(node.tone)}`);
        const label = el("span", "hui-stat__label");
        bindText(runtime, label, node.label ?? "", scope);
        const value = el("strong", "hui-stat__value");
        stat.append(label, value);
        runtime.effect(() => {
            const resolved = resolveValue(node.value, scope);
            value.textContent = `${node.prefix ?? ""}${formatValue(resolved, node.format ?? "auto", node.digits)}${node.suffix ? ` ${node.suffix}` : ""}`;
            if (node.tone === undefined && node.signed && Number.isFinite(toNumber(resolved))) {
                stat.classList.toggle("hui-tone--success", toNumber(resolved) > 0);
                stat.classList.toggle("hui-tone--danger", toNumber(resolved) < 0);
            }
        });
        if (node.hint) {
            const hint = el("span", "hui-stat__hint");
            bindText(runtime, hint, node.hint, scope);
            stat.append(hint);
        }
        return stat;
    },
    progress(runtime, node, scope) {
        const wrapper = el("div", `hui-progress hui-tone--${toneOf(node.tone, "accent")}`);
        const head = el("div", "hui-progress__head");
        const label = el("span", null);
        bindText(runtime, label, node.label ?? "", scope);
        const value = el("span", "hui-progress__value");
        head.append(label, value);
        const track = el("div", "hui-progress__track");
        const fill = el("div", "hui-progress__fill");
        track.append(fill);
        track.setAttribute("role", "progressbar");
        wrapper.append(head, track);
        runtime.effect(() => {
            const current = toNumber(resolveValue(node.value, scope));
            const max = toNumber(resolveValue(node.max ?? 100, scope)) || 100;
            const ratio = Number.isFinite(current) ? Math.max(0, Math.min(1, current / max)) : 0;
            fill.style.width = `${ratio * 100}%`;
            track.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
            value.textContent = node.format ? formatValue(current, node.format) : `${Math.round(ratio * 100)} %`;
        });
        return wrapper;
    },
    steps(runtime, node, scope) {
        const list = el("ol", "hui-steps");
        for (const item of Array.isArray(node.items) ? node.items : []) {
            if (!item) {
                continue;
            }
            const entry = el("li", "hui-steps__item");
            const status = ["done", "current", "todo", "failed"].includes(item.status) ? item.status : "todo";
            entry.dataset.status = status;
            const title = el("strong", "hui-steps__title");
            bindText(runtime, title, typeof item === "string" ? item : item.title ?? "", scope);
            entry.append(el("span", "hui-steps__mark"), title);
            if (item.text) {
                const text = el("p", "hui-steps__text");
                bindText(runtime, text, item.text, scope);
                entry.append(text);
            }
            list.append(entry);
        }
        return list;
    },
    formula(runtime, node) {
        const formula = el("div", "hui-formula", typeof node.tex === "string" ? node.tex : "");
        if (typeof node.tex === "string" && runtime.host?.renderFormula) {
            runtime.host.renderFormula(formula, node.tex, node.inline !== true);
        }
        return formula;
    },
    image: renderUnsupportedNode,
    gallery: renderUnsupportedNode,
    video: renderUnsupportedNode,
    audio: renderUnsupportedNode,
    link(runtime, node, scope) {
        const link = el("span", "hui-link");
        runtime.effect(() => { link.title = stringOf(resolveValue(node.href ?? "", scope)); });
        bindText(runtime, link, node.text ?? node.href ?? "", scope);
        return link;
    },
    table: renderTable,
    chart: renderChart,
    slider(runtime, node, scope) {
        return renderField(runtime, node, scope, "slider");
    },
    number(runtime, node, scope) {
        return renderField(runtime, node, scope, "number");
    },
    input(runtime, node, scope) {
        return renderField(runtime, node, scope, node.multiline ? "textarea" : "text");
    },
    date(runtime, node, scope) {
        return renderField(runtime, node, scope, "date");
    },
    select(runtime, node, scope) {
        return renderField(runtime, node, scope, "select");
    },
    toggle(runtime, node, scope) {
        return renderToggle(runtime, node, scope);
    },
    segmented(runtime, node, scope) {
        return renderSegmented(runtime, node, scope);
    },
    checklist(runtime, node, scope) {
        return renderChecklist(runtime, node, scope);
    },
    button(runtime, node, scope) {
        return renderButton(runtime, node, scope);
    },
    buttons(runtime, node, scope) {
        const row = el("div", "hui-row hui-buttons");
        for (const item of Array.isArray(node.items) ? node.items : []) {
            if (item && typeof item === "object" && runtime.countNode()) {
                row.append(renderButton(runtime, item, scope));
            }
        }
        return row;
    },
    choices(runtime, node, scope) {
        const wrapper = el("div", "hui-choices");
        if (node.label) {
            const label = el("p", "hui-choices__label");
            bindText(runtime, label, node.label, scope);
            wrapper.append(label);
        }
        const row = el("div", "hui-choices__row");
        for (const item of Array.isArray(node.items) ? node.items : []) {
            const text = typeof item === "string" ? item : item?.label;
            if (typeof text !== "string" || !text.trim()) {
                continue;
            }
            const message = typeof item === "object" && typeof item.message === "string" ? item.message : text;
            if (!runtime.countNode()) {
                break;
            }
            row.append(renderButton(runtime, { label: text, variant: "chip", action: { type: "send", text: message } }, scope));
        }
        wrapper.append(row);
        return wrapper;
    },
    html: renderUnsupportedNode
};
renderers.each = renderEach;
renderers.repeat = renderEach;
renderers.region = renderUnsupportedNode;
renderers.range = renderRange;
renderers.stack = renderers.column;
renderers.section = renderers.card;
renderers.metric = renderers.stat;
renderers.note = renderers.callout;
renderers.alert = renderers.callout;
renderers.markdown = renderers.text;
renderers.paragraph = renderers.text;
renderers.title = renderers.heading;
renderers.timeline = renderers.steps;
renderers.radio = renderers.segmented;
renderers.checkbox = renderers.toggle;
renderers.switch = renderers.toggle;
renderers.textarea = (runtime, node, scope) => renderField(runtime, node, scope, "textarea");
renderers.suggestions = renderers.choices;
export const nodeTypes = Object.freeze(Object.keys(renderers));
export const unsupportedNodeTypes = Object.freeze(["image", "gallery", "video", "audio", "region", "html"]);
function fieldShell(runtime, node, scope, control) {
    const field = el("label", "hui-field");
    if (node.label) {
        const head = el("span", "hui-field__head");
        const label = el("span", "hui-field__label");
        bindText(runtime, label, node.label, scope);
        head.append(label);
        field.append(head);
    }
    field.append(control);
    if (node.hint) {
        const hint = el("span", "hui-field__hint");
        bindText(runtime, hint, node.hint, scope);
        field.append(hint);
    }
    return field;
}
function normalizeOptions(options, scope) {
    const resolved = resolveValue(options, scope);
    if (!Array.isArray(resolved)) {
        return [];
    }
    return resolved.slice(0, 100).map(option => {
        if (option && typeof option === "object") {
            const value = option.value ?? option.label;
            return { value, label: stringOf(option.label ?? option.value) };
        }
        return { value: option, label: stringOf(option) };
    }).filter(option => option.value !== undefined);
}
function ensureInitial(runtime, name, fallback) {
    if (!Object.prototype.hasOwnProperty.call(runtime.state, name) && fallback !== undefined) {
        runtime.state[name] = fallback;
        runtime.initial[name] = cloneJson({ value: fallback }).value;
        runtime.invalidate();
    }
}
function renderField(runtime, node, scope, kind) {
    const name = bindingFor(runtime, node.bind, scope);
    if (kind === "slider") {
        const bound = (value, fallback) => {
            const number = toNumber(resolveValue(value ?? fallback, scope));
            return Number.isFinite(number) ? number : fallback;
        };
        let min = bound(node.min, 0);
        let max = bound(node.max, 100);
        const input = el("input", "hui-slider");
        input.type = "range";
        input.step = String(bound(node.step, 1) || 1);
        if (name) {
            name.init(toNumber(node.value ?? min));
        }
        const wrapper = el("div", "hui-slider-wrap");
        const output = el("output", "hui-field__value");
        wrapper.append(input);
        const field = fieldShell(runtime, node, scope, wrapper);
        const head = field.querySelector(".hui-field__head") ?? field.insertBefore(el("span", "hui-field__head"), field.firstChild);
        head.append(output);
        const sync = () => {
            min = bound(node.min, 0);
            max = Math.max(min, bound(node.max, 100));
            input.min = String(min);
            input.max = String(max);
            const value = name ? toNumber(name.get()) : toNumber(input.value);
            if (Number.isFinite(value) && document.activeElement !== input) {
                input.value = String(value);
            }
            const current = Number.isFinite(value) ? value : toNumber(input.value);
            const ratio = max > min ? (current - min) / (max - min) : 0;
            input.style.setProperty("--hui-fill", `${Math.max(0, Math.min(1, ratio)) * 100}%`);
            output.textContent = `${node.prefix ?? ""}${formatValue(current, node.format ?? "auto", node.digits)}${node.suffix ? ` ${node.suffix}` : ""}`;
        };
        input.addEventListener("input", () => {
            if (name) {
                name.set(toNumber(input.value));
            }
            sync();
        });
        input.setAttribute("aria-label", stringOf(resolveValue(node.label ?? name ?? "", scope)));
        runtime.effect(sync);
        return field;
    }
    if (kind === "select") {
        const select = el("select", "hui-input");
        const options = normalizeOptions(node.options, scope);
        for (const option of options) {
            const element = el("option", null, option.label);
            element.value = JSON.stringify(option.value);
            select.append(element);
        }
        if (name) {
            name.init(node.value ?? options[0]?.value);
        }
        select.addEventListener("change", () => {
            if (name) {
                try {
                    name.set(JSON.parse(select.value));
                }
                catch {
                    name.set(select.value);
                }
            }
        });
        runtime.effect(() => {
            if (name) {
                select.value = JSON.stringify(name.get());
            }
        });
        return fieldShell(runtime, node, scope, select);
    }
    const control = el(kind === "textarea" ? "textarea" : "input", "hui-input");
    if (kind !== "textarea") {
        control.type = kind === "number" ? "number" : kind === "date" ? "date" : "text";
    }
    else {
        control.rows = Math.max(2, Math.min(10, Math.trunc(toNumber(node.rows)) || 3));
    }
    if (kind === "number") {
        control.inputMode = "decimal";
        for (const attribute of ["min", "max", "step"]) {
            if (node[attribute] !== undefined && Number.isFinite(toNumber(node[attribute]))) {
                control[attribute] = String(toNumber(node[attribute]));
            }
        }
    }
    if (typeof node.placeholder === "string") {
        control.placeholder = node.placeholder;
    }
    if (Number.isFinite(toNumber(node.maxLength))) {
        control.maxLength = Math.trunc(toNumber(node.maxLength));
    }
    if (name) {
        name.init(node.value ?? (kind === "number" ? null : ""));
    }
    control.addEventListener("input", () => {
        if (!name) {
            return;
        }
        if (kind === "number") {
            name.set(control.value === "" ? null : toNumber(control.value));
        }
        else {
            name.set(control.value);
        }
    });
    runtime.effect(() => {
        if (!name || document.activeElement === control) {
            return;
        }
        const value = name.get();
        control.value = value === null || value === undefined ? "" : String(value);
    });
    if (node.suffix && kind !== "textarea") {
        const wrapper = el("span", "hui-input-wrap");
        wrapper.append(control, el("span", "hui-input-wrap__suffix", String(node.suffix)));
        return fieldShell(runtime, node, scope, wrapper);
    }
    return fieldShell(runtime, node, scope, control);
}
function renderToggle(runtime, node, scope) {
    const name = bindingFor(runtime, node.bind, scope);
    const field = el("label", "hui-toggle");
    const input = el("input", null);
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    const label = el("span", "hui-toggle__label");
    bindText(runtime, label, node.label ?? "", scope);
    field.append(input, el("span", "hui-toggle__track"), label);
    if (name) {
        name.init(node.value === true);
    }
    input.addEventListener("change", () => {
        if (name) {
            name.set(input.checked);
        }
    });
    runtime.effect(() => {
        if (name) {
            input.checked = truthy(name.get());
        }
    });
    return field;
}
function renderSegmented(runtime, node, scope) {
    const name = bindingFor(runtime, node.bind, scope);
    const options = normalizeOptions(node.options, scope);
    if (name) {
        name.init(node.value ?? options[0]?.value);
    }
    const group = el("div", "hui-segmented");
    group.setAttribute("role", "radiogroup");
    const buttons = options.map(option => {
        const button = el("button", "hui-segmented__option", option.label);
        button.type = "button";
        button.setAttribute("role", "radio");
        button.addEventListener("click", () => {
            if (name) {
                name.set(option.value);
            }
        });
        group.append(button);
        return { button, option };
    });
    runtime.effect(() => {
        for (const { button, option } of buttons) {
            const active = name ? looseEquals(name.get(), option.value) : false;
            button.setAttribute("aria-checked", String(active));
        }
    });
    if (!node.label) {
        return group;
    }
    const wrapper = el("div", "hui-field");
    const head = el("span", "hui-field__head");
    const label = el("span", "hui-field__label");
    bindText(runtime, label, node.label, scope);
    head.append(label);
    group.setAttribute("aria-label", stringOf(resolveValue(node.label, scope)));
    wrapper.append(head, group);
    return wrapper;
}
function renderChecklist(runtime, node, scope) {
    const name = bindingFor(runtime, node.bind, scope);
    const items = (Array.isArray(node.items) ? node.items : []).map((item, index) => (typeof item === "string" ? { id: String(index), text: item, checked: false }
        : { id: String(item?.id ?? index), text: stringOf(item?.text ?? item?.label ?? ""), checked: item?.checked === true }));
    if (name) {
        name.init(items.filter(item => item.checked).map(item => item.id));
    }
    const local = new Set(items.filter(item => item.checked).map(item => item.id));
    const checked = () => (name && Array.isArray(name.get()) ? new Set(name.get().map(String)) : local);
    const list = el("ul", "hui-checklist");
    const inputs = items.map(item => {
        const entry = el("li", null);
        const label = el("label", "hui-checklist__item");
        const input = el("input", null);
        input.type = "checkbox";
        const text = el("span", null);
        setRichText(text, item.text);
        label.append(input, text);
        entry.append(label);
        list.append(entry);
        input.addEventListener("change", () => {
            const next = new Set(checked());
            if (input.checked) {
                next.add(item.id);
            }
            else {
                next.delete(item.id);
            }
            if (name) {
                name.set([...next]);
            }
            else {
                local.clear();
                next.forEach(id => local.add(id));
                runtime.flush();
            }
        });
        return { input, entry, item };
    });
    runtime.effect(() => {
        const set = checked();
        for (const { input, entry, item } of inputs) {
            input.checked = set.has(item.id);
            entry.classList.toggle("hui-checklist__done", input.checked);
        }
    });
    return list;
}
const maxPayloadLength = 16000;
function changeList(runtime, action, scope, type) {
    const slot = bindingFor(runtime, action.bind, scope);
    const current = slot?.get();
    if (!slot || (current != null && !Array.isArray(current))) {
        return;
    }
    const list = Array.isArray(current) ? current.slice() : [];
    const position = (value, fallback) => {
        const number = Math.trunc(toNumber(value === undefined ? fallback : resolveValue(value, scope)));
        return Number.isFinite(number) ? number : NaN;
    };
    if (type === "push") {
        if (list.length >= maxEachItems) {
            return;
        }
        const at = position(action.at, list.length);
        list.splice(Number.isFinite(at) ? Math.max(0, Math.min(list.length, at)) : list.length, 0, copyValue(resolveValue(action.value, scope)));
    }
    else if (type === "remove") {
        const index = position(action.index, scope.get("index"));
        if (!(index >= 0 && index < list.length)) {
            return;
        }
        list.splice(index, 1);
    }
    else {
        const from = position(action.from, scope.get("index"));
        const to = position(action.to, undefined);
        if (!(from >= 0 && from < list.length) || !Number.isFinite(to)) {
            return;
        }
        const [item] = list.splice(from, 1);
        list.splice(Math.max(0, Math.min(list.length, to)), 0, item);
    }
    slot.set(list);
}
function renderButton(runtime, node, scope) {
    const variant = ["primary", "secondary", "ghost", "chip", "danger"].includes(node.variant) ? node.variant : "primary";
    const button = el("button", `hui-button hui-button--${variant}`);
    button.type = "button";
    const caption = el("span", null);
    bindText(runtime, caption, node.label ?? label(runtime.host, "Done"), scope);
    button.append(caption);
    const actions = (Array.isArray(node.action) ? node.action : node.action ? [node.action] : [])
        .filter(action => action && typeof action === "object");
    const sendUnavailable = typeof runtime.host?.send !== "function" && actions.some(action => String(action.type ?? (action.text !== undefined ? "send" : action.values ? "set" : "")).toLowerCase() === "send");
    if (sendUnavailable) {
        button.disabled = true;
        button.title = label(runtime.host, "Sending is not available here");
    }
    let busy = false;
    if (node.disabled !== undefined) {
        const condition = typeof node.disabled === "string" && !node.disabled.startsWith("=") ? `=${node.disabled}` : node.disabled;
        runtime.effect(() => {
            button.disabled = sendUnavailable || busy || truthy(resolveValue(condition, scope));
        });
    }
    button.addEventListener("click", async () => {
        if (busy || sendUnavailable) {
            return;
        }
        for (const action of actions) {
            const type = String(action.type ?? (action.text !== undefined ? "send" : action.values ? "set" : "")).toLowerCase();
            if (type === "set") {
                const values = action.values && typeof action.values === "object" ? action.values : {};
                const updates = [];
                for (const [path, value] of Object.entries(values)) {
                    const slot = bindingFor(runtime, path, scope);
                    if (slot) {
                        updates.push([slot, copyValue(resolveValue(value, scope))]);
                    }
                }
                for (const [slot, value] of updates) {
                    slot.set(value);
                }
            }
            else if (type === "toggle") {
                const slot = bindingFor(runtime, action.bind, scope);
                slot?.set(!truthy(slot.get()));
            }
            else if (type === "push" || type === "remove" || type === "move") {
                changeList(runtime, action, scope, type);
            }
            else if (type === "reset") {
                runtime.reset();
            }
            else if (type === "copy") {
                const text = stringOf(resolveValue(action.text ?? "", scope));
                const copied = await runtime.host?.copy?.(text);
                flash(button, caption, label(runtime.host, copied ? "Copied" : "Could not copy"));
            }
            else if (type === "send") {
                const text = stringOf(resolveValue(action.text ?? node.label ?? "", scope)).trim();
                if (!text) {
                    continue;
                }
                let payload = null;
                if (action.payload !== undefined) {
                    try {
                        payload = JSON.stringify(resolveValue(action.payload, scope) ?? null);
                    }
                    catch {
                        payload = null;
                    }
                    if (!payload || payload.length > maxPayloadLength) {
                        flash(button, caption, label(runtime.host, "Too much data to send. Make it smaller."));
                        continue;
                    }
                }
                busy = true;
                button.disabled = true;
                let sent = false;
                try {
                    sent = (await runtime.host?.send?.(text, payload)) === true;
                }
                catch {
                    sent = false;
                }
                busy = false;
                button.disabled = sendUnavailable;
                runtime.flush();
                flash(button, caption, label(runtime.host, sent ? "Sent" : "Not sent. Try again when the agent is idle."));
                if (sent) {
                    button.classList.add("hui-button--sent");
                }
            }
        }
    });
    return button;
}
function flash(button, label, text) {
    const original = label.textContent;
    label.textContent = text;
    button.classList.add("hui-button--flash");
    window.setTimeout(() => {
        if (label.textContent === text) {
            label.textContent = original;
        }
        button.classList.remove("hui-button--flash");
    }, 1800);
}
function renderTable(runtime, node, scope) {
    const wrapper = el("div", "hui-table");
    const scroller = el("div", "hui-table__scroll");
    const table = el("table", null);
    const head = el("thead", null);
    const body = el("tbody", null);
    const foot = el("tfoot", null);
    table.append(head, body, foot);
    scroller.append(table);
    wrapper.append(scroller);
    const more = el("button", "hui-table__more");
    more.type = "button";
    wrapper.append(more);
    let sortKey = null;
    let sortDirection = 1;
    let visible = tableRowsStep;
    const sortable = node.sortable !== false;
    const draw = () => {
        const rows = (() => {
            const resolved = resolveValue(node.rows ?? node.data, scope);
            return Array.isArray(resolved) ? resolved.slice(0, maxTableRows) : [];
        })();
        const columns = normalizeColumns(node.columns, rows);
        const records = rows.map(row => (Array.isArray(row)
            ? Object.fromEntries(columns.map((column, index) => [column.key, row[index]]))
            : row && typeof row === "object" ? row : {}));
        head.replaceChildren();
        const headRow = el("tr", null);
        for (const column of columns) {
            const cell = el("th", null);
            cell.scope = "col";
            if (column.align === "right" || (column.align === undefined && column.numeric)) {
                cell.dataset.align = "right";
            }
            if (sortable) {
                const button = el("button", "hui-table__sort", column.label);
                button.type = "button";
                const direction = sortKey === column.key ? (sortDirection > 0 ? "ascending" : "descending") : "none";
                cell.setAttribute("aria-sort", direction);
                button.addEventListener("click", () => {
                    sortDirection = sortKey === column.key ? -sortDirection : column.numeric ? -1 : 1;
                    sortKey = column.key;
                    draw();
                });
                cell.append(button);
            }
            else {
                cell.textContent = column.label;
            }
            headRow.append(cell);
        }
        head.append(headRow);
        const ordered = sortKey === null ? records : [...records].sort((a, b) => compare(a[sortKey], b[sortKey]) * sortDirection);
        body.replaceChildren();
        for (const record of ordered.slice(0, visible)) {
            const row = el("tr", null);
            for (const column of columns) {
                const cell = el("td", null);
                const value = record[column.key];
                if (column.align === "right" || (column.align === undefined && column.numeric)) {
                    cell.dataset.align = "right";
                }
                if (column.format) {
                    cell.textContent = formatValue(value, column.format, column.digits);
                }
                else {
                    setRichText(cell, stringOf(value));
                }
                row.append(cell);
            }
            body.append(row);
        }
        foot.replaceChildren();
        if (node.totals) {
            const row = el("tr", null);
            columns.forEach((column, index) => {
                const cell = el("td", null);
                if (column.numeric) {
                    cell.dataset.align = "right";
                    cell.textContent = formatValue(records.reduce((total, record) => total + (toNumber(record[column.key]) || 0), 0), column.format ?? "auto", column.digits);
                }
                else if (index === 0) {
                    cell.textContent = typeof node.totals === "string" ? node.totals : label(runtime.host, "Total");
                }
                row.append(cell);
            });
            foot.append(row);
        }
        more.hidden = ordered.length <= visible;
        more.textContent = label(runtime.host, "Show more ({0})", [String(ordered.length - visible)]);
    };
    more.addEventListener("click", () => {
        visible += tableRowsStep * 4;
        draw();
    });
    runtime.effect(draw);
    if (node.caption) {
        const caption = el("p", "hui-table__caption");
        bindText(runtime, caption, node.caption, scope);
        wrapper.append(caption);
    }
    return wrapper;
}
function normalizeColumns(columns, rows) {
    if (Array.isArray(columns) && columns.length > 0) {
        return columns.map((column, index) => {
            const value = typeof column === "string" ? { key: column, label: column } : column ?? {};
            const key = String(value.key ?? value.field ?? index);
            const sample = rows.find(row => row && typeof row === "object")?.[Array.isArray(rows[0]) ? index : key];
            const numeric = value.format ? !["text", "date", "datetime"].includes(String(value.format)) : typeof sample === "number";
            return { key, label: stringOf(value.label ?? key), format: value.format, digits: value.digits, align: value.align, numeric };
        });
    }
    const first = rows.find(row => row && typeof row === "object" && !Array.isArray(row));
    return first
        ? Object.keys(first).slice(0, 12).map(key => ({ key, label: key, numeric: typeof first[key] === "number" }))
        : [];
}
const svgNs = "http://www.w3.org/2000/svg";
const paletteSize = 8;
function renderChart(runtime, node, scope) {
    const kind = ["bar", "hbar", "line", "area", "pie", "donut", "scatter"].includes(node.kind) ? node.kind : "bar";
    const figure = el("figure", `hui-chart hui-chart--${kind}`);
    const plot = el("div", "hui-chart__plot");
    const tooltip = el("div", "hui-chart__tooltip");
    tooltip.hidden = true;
    const legend = el("div", "hui-chart__legend");
    figure.append(plot, tooltip, legend);
    if (node.caption) {
        const caption = el("figcaption", "hui-chart__caption");
        bindText(runtime, caption, node.caption, scope);
        figure.append(caption);
    }
    if (node.title) {
        const title = el("p", "hui-chart__title");
        bindText(runtime, title, node.title, scope);
        figure.prepend(title);
    }
    let width = 0;
    let data = null;
    const draw = () => {
        if (!data || width <= 0) {
            return;
        }
        plot.replaceChildren();
        legend.replaceChildren();
        tooltip.hidden = true;
        const height = Math.max(140, Math.min(520, Math.trunc(toNumber(node.height)) || (kind === "pie" || kind === "donut" ? 240 : 260)));
        const context = { node, data, width, height, plot, tooltip, legend, figure, host: runtime.host };
        if (kind === "pie" || kind === "donut") {
            drawPie(context, kind === "donut");
        }
        else if (kind === "hbar") {
            drawHorizontalBars(context);
        }
        else {
            drawCartesian(context, kind);
        }
    };
    runtime.effect(() => {
        data = normalizeChartData(node, scope, runtime.host);
        draw();
    });
    const observer = new ResizeObserver(entries => {
        const next = Math.round(entries[0]?.contentRect.width ?? 0);
        if (next > 0 && Math.abs(next - width) >= 4) {
            width = next;
            draw();
        }
    });
    observer.observe(plot);
    runtime.onDispose(() => observer.disconnect());
    plot.setAttribute("role", "img");
    plot.setAttribute("aria-label", stringOf(resolveValue(node.title ?? node.caption ?? label(runtime.host, "Chart"), scope)));
    return figure;
}
export function normalizeChartData(node, scope, host) {
    let labels = resolveValue(node.labels, scope);
    let series = resolveValue(node.series, scope);
    const rows = resolveValue(node.data, scope);
    if ((!Array.isArray(series) || series.length === 0) && Array.isArray(rows)) {
        const objects = rows.filter(row => row && typeof row === "object" && !Array.isArray(row));
        if (objects.length > 0) {
            const xKey = typeof node.x === "string" ? node.x
                : "label" in objects[0] ? "label" : "name" in objects[0] ? "name" : Object.keys(objects[0]).find(key => typeof objects[0][key] === "string");
            const yKeys = Array.isArray(node.y) ? node.y.map(String)
                : typeof node.y === "string" ? [node.y]
                    : "value" in objects[0] ? ["value"]
                        : Object.keys(objects[0]).filter(key => key !== xKey && typeof objects[0][key] === "number");
            labels = objects.map(row => stringOf(row[xKey]));
            const names = node.seriesNames && typeof node.seriesNames === "object" ? node.seriesNames : {};
            series = yKeys.map(key => ({ name: names[key] ?? (yKeys.length === 1 && key === "value" ? stringOf(node.title ?? "") : key), values: objects.map(row => row[key]) }));
        }
        else {
            series = [{ name: "", values: rows }];
        }
    }
    if (!Array.isArray(series)) {
        series = [];
    }
    series = series
        .filter(item => item && typeof item === "object")
        .slice(0, 12)
        .map((item, index) => ({
        name: stringOf(item.name ?? label(host, "Series {0}", [String(index + 1)])),
        values: (Array.isArray(item.values) ? item.values : Array.isArray(item.data) ? item.data : []).slice(0, 400).map(value => {
            if (value && typeof value === "object") {
                return { x: toNumber(value.x), y: toNumber(value.y) };
            }
            return toNumber(value);
        }),
        color: index % paletteSize
    }));
    const longest = series.reduce((max, item) => Math.max(max, item.values.length), 0);
    labels = Array.isArray(labels) ? labels.slice(0, longest || labels.length).map(stringOf) : [];
    while (labels.length < longest) {
        labels.push(String(labels.length + 1));
    }
    return { labels, series, format: node.format ?? "auto", digits: node.digits, stacked: node.stacked === true };
}
function svg(name, attributes = {}, text) {
    const element = document.createElementNS(svgNs, name);
    for (const [key, value] of Object.entries(attributes)) {
        element.setAttribute(key, String(value));
    }
    if (text !== undefined) {
        element.textContent = text;
    }
    return element;
}
export function niceTicks(min, max, count = 5) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return [0, 1];
    }
    if (min === max) {
        const pad = Math.abs(min) || 1;
        min -= pad;
        max += pad;
    }
    const span = max - min;
    const rough = span / Math.max(1, count);
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(candidate => span / candidate <= count) ?? 10 * magnitude;
    const first = Math.floor(min / step);
    const last = Math.ceil(max / step);
    const ticks = [];
    for (let index = first; index <= last && ticks.length < 12; index++) {
        ticks.push(Number((index * step).toPrecision(12)));
    }
    return ticks;
}
function addLegend(context, items) {
    const { legend } = context;
    if (items.length < 2 || items.every(item => !item.name)) {
        legend.hidden = true;
        return;
    }
    legend.hidden = false;
    for (const item of items) {
        const entry = el("span", "hui-chart__legend-item");
        const swatch = el("span", `hui-chart__swatch hui-c${item.color}`);
        entry.append(swatch, document.createTextNode(item.name));
        if (item.value !== undefined) {
            entry.append(el("span", "hui-chart__legend-value", item.value));
        }
        legend.append(entry);
    }
}
function showTooltip(context, x, y, title, lines) {
    const { tooltip, figure } = context;
    tooltip.replaceChildren();
    if (title) {
        tooltip.append(el("strong", null, title));
    }
    for (const line of lines) {
        const row = el("span", "hui-chart__tooltip-row");
        row.append(el("span", `hui-chart__swatch hui-c${line.color}`), document.createTextNode(line.name ? `${line.name}: ` : ""), el("b", null, line.value));
        tooltip.append(row);
    }
    tooltip.hidden = false;
    const bounds = figure.getBoundingClientRect();
    const plotBounds = context.plot.getBoundingClientRect();
    const left = plotBounds.left - bounds.left + x;
    const top = plotBounds.top - bounds.top + y;
    const tipWidth = tooltip.offsetWidth;
    tooltip.style.left = `${Math.max(4, Math.min(bounds.width - tipWidth - 4, left - tipWidth / 2))}px`;
    tooltip.style.top = `${Math.max(4, top - tooltip.offsetHeight - 12)}px`;
}
function hideTooltip(context) {
    context.tooltip.hidden = true;
}
function measureLabel(text, size = 11) {
    return text.length * size * 0.56;
}
function drawCartesian(context, kind) {
    const { data, width, height, plot } = context;
    const { labels, series, format, digits, stacked } = data;
    const scatter = kind === "scatter";
    const count = labels.length;
    if (series.length === 0 || (!scatter && count === 0)) {
        plot.append(el("p", "hui-chart__empty", label(context.host, "No data")));
        return;
    }
    const stackedBars = stacked && kind === "bar";
    const values = [];
    if (scatter) {
        for (const item of series) {
            for (const point of item.values) {
                if (point && typeof point === "object") {
                    values.push(point.y);
                }
            }
        }
    }
    else if (stackedBars || (stacked && kind === "area")) {
        for (let index = 0; index < count; index++) {
            let positive = 0;
            let negative = 0;
            for (const item of series) {
                const value = item.values[index];
                if (Number.isFinite(value)) {
                    if (value >= 0) {
                        positive += value;
                    }
                    else {
                        negative += value;
                    }
                }
            }
            values.push(positive, negative);
        }
    }
    else {
        for (const item of series) {
            values.push(...item.values.filter(Number.isFinite));
        }
    }
    const finite = values.filter(Number.isFinite);
    const lowest = Math.min(kind === "line" || scatter ? Math.min(...finite) : 0, ...finite, kind === "line" || scatter ? Infinity : 0);
    const highest = Math.max(kind === "line" || scatter ? Math.max(...finite) : 0, ...finite);
    const ticks = niceTicks(Number.isFinite(lowest) ? lowest : 0, Number.isFinite(highest) ? highest : 1, height < 200 ? 4 : 5);
    const yMin = ticks[0];
    const yMax = ticks[ticks.length - 1];
    const tickLabels = ticks.map(value => formatValue(value, format === "auto" ? "compact" : format, digits ?? (Math.abs(yMax - yMin) < 10 ? 1 : 0)));
    const left = Math.min(width * 0.3, Math.max(...tickLabels.map(label => measureLabel(label))) + 12);
    const rotate = !scatter && count > 1 && labels.some(label => measureLabel(label) > (width - left) / count - 6);
    const bottom = rotate ? Math.min(90, Math.max(...labels.map(label => measureLabel(label))) * 0.72 + 16) : 26;
    const top = 10;
    const right = 10;
    const innerWidth = Math.max(10, width - left - right);
    const innerHeight = Math.max(10, height - top - bottom);
    const yScale = value => top + innerHeight - ((value - yMin) / (yMax - yMin || 1)) * innerHeight;
    let xMin = 0;
    let xMax = 1;
    if (scatter) {
        const xs = series.flatMap(item => item.values.map(point => point?.x)).filter(Number.isFinite);
        const xTicks = niceTicks(Math.min(...xs), Math.max(...xs), 5);
        xMin = xTicks[0];
        xMax = xTicks[xTicks.length - 1];
    }
    const band = innerWidth / Math.max(1, count);
    const xCenter = index => (kind === "bar" ? left + band * index + band / 2 : left + (count === 1 ? innerWidth / 2 : (innerWidth * index) / (count - 1)));
    const xScatter = value => left + ((value - xMin) / (xMax - xMin || 1)) * innerWidth;
    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "hui-chart__svg" });
    const grid = svg("g", { class: "hui-chart__grid" });
    ticks.forEach((value, index) => {
        const y = yScale(value);
        grid.append(svg("line", { x1: left, x2: width - right, y1: y, y2: y, class: value === 0 ? "hui-chart__zero" : "" }));
        grid.append(svg("text", { x: left - 6, y: y + 4, "text-anchor": "end", class: "hui-chart__tick" }, tickLabels[index]));
    });
    root.append(grid);
    const axis = svg("g", { class: "hui-chart__axis" });
    if (scatter) {
        niceTicks(xMin, xMax, 5).forEach(value => {
            axis.append(svg("text", { x: xScatter(value), y: height - 8, "text-anchor": "middle", class: "hui-chart__tick" }, formatValue(value, "compact")));
        });
    }
    else {
        const every = rotate ? 1 : Math.max(1, Math.ceil(Math.max(...labels.map(label => measureLabel(label))) / (band || 1)));
        const skip = Math.max(every, Math.ceil(count / Math.max(1, Math.floor(innerWidth / 18))));
        labels.forEach((label, index) => {
            if (index % skip !== 0) {
                return;
            }
            const x = xCenter(index);
            const y = height - bottom + 16;
            const text = svg("text", rotate
                ? { x, y, "text-anchor": "end", transform: `rotate(-40 ${x} ${y})`, class: "hui-chart__tick" }
                : { x, y, "text-anchor": "middle", class: "hui-chart__tick" }, label.length > 24 ? `${label.slice(0, 23)}…` : label);
            axis.append(text);
        });
    }
    root.append(axis);
    const zeroY = yScale(Math.max(yMin, Math.min(yMax, 0)));
    const marks = svg("g", { class: "hui-chart__marks" });
    if (kind === "bar") {
        const groupWidth = Math.min(band * 0.72, (stackedBars ? 1 : series.length) * 64);
        const barWidth = stackedBars ? groupWidth : groupWidth / series.length;
        for (let index = 0; index < count; index++) {
            let positive = 0;
            let negative = 0;
            series.forEach((item, seriesIndex) => {
                const value = item.values[index];
                if (!Number.isFinite(value)) {
                    return;
                }
                let y0;
                let y1;
                if (stackedBars) {
                    const base = value >= 0 ? positive : negative;
                    y0 = yScale(base);
                    y1 = yScale(base + value);
                    if (value >= 0) {
                        positive += value;
                    }
                    else {
                        negative += value;
                    }
                }
                else {
                    y0 = zeroY;
                    y1 = yScale(value);
                }
                const x = left + band * index + (band - groupWidth) / 2 + (stackedBars ? 0 : barWidth * seriesIndex);
                marks.append(svg("rect", {
                    x: x + (stackedBars ? 0 : Math.min(1, barWidth * 0.08)),
                    y: Math.min(y0, y1),
                    width: Math.max(1, barWidth - (stackedBars ? 0 : Math.min(2, barWidth * 0.16))),
                    height: Math.max(value === 0 ? 0 : 1, Math.abs(y1 - y0)),
                    rx: Math.min(4, barWidth / 4),
                    class: `hui-chart__bar hui-c${item.color}`
                }));
            });
        }
    }
    else if (scatter) {
        for (const item of series) {
            for (const point of item.values) {
                if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
                    marks.append(svg("circle", { cx: xScatter(point.x), cy: yScale(point.y), r: 4, class: `hui-chart__dot hui-c${item.color}` }));
                }
            }
        }
    }
    else {
        const cumulative = new Array(count).fill(0);
        for (const item of series) {
            const points = [];
            const basePoints = [];
            for (let index = 0; index < count; index++) {
                const value = item.values[index];
                if (!Number.isFinite(value)) {
                    continue;
                }
                const base = stacked && kind === "area" ? cumulative[index] : 0;
                const upper = base + value;
                if (stacked && kind === "area") {
                    cumulative[index] = upper;
                }
                points.push([xCenter(index), yScale(upper)]);
                basePoints.push([xCenter(index), yScale(base)]);
            }
            if (points.length === 0) {
                continue;
            }
            if (kind === "area") {
                const path = `M${points.map(point => point.join(",")).join("L")}L${basePoints.reverse().map(point => point.join(",")).join("L")}Z`;
                marks.append(svg("path", { d: path, class: `hui-chart__area hui-c${item.color}` }));
            }
            marks.append(svg("path", { d: `M${points.map(point => point.join(",")).join("L")}`, class: `hui-chart__line hui-c${item.color}` }));
            if (points.length <= 40) {
                for (const [x, y] of points) {
                    marks.append(svg("circle", { cx: x, cy: y, r: 3, class: `hui-chart__point hui-c${item.color}` }));
                }
            }
        }
    }
    root.append(marks);
    const cursor = svg("line", { x1: 0, x2: 0, y1: top, y2: top + innerHeight, class: "hui-chart__cursor", visibility: "hidden" });
    root.append(cursor);
    plot.append(root);
    if (!scatter) {
        const hover = event => {
            const bounds = root.getBoundingClientRect();
            const x = event.clientX - bounds.left;
            const index = kind === "bar"
                ? Math.floor((x - left) / band)
                : Math.round(((x - left) / (innerWidth || 1)) * (count - 1));
            if (index < 0 || index >= count || x < left - 4 || x > width - right + 4) {
                cursor.setAttribute("visibility", "hidden");
                hideTooltip(context);
                return;
            }
            const center = xCenter(index);
            cursor.setAttribute("x1", center);
            cursor.setAttribute("x2", center);
            cursor.setAttribute("visibility", kind === "bar" ? "hidden" : "visible");
            const lines = series.map(item => ({ name: item.name, color: item.color, value: formatValue(item.values[index], format, digits) }));
            const peak = Math.min(...series.map(item => (Number.isFinite(item.values[index]) ? yScale(Math.max(0, item.values[index])) : top + innerHeight)));
            showTooltip(context, center, Math.max(top, peak), labels[index], lines);
        };
        root.addEventListener("pointermove", hover);
        root.addEventListener("pointerdown", hover);
        root.addEventListener("pointerleave", () => {
            cursor.setAttribute("visibility", "hidden");
            hideTooltip(context);
        });
    }
    addLegend(context, series.map(item => ({ name: item.name, color: item.color })));
}
function drawHorizontalBars(context) {
    const { data, width, plot } = context;
    const { labels, series, format, digits } = data;
    const item = series[0];
    if (!item || labels.length === 0) {
        plot.append(el("p", "hui-chart__empty", label(context.host, "No data")));
        return;
    }
    const rows = labels.map((label, index) => ({ label, value: item.values[index] }))
        .filter(row => Number.isFinite(row.value));
    const maxValue = Math.max(...rows.map(row => Math.abs(row.value)), 0) || 1;
    const list = el("div", "hui-hbars");
    const labelWidth = Math.min(width * 0.42, Math.max(...rows.map(row => measureLabel(row.label, 13))) + 8);
    list.style.setProperty("--hui-hbar-label", `${Math.round(labelWidth)}px`);
    rows.forEach(row => {
        const line = el("div", "hui-hbars__row");
        const label = el("span", "hui-hbars__label", row.label);
        label.title = row.label;
        const track = el("span", "hui-hbars__track");
        const bar = el("span", `hui-hbars__bar hui-c${item.color}`);
        bar.style.width = `${(Math.abs(row.value) / maxValue) * 100}%`;
        if (row.value < 0) {
            bar.classList.add("hui-hbars__bar--negative");
        }
        track.append(bar);
        line.append(label, track, el("span", "hui-hbars__value", formatValue(row.value, format, digits)));
        list.append(line);
    });
    plot.append(list);
    context.legend.hidden = true;
}
function drawPie(context, donut) {
    const { data, width, height, plot, node } = context;
    const { labels, series, format, digits } = data;
    const values = (series[0]?.values ?? []).map(value => (Number.isFinite(value) && value > 0 ? value : 0));
    const total = values.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
        plot.append(el("p", "hui-chart__empty", label(context.host, "No data")));
        return;
    }
    const size = Math.min(height, width);
    const radius = size / 2 - 6;
    const inner = donut ? radius * 0.6 : 0;
    const cx = width / 2;
    const cy = size / 2;
    const root = svg("svg", { width, height: size, viewBox: `0 0 ${width} ${size}`, class: "hui-chart__svg" });
    let angle = -Math.PI / 2;
    const slices = [];
    values.forEach((value, index) => {
        if (value <= 0) {
            return;
        }
        const sweep = (value / total) * Math.PI * 2;
        const end = angle + sweep;
        const color = index % paletteSize;
        let path;
        if (sweep >= Math.PI * 2 - 1e-6) {
            path = donut
                ? `M${cx - radius},${cy}a${radius},${radius} 0 1,0 ${radius * 2},0a${radius},${radius} 0 1,0 ${-radius * 2},0M${cx - inner},${cy}a${inner},${inner} 0 1,1 ${inner * 2},0a${inner},${inner} 0 1,1 ${-inner * 2},0Z`
                : `M${cx - radius},${cy}a${radius},${radius} 0 1,0 ${radius * 2},0a${radius},${radius} 0 1,0 ${-radius * 2},0Z`;
        }
        else {
            const large = sweep > Math.PI ? 1 : 0;
            const outerStart = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
            const outerEnd = [cx + radius * Math.cos(end), cy + radius * Math.sin(end)];
            if (donut) {
                const innerEnd = [cx + inner * Math.cos(end), cy + inner * Math.sin(end)];
                const innerStart = [cx + inner * Math.cos(angle), cy + inner * Math.sin(angle)];
                path = `M${outerStart}A${radius},${radius} 0 ${large},1 ${outerEnd}L${innerEnd}A${inner},${inner} 0 ${large},0 ${innerStart}Z`;
            }
            else {
                path = `M${cx},${cy}L${outerStart}A${radius},${radius} 0 ${large},1 ${outerEnd}Z`;
            }
        }
        const slice = svg("path", { d: path, class: `hui-chart__slice hui-c${color}` });
        const middle = angle + sweep / 2;
        const share = (value / total) * 100;
        slice.addEventListener("pointermove", event => {
            const bounds = plot.getBoundingClientRect();
            showTooltip(context, event.clientX - bounds.left, event.clientY - bounds.top, labels[index], [
                { name: "", color, value: `${formatValue(value, format, digits)} · ${formatValue(share, "percent")}` }
            ]);
        });
        slice.addEventListener("pointerleave", () => hideTooltip(context));
        root.append(slice);
        if (share >= 7 && radius > 60) {
            const labelRadius = donut ? (radius + inner) / 2 : radius * 0.62;
            root.append(svg("text", {
                x: cx + labelRadius * Math.cos(middle),
                y: cy + labelRadius * Math.sin(middle) + 4,
                "text-anchor": "middle",
                class: "hui-chart__slice-label"
            }, `${Math.round(share)}%`));
        }
        slices.push({ name: labels[index] ?? "", color, value: formatValue(value, format, digits) });
        angle = end;
    });
    if (donut) {
        const centerValue = node.center !== undefined ? stringOf(node.center) : formatValue(total, format, digits);
        root.append(svg("text", { x: cx, y: cy + 6, "text-anchor": "middle", class: "hui-chart__center" }, centerValue));
    }
    plot.append(root);
    context.legend.hidden = false;
    for (const slice of slices) {
        const entry = el("span", "hui-chart__legend-item");
        entry.append(el("span", `hui-chart__swatch hui-c${slice.color}`), document.createTextNode(slice.name), el("span", "hui-chart__legend-value", slice.value));
        context.legend.append(entry);
    }
}
const maxEachItems = 200;
function renderEach(runtime, node, scope, depth) {
    const as = isSafeName(node.as) ? node.as : "item";
    const indexName = isSafeName(node.indexAs) ? node.indexAs : "index";
    const keyField = isSafeName(node.key) ? node.key : null;
    const slot = node.bind !== undefined ? bindingFor(runtime, node.bind, scope) : null;
    if (node.bind !== undefined && !slot) {
        return null;
    }
    const layout = node.layout === "row" || node.layout === "grid" ? node.layout : "column";
    const list = el("div", `hui-each hui-each--${layout}`);
    if (layout === "grid") {
        list.style.setProperty("--hui-each-columns", String(clampInteger(node.columns, 2, 1, 4)));
    }
    const empty = node.empty !== undefined ? el("p", "hui-each__empty") : null;
    if (empty) {
        bindText(runtime, empty, node.empty, scope);
        list.append(empty);
    }
    const parentExtra = scope?.extra ?? null;
    const rows = new Map();
    let items = [];
    let source = null;
    let positions = new Map();
    const keyOf = (item, index) => {
        const value = keyField ? member(item, keyField) : undefined;
        return typeof value === "string" || typeof value === "number" ? `k:${value}` : `i:${index}`;
    };
    const keysOf = list => {
        const seen = new Set();
        return list.map((item, index) => {
            let key = keyOf(item, index);
            if (seen.has(key)) {
                key = `${key}#${index}`;
            }
            seen.add(key);
            return key;
        });
    };
    const read = () => {
        const value = slot ? slot.get() : resolveValue(node.items, scope);
        return Array.isArray(value) ? value.slice(0, maxEachItems) : [];
    };
    const sync = () => {
        if (slot && slot.get() !== source) {
            source = slot.get();
            items = read();
            positions = new Map(keysOf(items).map((key, index) => [key, index]));
        }
    };
    const locate = key => {
        sync();
        return positions.get(key);
    };
    const createRow = key => {
        const extra = {};
        if (parentExtra) {
            Object.defineProperties(extra, Object.getOwnPropertyDescriptors(parentExtra));
        }
        Object.defineProperty(extra, as, { configurable: true, enumerable: true, get: () => items[locate(key)] });
        Object.defineProperty(extra, indexName, { configurable: true, enumerable: true, get: () => locate(key) });
        const aliases = { ...(parentExtra?.[aliasPaths] ?? {}) };
        if (slot) {
            aliases[as] = () => {
                const base = slot.path();
                const index = locate(key);
                return base && index !== undefined ? [...base, index] : null;
            };
        }
        else {
            delete aliases[as];
        }
        Object.defineProperty(extra, aliasPaths, { configurable: true, value: aliases });
        const element = el("div", "hui-each__item");
        const rowScope = runtime.scope(extra);
        let fits = true;
        const dispose = runtime.own(() => {
            fits = runtime.countNode();
            if (fits) {
                renderChildren(runtime, element, node.children, rowScope, depth);
            }
        });
        if (!fits) {
            dispose();
            return null;
        }
        return { element, dispose };
    };
    runtime.effect(() => {
        source = slot ? slot.get() : null;
        items = read();
        const keys = keysOf(items);
        positions = new Map(keys.map((key, index) => [key, index]));
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        for (const [key, row] of rows) {
            if (!positions.has(key)) {
                row.dispose();
                row.element.remove();
                rows.delete(key);
            }
        }
        let placed = empty ? 1 : 0;
        for (const key of keys) {
            let row = rows.get(key);
            if (!row) {
                row = createRow(key);
                if (!row) {
                    break;
                }
                rows.set(key, row);
            }
            const at = list.children[placed] ?? null;
            if (at !== row.element) {
                list.insertBefore(row.element, at);
            }
            placed++;
        }
        if (empty) {
            empty.hidden = items.length > 0;
        }
        if (focused && focused.isConnected && document.activeElement !== focused) {
            focused.focus({ preventScroll: true });
        }
    });
    return list;
}
function renderRange(runtime, node, scope) {
    const startSlot = bindingFor(runtime, node.bindStart, scope);
    const endSlot = bindingFor(runtime, node.bindEnd, scope);
    if (!startSlot || !endSlot) {
        return null;
    }
    const bound = (value, fallback) => {
        const number = toNumber(resolveValue(value ?? fallback, scope));
        return Number.isFinite(number) ? number : fallback;
    };
    const track = el("div", "hui-range__track");
    const fill = el("div", "hui-range__fill");
    track.append(fill);
    const fieldLabel = stringOf(resolveValue(node.label ?? "", scope));
    const makeInput = (name, fallbackLabel) => {
        const input = el("input", `hui-range__input hui-range__input--${name}`);
        input.type = "range";
        const own = stringOf(resolveValue(node[`${name}Label`] ?? fallbackLabel, scope));
        input.setAttribute("aria-label", fieldLabel ? `${fieldLabel}: ${own}` : own);
        return input;
    };
    const low = makeInput("start", label(runtime.host, "start"));
    const high = makeInput("end", label(runtime.host, "end"));
    const box = el("div", "hui-range");
    box.append(track, low, high);
    const output = el("output", "hui-field__value");
    const field = fieldShell(runtime, node, scope, box);
    const head = field.querySelector(".hui-field__head") ?? field.insertBefore(el("span", "hui-field__head"), field.firstChild);
    head.append(output);
    let min = 0;
    let max = 100;
    let gap = 0;
    let step = 1;
    const fit = (value, round) => {
        const snapped = min + round((value - min) / step + 1e-9) * step;
        return Math.max(min, Math.min(max, Math.round(snapped * 1e6) / 1e6));
    };
    const values = () => {
        let start = toNumber(startSlot.get());
        let end = toNumber(endSlot.get());
        start = Number.isFinite(start) ? start : min;
        end = Number.isFinite(end) ? end : max;
        return { start: Math.max(min, Math.min(max, start)), end: Math.max(min, Math.min(max, end)) };
    };
    const format = value => `${node.prefix ?? ""}${formatValue(value, node.format ?? "auto", node.digits)}${node.suffix ? ` ${node.suffix}` : ""}`;
    low.addEventListener("input", () => {
        const value = fit(Math.min(toNumber(low.value), values().end - gap), Math.floor);
        low.value = String(value);
        startSlot.set(value);
    });
    high.addEventListener("input", () => {
        const value = fit(Math.max(toNumber(high.value), values().start + gap), number => Math.ceil(number - 2e-9));
        high.value = String(value);
        endSlot.set(value);
    });
    runtime.effect(() => {
        min = bound(node.min, 0);
        max = Math.max(min, bound(node.max, 100));
        gap = Math.max(0, bound(node.minGap, 0));
        step = Math.abs(bound(node.step, 1)) || 1;
        for (const input of [low, high]) {
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
        }
        if (max > min) {
            startSlot.init(min);
            endSlot.init(max);
        }
        const { start, end } = values();
        if (document.activeElement !== low) {
            low.value = String(start);
        }
        if (document.activeElement !== high) {
            high.value = String(end);
        }
        const span = max - min || 1;
        fill.style.left = `${((start - min) / span) * 100}%`;
        fill.style.right = `${100 - ((end - min) / span) * 100}%`;
        low.style.zIndex = start > min + span / 2 ? "3" : "2";
        output.textContent = `${format(start)} — ${format(end)}`;
    });
    return field;
}
function formatDuration(seconds, digits = 0) {
    if (!Number.isFinite(seconds)) {
        return "—";
    }
    const precision = Math.max(0, Math.min(3, Math.trunc(digits)));
    const sign = seconds < 0 ? "−" : "";
    const factor = 10 ** precision;
    const total = Math.round(Math.abs(seconds) * factor) / factor;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total - hours * 3600 - minutes * 60;
    const secondsText = precision > 0
        ? rest.toFixed(precision).padStart(3 + precision, "0")
        : String(Math.floor(rest)).padStart(2, "0");
    return hours > 0
        ? `${sign}${hours}:${String(minutes).padStart(2, "0")}:${secondsText}`
        : `${sign}${minutes}:${secondsText}`;
}
function clampInteger(value, fallback, low, high) {
    const number = Math.trunc(toNumber(value));
    return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
}
function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (text !== undefined && text !== null) {
        element.textContent = text;
    }
    return element;
}
function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}
