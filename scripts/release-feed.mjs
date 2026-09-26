// Release text and the signed update feed, from the files a release build
// produced. Used by .github/workflows/release.yml; runs anywhere with Node.
//
//   node scripts/release-feed.mjs notes --version 0.2.0
//       prints the CHANGELOG.md section of a version
//   node scripts/release-feed.mjs feed --dir release --tag v0.2.0 --repository owner/name --out release/latest.json
//       writes the Tauri updater feed when update signatures (*.sig) exist
//   node scripts/release-feed.mjs release-notes --dir release --tag v0.2.0 --windows-signing signed|unsigned --out notes.md
//       writes the GitHub release description
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The body of `## [version]` in a Keep a Changelog file, without its heading. */
export function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\](?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  const end = lines.findIndex((line, index) => index > start && (/^## \[/.test(line) || /^\[[^\]]+\]: /.test(line)));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

/** Markdown → readable plain text for the in-app notes (shown as plain text). */
export function plainNotes(markdown) {
  return markdown
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Updater platform keys for one release file name (see tauri-plugin-updater). */
export function platformKeys(name) {
  if (/_x64-setup\.exe$/.test(name)) return ['windows-x86_64', 'windows-x86_64-nsis'];
  if (/_amd64\.AppImage$/.test(name)) return ['linux-x86_64-appimage'];
  if (/_amd64\.deb$/.test(name)) return ['linux-x86_64-deb'];
  if (/_universal\.app\.tar\.gz$/.test(name)) return ['darwin-x86_64', 'darwin-aarch64', 'darwin-x86_64-app', 'darwin-aarch64-app'];
  return [];
}

/**
 * The static Tauri updater feed, or null when no file has an update signature.
 * `files` are release file names; `signature(name)` reads `<name>.sig`.
 */
export function updaterFeed({ files, signature, version, tag, repository, notes, pubDate }) {
  const platforms = {};
  for (const name of [...files].sort()) {
    if (!files.includes(`${name}.sig`)) continue;
    const keys = platformKeys(name);
    if (keys.length === 0) continue;
    const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    const entry = { signature: signature(name).trim(), url };
    for (const key of keys) {
      if (platforms[key]) throw new Error(`Two release files claim the updater platform ${key}.`);
      platforms[key] = entry;
    }
  }
  if (Object.keys(platforms).length === 0) return null;
  return { version, notes, pub_date: pubDate, platforms };
}

const PLATFORM_ROWS = [
  {
    system: 'Windows 10/11 x64',
    pattern: /(_x64-setup\.exe|_windows_x86_64\.exe)$/,
    note: (context) =>
      `Primary, verified platform. Installer and portable executable. ${context.windowsSigning === 'signed' ? 'Authenticode-signed.' : 'Not code-signed yet: Windows SmartScreen may warn about an unknown publisher.'}`,
  },
  {
    system: 'Linux x64',
    pattern: /_amd64\.(deb|AppImage)$/,
    note: () => 'Builds in CI; native agent lifecycle containment is not yet verified on Linux, so harnesses show as not verified there.',
  },
  {
    system: 'macOS (Apple Silicon and Intel)',
    pattern: /_universal\.dmg$/,
    note: () => 'Experimental: ad-hoc signed and not notarized. Open it with right-click → Open the first time.',
  },
];

export function releaseNotes({ files, tag, version, windowsSigning, feed, changelog }) {
  // Installers and packages first, then portable files.
  const rank = (name) => (/(-setup\.exe|\.deb|\.dmg)$/.test(name) ? 0 : 1);
  const rows = PLATFORM_ROWS.map((row) => {
    const names = files.filter((name) => row.pattern.test(name)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return names.length === 0
      ? `| ${row.system} | — | Not built for this release. |`
      : `| ${row.system} | ${names.map((name) => `\`${name}\``).join('<br>')} | ${row.note({ windowsSigning })} |`;
  });
  return `PiUI ${tag} — a desktop workbench for native agent harnesses (Codex, Claude Code, Pi, Hermes, Prime Agent) and multi-agent pipelines. Developer preview.

| System | Files | Status |
| --- | --- | --- |
${rows.join('\n')}

## Before you install

1. Install at least one harness and sign in with its own tool: Codex, Claude Code, Pi, Hermes or Prime Agent. PiUI never asks for or stores credentials. Claude Code runs only with a Claude subscription login (\`claude\` → \`/login\`).
2. Verify your download against \`SHA256SUMS.txt\`:
   - Windows (PowerShell): \`Get-FileHash .\\PiUI_${version}_x64-setup.exe -Algorithm SHA256\` and compare with the matching line of \`SHA256SUMS.txt\`.
   - Linux and macOS: \`sha256sum --check --ignore-missing SHA256SUMS.txt\` (macOS: \`shasum -a 256 --check --ignore-missing SHA256SUMS.txt\`).
3. Do not write to the same session from PiUI and the harness CLI at the same time.

## Updates

${
  feed
    ? 'This release publishes a signed update feed. Installed builds can check for updates in Settings → About; "Check for updates automatically" is off until you turn it on. PiUI installs an update only after its signature matches the key built into your version.'
    : 'This release has no update feed. Install newer versions manually over this one; your chats, pipelines and settings stay in place.'
}

## What changed

${changelog}
`;
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} is required.`);
  return value;
}

function main(argv) {
  const [command, ...rest] = argv;
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const changelog = () => readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  if (command === 'notes') {
    process.stdout.write(`${changelogSection(changelog(), option(rest, 'version'))}\n`);
    return;
  }
  const directory = resolve(option(rest, 'dir'));
  const tag = option(rest, 'tag');
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`"${tag}" is not a release tag.`);
  const version = tag.slice(1);
  const files = readdirSync(directory).filter((name) => name !== 'latest.json');
  if (command === 'feed') {
    const feed = updaterFeed({
      files,
      signature: (name) => readFileSync(join(directory, `${name}.sig`), 'utf8'),
      version,
      tag,
      repository: option(rest, 'repository'),
      notes: plainNotes(changelogSection(changelog(), version)),
      pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    if (feed === null) {
      console.log('No update signatures (*.sig) in this release: the update feed is skipped.');
      return;
    }
    writeFileSync(resolve(option(rest, 'out')), `${JSON.stringify(feed, null, 2)}\n`);
    console.log(`Update feed for ${version}: ${Object.keys(feed.platforms).sort().join(', ')}`);
    return;
  }
  if (command === 'release-notes') {
    const windowsSigning = option(rest, 'windows-signing');
    if (windowsSigning !== 'signed' && windowsSigning !== 'unsigned') throw new Error('--windows-signing must be signed or unsigned.');
    const notes = releaseNotes({
      files,
      tag,
      version,
      windowsSigning,
      feed: existsSync(join(directory, 'latest.json')),
      changelog: changelogSection(changelog(), version),
    });
    writeFileSync(resolve(option(rest, 'out')), notes);
    return;
  }
  throw new Error('Usage: node scripts/release-feed.mjs <notes|feed|release-notes> …');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
