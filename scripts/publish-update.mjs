// Publishes a locally built Windows release so installed copies update themselves.
//
// `node scripts/release-build.mjs` with the updater key pair in the environment
// leaves the installer, its update signature (`…-setup.exe.sig`) and
// SHA256SUMS.txt in artifacts/. This script checks those files against the
// checksums, writes the update feed (latest.json) for exactly the files it
// uploads and, with --publish, uploads them to the GitHub release vX.Y.Z (tagged
// at this checkout's commit) and the feed to the rolling `updater` release that
// installed builds read (scripts/release-config.mjs DEFAULT_UPDATER_ENDPOINT).
//
//   node scripts/publish-update.mjs             # checks the files, writes latest.json, prints the plan
//   node scripts/publish-update.mjs --publish   # also runs the plan with `gh` (needs `gh auth login`)
//
// Options: --dir <folder> (default artifacts), --repository <owner/name>
// (default CrazyAngelm/PiUI), --channel <tag> (default PIUI_UPDATER_CHANNEL_TAG or updater),
// --drop-platforms to replace a feed that also lists platforms this build does not have.
// Nothing secret is read, and `gh` runs without the signing variables in its environment.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { changelogSection, plainNotes, updaterFeed } from './release-feed.mjs';

const DEFAULT_REPOSITORY = 'CrazyAngelm/PiUI';
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class PublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishError';
  }
}

/** The command line, strictly: an unknown or malformed option stops before anything is published. */
export function publishOptions(argv, env = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        dir: { type: 'string' },
        repository: { type: 'string' },
        channel: { type: 'string' },
        publish: { type: 'boolean' },
        'drop-platforms': { type: 'boolean' },
      },
    }).values;
  } catch (error) {
    throw new PublishError(error instanceof Error ? error.message : String(error));
  }
  const repository = parsed.repository ?? DEFAULT_REPOSITORY;
  const channel = parsed.channel ?? (env.PIUI_UPDATER_CHANNEL_TAG?.trim() || 'updater');
  if (!REPOSITORY.test(repository)) throw new PublishError(`--repository must be owner/name, not "${repository}".`);
  if (!CHANNEL.test(channel) || /^v\d/.test(channel)) throw new PublishError(`--channel "${channel}" is not a channel tag.`);
  return { dir: parsed.dir ?? 'artifacts', repository, channel, publish: Boolean(parsed.publish), dropPlatforms: Boolean(parsed['drop-platforms']) };
}

/** The files of version `version` in `files` that a release carries, or why it cannot be published. */
export function releaseFiles(files, version) {
  const installer = `NanoDesktop_${version}_x64-setup.exe`;
  if (!files.includes(installer)) throw new PublishError(`${installer} is missing: build the release first.`);
  if (!files.includes(`${installer}.sig`)) {
    throw new PublishError(`${installer}.sig is missing: the build had no updater key pair (see docs/RELEASING.md, "Signed automatic updates").`);
  }
  if (!files.includes('SHA256SUMS.txt')) throw new PublishError('SHA256SUMS.txt is missing: build the release with scripts/release-build.mjs.');
  const own = files.filter((name) => name.startsWith(`NanoDesktop_${version}_`) || name === 'SHA256SUMS.txt');
  return [...own.sort(), 'latest.json'];
}

/** Every uploaded file the checksum list names must match it, and every built program must be named. */
export function checkChecksums(sums, files, hashOf) {
  const listed = new Map();
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (match) listed.set(match[2], match[1].toLowerCase());
  }
  for (const name of files) {
    if (name === 'SHA256SUMS.txt' || name === 'latest.json' || name.endsWith('.sig')) continue;
    const expected = listed.get(name);
    if (!expected) throw new PublishError(`${name} is not in SHA256SUMS.txt: rebuild the release.`);
    if (hashOf(name) !== expected) throw new PublishError(`${name} does not match SHA256SUMS.txt: it changed after the build.`);
  }
}

/** A feed for one build replaces the channel's feed only when it keeps every platform that feed serves. */
export function checkFeedPlatforms(current, next, dropPlatforms) {
  if (!current || typeof current.platforms !== 'object' || current.platforms === null) return;
  const lost = Object.keys(current.platforms).filter((key) => !(key in next.platforms)).sort();
  if (lost.length && !dropPlatforms) {
    throw new PublishError(
      `The update feed also serves ${lost.join(', ')}, which this build does not have: installed copies there would stop finding updates. ` +
        'Publish those builds together, or pass --drop-platforms to replace the feed anyway.',
    );
  }
}

/** The `gh` commands that publish the release and refresh the update channel, in order. */
export function publishPlan({ version, files, repository, channel, notesFile, commit, releaseExists, channelExists }) {
  const tag = `v${version}`;
  const repo = ['--repo', repository];
  const plan = [];
  if (!releaseExists) {
    plan.push(['release', 'create', tag, ...repo, '--target', commit, '--prerelease', '--title', `Nano Desktop ${tag}`, '--notes-file', notesFile]);
  }
  plan.push(['release', 'upload', tag, ...repo, '--clobber', ...files]);
  if (!channelExists) {
    plan.push(['release', 'create', channel, ...repo, '--target', commit, '--prerelease', '--title', 'Update channel', '--notes', 'Update feed for installed Nano Desktop builds. Download releases from their own pages.']);
  }
  plan.push(['release', 'upload', channel, ...repo, '--clobber', 'latest.json']);
  return plan;
}

/** `gh` resolved to an absolute path, never from the artifacts folder or the current directory. */
function findGh() {
  const lookup = process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), ['gh']] : ['/usr/bin/which', ['gh']];
  let found = '';
  try {
    found = execFileSync(lookup[0], lookup[1], { cwd: process.env.SystemRoot ?? '/', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new PublishError('GitHub CLI (gh) was not found on PATH.');
  }
  const path = found.split(/\r?\n/).map((line) => line.trim()).find((line) => isAbsolute(line) && (process.platform !== 'win32' || /\.exe$/i.test(line)));
  if (!path) throw new PublishError('GitHub CLI (gh) was not found on PATH.');
  return path;
}

/** The environment for `gh`: the shell's, without the updater signing key and its password. */
function ghEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^TAURI_SIGNING_/i.test(name)));
}

function main(argv) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const options = publishOptions(argv, process.env);
  const directory = resolve(root, options.dir);
  const config = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const version = String(config.version ?? '');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new PublishError('tauri.conf.json does not contain a release version.');
  if (!existsSync(directory)) throw new PublishError(`${directory} does not exist: build the release first.`);
  const files = releaseFiles(readdirSync(directory), version);
  checkChecksums(readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8'), files, (name) => createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'));

  const tag = `v${version}`;
  const changelog = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  // The feed lists only what this run uploads, so every address in it exists on the release.
  const feed = updaterFeed({
    files: files.filter((name) => name !== 'latest.json'),
    signature: (name) => readFileSync(join(directory, `${name}.sig`), 'utf8'),
    version,
    tag,
    repository: options.repository,
    notes: plainNotes(changelog),
    pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  if (feed === null) throw new PublishError('No update signature matched an installer: latest.json was not written.');
  writeFileSync(join(directory, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);
  const notesFile = join(directory, 'release-notes.md');
  writeFileSync(notesFile, `${changelog}\n`);
  console.log(`Update feed for ${version}: ${Object.keys(feed.platforms).sort().join(', ')}`);

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const gh = options.publish ? findGh() : 'gh';
  const env = ghEnvironment();
  const run = (args, extra = {}) => execFileSync(gh, args, { cwd: directory, env, ...extra });
  const exists = (release) => {
    try {
      run(['release', 'view', release, '--repo', options.repository], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };

  let releaseExists = false;
  let channelExists = false;
  if (options.publish) {
    releaseExists = exists(tag);
    channelExists = exists(options.channel);
    if (releaseExists) {
      // Re-publishing is for the same build only: the tag must point at this checkout's commit.
      const tagged = String(run(['api', `repos/${options.repository}/commits/${tag}`, '--jq', '.sha'], { encoding: 'utf8' })).trim();
      if (tagged !== commit) throw new PublishError(`${tag} is tagged at ${tagged.slice(0, 12)}, not at this checkout (${commit.slice(0, 12)}): nothing was uploaded.`);
    }
    if (channelExists) {
      let current;
      try {
        current = JSON.parse(String(run(['release', 'download', options.channel, '--repo', options.repository, '--pattern', 'latest.json', '--output', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })));
      } catch {
        current = undefined;
      }
      checkFeedPlatforms(current, feed, options.dropPlatforms);
    }
  }

  const plan = publishPlan({ version, files, repository: options.repository, channel: options.channel, notesFile, commit, releaseExists, channelExists });
  for (const command of plan) {
    console.log(`gh ${command.join(' ')}`);
    if (options.publish) run(command, { stdio: 'inherit' });
  }
  console.log(options.publish ? `Published ${version}; installed builds with updates find it at the ${options.channel} release.` : 'Plan only. Run again with --publish to upload.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof PublishError ? error.message : error);
    process.exit(1);
  }
}
