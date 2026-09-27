// `pnpm plugin:check <plugin folder> [...]`: checks a plugin package with the
// application's own rules (apps/desktop/src/host-api/pluginManifest.ts, the
// mirror of the host validator) and every pipeline template with the app's
// system file parser. Prints the package code hash PiUI shows in its trust
// review. Nothing in the package is executed.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const LIMITS = { files: 2000, fileBytes: 8 * 1024 * 1024, packageBytes: 20 * 1024 * 1024 };
const SKIPPED = new Set(['.git', '.hg', '.svn']);

function readPackage(root) {
  const files = [];
  let total = 0;
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`The package contains a link: ${relative}.`);
      if (stat.isDirectory()) {
        if (!SKIPPED.has(name)) walk(path, `${relative}/`);
        continue;
      }
      if (!stat.isFile()) throw new Error(`The package path “${relative}” is not allowed.`);
      if (files.length >= LIMITS.files) throw new Error('The package has more than 2000 files.');
      total += stat.size;
      if (stat.size > LIMITS.fileBytes || total > LIMITS.packageBytes) throw new Error('The package is larger than 20 MiB or a file is larger than 8 MiB.');
      files.push({ path: relative, bytes: readFileSync(path) });
    }
  };
  walk(root, '');
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** The host's `code_hash`: a domain tag, then per file path, NUL, u64 LE length, SHA-256. */
function codeHash(files) {
  const hash = createHash('sha256');
  hash.update('piui-plugin-package-v1\n');
  for (const file of files) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(file.bytes.length));
    hash.update(file.path);
    hash.update(Buffer.from([0]));
    hash.update(length);
    hash.update(createHash('sha256').update(file.bytes).digest());
  }
  return hash.digest('hex');
}

const folders = process.argv.slice(2);
if (!folders.length) {
  console.error('Usage: pnpm plugin:check <plugin folder> [...]');
  process.exit(1);
}
const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const server = await createServer({
  root: fileURLToPath(new URL('../apps/desktop', import.meta.url)),
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null },
  appType: 'custom',
});
const piui = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
try {
  const rules = await server.ssrLoadModule('/src/host-api/pluginManifest.ts');
  const { parseSystemFile } = await server.ssrLoadModule('/src/features/orchestration/systemFile.ts');
  for (const folder of folders) {
    const root = resolve(folder);
    try {
      const files = readPackage(root);
      const problems = [];
      for (const file of files) if (!rules.safePackagePath(file.path)) problems.push(`The package path “${file.path}” is not allowed.`);
      const manifestFile = files.find((file) => file.path === 'piui-plugin.json');
      if (!manifestFile) throw new Error('There is no piui-plugin.json at the top of the package.');
      const checked = rules.checkPluginManifestText(manifestFile.bytes.toString('utf8'), piui);
      if (!checked.ok) {
        for (const item of checked.problems) problems.push(`${item.message.replace('{0}', item.subject ?? '')}${item.detail ? ` ${item.detail}` : ''}`);
      } else {
        const { manifest } = checked;
        const named = [manifest.backend?.entry, manifest.ui?.entry, ...(manifest.contributes.templates ?? []).map((template) => template.file)].filter(Boolean);
        for (const path of named) if (!files.some((file) => file.path === path)) problems.push(`The manifest names a file the package does not contain: ${path}.`);
        for (const template of manifest.contributes.templates ?? []) {
          const file = files.find((item) => item.path === template.file);
          if (!file) continue;
          try {
            parseSystemFile(file.bytes.toString('utf8'));
          } catch (error) {
            problems.push(`Template ${template.id}: ${error.message}`);
          }
        }
        if (!checked.compatible) problems.push(`This plugin needs PiUI ${manifest.engines.piui}; this is PiUI ${piui}.`);
        for (const key of rules.reservedKeybindings(manifest)) {
          console.warn(`${folder}: warning: the keybinding ${key} is a PiUI shortcut; PiUI keeps it and the binding never runs.`);
        }
      }
      if (problems.length) {
        console.error(`${folder}: invalid`);
        for (const item of problems) console.error(`  - ${item}`);
        process.exitCode = 1;
      } else {
        const bytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
        console.log(`${folder}: valid (${checked.manifest.id} ${checked.manifest.version}, ${files.length} files, ${bytes} bytes, code ${codeHash(files).slice(0, 12)})`);
      }
    } catch (error) {
      console.error(`${folder}: ${error.message}`);
      process.exitCode = 1;
    }
  }
} finally {
  await server.close();
}
