import { writeFile } from "node:fs/promises";

let nextSession = 1;
class Manager {
  constructor(cwd, sessionDir, path) { this.cwd = cwd; this.sessionDir = sessionDir; this.path = path ?? `${sessionDir}/fixture-${nextSession++}.jsonl`; this.id = this.path.split(/[\\/]/).at(-1).replace(/\.jsonl$/, ""); }
  getCwd() { return this.cwd; }
  getSessionFile() { return this.path; }
  getSessionId() { return this.id; }
}
export const SessionManager = {
  create(cwd, sessionDir) { return new Manager(cwd, sessionDir); },
  open(path, sessionDir) { return new Manager(process.cwd(), sessionDir, path); },
  async listAll(_callbacks, sessionDir) { return [{ id: "saved", path: `${sessionDir}/saved.jsonl` }]; },
};
export const AuthStorage = { create(path, options) { return { path, options }; } };
let fastModelLookups = 0;
let refreshedModelLookups = 0;
export function resetModelLookupCounts() { fastModelLookups = 0; refreshedModelLookups = 0; }
export function getModelLookupCounts() { return { fast: fastModelLookups, refreshed: refreshedModelLookups }; }
class Registry {
  constructor(empty = false) { this.models = empty ? [] : [{ id: "fixture-model", provider: "fixture-provider", name: "Fixture model" }]; }
  getAvailable() { fastModelLookups += 1; return this.models; }
  async refreshAvailableModels() { refreshedModelLookups += 1; return this.models; }
}
export const ModelRegistry = { create(authStorage) { return new Registry(authStorage.path.includes("empty-model")); } };
export const SettingsManager = { create() { return {}; } };
export function defineTool(tool) { return tool; }
export function createIpythonTool() { return { name: 'ipython' }; }
let configuredSkills = [];
export function lastConfiguredSkills() { return configuredSkills; }
export async function createAgentSessionServices(options) {
  const base = { skills: [{ name: "alpha" }, { name: "beta" }], diagnostics: [] };
  configuredSkills = (options.resourceLoaderOptions?.skillsOverride?.(base) ?? base).skills.map(skill => skill.name);
  return { ...options, diagnostics: [], resourceLoader: { getSkills: () => ({ skills: configuredSkills.map(name => ({ name })) }) }, mcpManager: {} };
}
export async function createAgentSessionFromServices(options) {
  // Model the native SDK's authoritative initial model/auth refresh.
  await options.services.modelRegistry.refreshAvailableModels();
  return { session: { sessionManager: options.sessionManager, customTools: options.customTools ?? [], activeTools: options.tools ?? ["ipython"] }, extensionsResult: {} };
}
export async function createAgentSessionRuntime(factory, options) {
  const built = await factory({ cwd: options.cwd, sessionManager: options.sessionManager, sessionStartEvent: { type: "session_start", reason: "startup" } });
  const session = {
    ...built.session,
    sessionId: options.sessionManager.getSessionId(),
    sessionFile: options.sessionManager.getSessionFile(),
    sessionName: "Fixture Prime",
    getActiveToolNames() { return built.session.activeTools; },
    getAllTools() { return [{ name: "ipython" }, { name: "workspace" }, { name: "external_tool" }]; },
    resourceLoader: built.services.resourceLoader,
  };
  return { session, services: built.services };
}
export class InProcessAgentConnection {
  constructor(runtime) {
    this.runtime = runtime;
    this.listeners = new Set();
    this.model = runtime.services.modelRegistry.models[0];
    this.streaming = false;
    this.disposed = false;
    this.messages = [{ role: "user", content: "history", timestamp: 1 }];
  }
  async bindHeadlessExtensions() {}
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener({ type: "session_event", event }); }
  async getState() { return { sessionId: this.runtime.session.sessionId, sessionFile: this.runtime.session.sessionFile, sessionName: this.runtime.session.sessionName, model: this.model, isStreaming: this.streaming }; }
  async getAvailableModels() { return this.runtime.services.modelRegistry.refreshAvailableModels(); }
  async getMessages() { return this.messages; }
  async prompt(text) {
    this.messages.push({ role: "user", content: text, timestamp: 2 });
    setImmediate(async () => {
      await writeFile(this.runtime.session.sessionFile, "{\"type\":\"session\"}\n", "utf8");
      this.streaming = true;
      this.emit({ type: "agent_start" });
      if (text === "wait-for-abort") return;
      let answer = text === "fail-turn" ? "failed" : "answer";
      if (text === "workspace-roster") {
        const tool = this.runtime.session.customTools.find((candidate) => candidate.name === "workspace");
        this.emit({ type: "tool_execution_start", toolCallId: "private-tool-call", toolName: "workspace" });
        const result = await tool.execute("private-tool-call", { type: "roster" });
        answer = result.content[0].text;
        this.emit({ type: "tool_execution_end", toolCallId: "private-tool-call", toolName: "workspace", isError: false });
      }
      const stopReason = text === "fail-turn" ? "error" : text === "tool-use-terminal" ? "toolUse" : text === "unknown-terminal" ? "futureReason" : "stop";
      const assistant = { role: "assistant", content: answer, stopReason, usage: {input:10,output:4,cacheRead:2,cacheWrite:0,totalTokens:14} };
      this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: answer } });
      this.emit({ type: "message_end", message: assistant });
      this.streaming = false;
      this.emit({ type: "agent_end", messages: [assistant] });
    });
  }
  async steer(text) { return this.prompt(text); }
  async followUp(text) { return this.prompt(text); }
  async abort() {
    if (!this.streaming) return;
    const assistant = { role: "assistant", content: "", stopReason: "aborted" };
    this.emit({ type: "message_end", message: assistant });
    this.streaming = false;
    this.emit({ type: "agent_end", messages: [assistant] });
  }
  async abortBash() {}
  async setModel(provider, id) { this.model = { id, provider, name: id }; return this.model; }
  async setThinkingLevel(level) { this.thinkingLevel = level; }
  async setSessionName(name) { this.runtime.session.sessionName = name; }
  async dispose() { this.disposed = true; }
}
