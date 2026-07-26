import { basename, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";

const SENTINEL = "PIUI_EXTENSION_RESULT\t";
const MAX_ITEMS = 512;

function fail(message) {
  throw new Error(message);
}

function cleanPatternTarget(entry) {
  return /^[!+-]/.test(entry) ? entry.slice(1) : entry;
}

function extensionName(path) {
  return basename(path).replace(/\.(?:[cm]?[jt]s)$/i, "").slice(0, 160) || "Extension";
}

const [distPath, cwd, action, targetPath = "", enabledText = ""] = process.argv.slice(1);
if (!distPath || !cwd || !action) fail("missing extension manager arguments");

const settingsUrl = pathToFileURL(`${distPath}/core/settings-manager.js`).href;
const packageManagerUrl = pathToFileURL(`${distPath}/core/package-manager.js`).href;
const configUrl = pathToFileURL(`${distPath}/config.js`).href;
const [{ SettingsManager }, { DefaultPackageManager }, { getAgentDir }] = await Promise.all([
  import(settingsUrl),
  import(packageManagerUrl),
  import(configUrl),
]);

const agentDir = getAgentDir();
const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });

async function inventory() {
  const resolved = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve(async () => "skip");
  return (resolved.extensions ?? [])
    .filter((item) => item?.metadata?.scope === "user" && typeof item.path === "string")
    .slice(0, MAX_ITEMS)
    .map((item) => ({
      path: item.path,
      name: extensionName(item.path),
      enabled: item.enabled === true,
      origin: item.metadata.origin === "package" ? "package" : "top-level",
      source: typeof item.metadata.source === "string" ? item.metadata.source : "",
      baseDir: typeof item.metadata.baseDir === "string" ? item.metadata.baseDir : undefined,
    }));
}

function setTopLevel(item, enabled) {
  const settings = settingsManager.getGlobalSettings();
  const current = Array.isArray(settings.extensions) ? settings.extensions : [];
  const baseDir = item.baseDir ?? agentDir;
  const pattern = relative(baseDir, item.path);
  const updated = current.filter((entry) => typeof entry !== "string" || cleanPatternTarget(entry) !== pattern);
  updated.push(`${enabled ? "+" : "-"}${pattern}`);
  settingsManager.setExtensionPaths(updated);
}

function setPackage(item, enabled) {
  const settings = settingsManager.getGlobalSettings();
  const packages = [...(settings.packages ?? [])];
  const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === item.source);
  if (index < 0) fail("extension package is no longer configured");
  let entry = packages[index];
  if (typeof entry === "string") {
    entry = { source: entry };
    packages[index] = entry;
  }
  const pattern = relative(item.baseDir ?? dirname(item.path), item.path);
  const current = Array.isArray(entry.extensions) ? entry.extensions : [];
  const updated = current.filter((value) => typeof value !== "string" || cleanPatternTarget(value) !== pattern);
  updated.push(`${enabled ? "+" : "-"}${pattern}`);
  entry.extensions = updated;
  settingsManager.setPackages(packages);
}

let items = await inventory();
if (action === "set") {
  const item = items.find((candidate) => candidate.path === targetPath);
  if (!item) fail("extension is no longer available");
  const enabled = enabledText === "true";
  if (item.origin === "package") setPackage(item, enabled);
  else setTopLevel(item, enabled);
  items = await inventory();
} else if (action !== "list") {
  fail("unknown extension manager action");
}

process.stdout.write(`${SENTINEL}${JSON.stringify({ items })}\n`);
