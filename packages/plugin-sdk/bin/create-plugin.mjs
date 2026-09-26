#!/usr/bin/env node
// Creates a new PiUI plugin folder: `pnpm create-plugin <dir> [--id <id>]
// [--name <name>] [--panel] [--no-backend]`. The result validates with
// `pnpm plugin:check <dir>` and loads in PiUI with Settings → Plugins →
// "Load unpacked…". Nothing is installed or run.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdk = resolve(here, '..', 'src');

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: pnpm create-plugin <dir> [--id <id>] [--name <name>] [--panel] [--no-backend]');
  process.exit(1);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) usage(`${name} needs a value.`);
  args.splice(index, 2);
  return value;
}

function flag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function piuiRange() {
  const root = JSON.parse(readFileSync(resolve(here, '..', '..', '..', 'package.json'), 'utf8'));
  const [major, minor] = String(root.version ?? '0.1.0').split('.');
  return `>=${major}.${minor}.0 <1.0.0`;
}

const args = process.argv.slice(2);
const id = option(args, '--id');
const name = option(args, '--name');
const panel = flag(args, '--panel');
const backend = !flag(args, '--no-backend');
if (args.length !== 1 || args[0].startsWith('--')) usage();
const target = resolve(process.cwd(), args[0]);
if (existsSync(target) && readdirSync(target).length > 0) usage(`${target} is not empty.`);

const slug = basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'my-plugin';
const pluginId = id ?? `local.${slug}`;
if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?){0,7}$/.test(pluginId) || pluginId.length > 100) {
  usage('The id must be lowercase segments of letters, digits and inner hyphens joined by dots, like "acme.word-count".');
}
const title = name ?? slug.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');

const permissions = ['commands', 'ui.settings', ...(panel ? ['ui.panel', 'chat.read', 'notifications'] : [])];
const manifest = {
  schemaVersion: 1,
  id: pluginId,
  name: title,
  version: '0.1.0',
  publisher: 'You',
  description: 'Describe what this plugin does.',
  engines: { piui: piuiRange() },
  permissions,
  ...(backend ? { backend: { entry: 'backend/main.mjs' } } : {}),
  ...(panel ? { ui: { entry: 'ui/index.html' } } : {}),
  contributes: {
    commands: [
      backend
        ? { id: 'hello', title: `${title}: say hello`, surfaces: ['palette'] }
        : { id: 'hello', title: `${title}: insert a greeting`, surfaces: ['palette', 'composer'], insertText: 'Hello!' },
    ],
    settings: [{ key: 'greeting', label: 'Greeting', type: 'text', default: 'Hello', maxLength: 80 }],
    ...(panel ? { panels: [{ id: 'main', title, location: 'chat-details' }] } : {}),
  },
};

function write(relative, text) {
  const path = join(target, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

mkdirSync(target, { recursive: true });
write('piui-plugin.json', `${JSON.stringify(manifest, null, 2)}\n`);
if (backend) {
  mkdirSync(join(target, 'backend'), { recursive: true });
  copyFileSync(join(sdk, 'backend.mjs'), join(target, 'backend', 'piui-plugin-backend.mjs'));
  write(
    'backend/main.mjs',
    `import { startPluginBackend } from './piui-plugin-backend.mjs';

// PiUI starts this file with Node.js on first use. Log with console.error:
// stdout is the protocol. This is not a sandbox: ask only for the
// permissions you need and say what you do with them.
startPluginBackend({
  commands: {
    hello: ({ settings, context }) => ({
      notice: \`\${settings.greeting ?? 'Hello'} from ${title}!\`,
      ...(context.chat ? { text: \`\${settings.greeting ?? 'Hello'}, "\${context.chat.title}"!\` } : {}),
    }),
  },
});
`,
  );
}
if (panel) {
  mkdirSync(join(target, 'ui'), { recursive: true });
  copyFileSync(join(sdk, 'panel.js'), join(target, 'ui', 'piui-panel.js'));
  write(
    'ui/index.html',
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <link rel="stylesheet" href="panel.css" />
  </head>
  <body>
    <main>
      <p id="chat">Waiting for PiUI…</p>
      <button id="hello" type="button">Say hello</button>
    </main>
    <script src="piui-panel.js"></script>
    <script src="panel.js"></script>
  </body>
</html>
`,
  );
  write(
    'ui/panel.css',
    `body { margin: 0; padding: 12px; background: var(--piui-bg-raised); color: var(--piui-text); font: 13px/1.45 var(--piui-font-ui, system-ui); }
button { padding: 4px 10px; border: 1px solid var(--piui-border); border-radius: 6px; background: var(--piui-surface-1); color: var(--piui-text); font: inherit; }
button:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 1px; }
`,
  );
  write(
    'ui/panel.js',
    `// Inline scripts are blocked in panels: keep code in files like this one.
const panel = window.piuiPanel;
const chat = document.getElementById('chat');
panel.ready.then(async () => {
  const { chat: current } = await panel.getContext();
  chat.textContent = current ? \`Chat: \${current.title}\` : 'No chat is open.';
});
panel.on('context', ({ chat: current }) => {
  chat.textContent = current ? \`Chat: \${current.title}\` : 'No chat is open.';
});
document.getElementById('hello').addEventListener('click', () => {
  panel.runCommand('hello').catch((error) => panel.showNotice(error.message, 'error'));
});
`,
  );
}
console.log(`Created ${pluginId} in ${target}.`);
console.log('Check it with `pnpm plugin:check <dir>`, then load it in PiUI: Settings → Plugins → Load unpacked….');
