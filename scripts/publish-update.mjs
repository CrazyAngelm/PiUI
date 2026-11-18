// Publishes a locally built Windows release so installed copies update themselves.
//
// `node scripts/release-build.mjs` with the updater key pair in the environment
// leaves the installer, its update signature (`…-setup.exe.sig`) and
// SHA256SUMS.txt in artifacts/. This script writes the update feed
// (latest.json) for them and, with --publish, uploads everything to the
// GitHub release vX.Y.Z and the feed to the rolling `updater` release that
// installed builds read (scripts/release-config.mjs DEFAULT_UPDATER_ENDPOINT).
//
//   node scripts/publish-update.mjs             # checks the files, writes latest.json, prints the plan
//   node scripts/publish-update.mjs --publish   # also runs the plan with `gh` (needs `gh auth login`)
//
// Options: --dir <folder> (default artifacts), --repository <owner/name>
// (default CrazyAngelm/PiUI), --channel <tag> (default PIUI_UPDATER_CHANNEL_TAG or updater).
// Nothing secret is read: the signature was made by the bundler during the build.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changelogSection, plainNotes, updaterFeed } from './release-feed.mjs';

const DEFAULT_REPOSITORY = 'CrazyAngelm/PiUI';

export class PublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishError';
  }
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

/** The `gh` commands that publish the release and refresh the update channel, in order. */
export function publishPlan({ version, files, repository, channel, notesFile, releaseExists, channelExists }) {
  const tag = `v${version}`;
  const repo = ['--repo', repository];
  const plan = [];
  if (!releaseExists) {
    plan.push(['release', 'create', tag, ...repo, '--prerelease', '--title', `Nano Desktop ${tag}`, '--notes-file', notesFile]);
  }
  plan.push(['release', 'upload', tag, ...repo, '--clobber', ...files]);
  if (!channelExists) {
    plan.push(['release', 'create', channel, ...repo, '--prerelease', '--title', 'Update channel', '--notes', 'Update feed for installed Nano Desktop builds. Download releases from their own pages.']);
  }
  plan.push(['release', 'upload', channel, ...repo, '--clobber', 'latest.json']);
  return plan;
}

function option(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new PublishError(`--${name} needs a value.`);
  return value;
}

function releaseExists(tag, repository) {
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', repository], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main(argv) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const directory = resolve(root, option(argv, 'dir', 'artifacts'));
  const repository = option(argv, 'repository', DEFAULT_REPOSITORY);
  const channel = option(argv, 'channel', process.env.PIUI_UPDATER_CHANNEL_TAG?.trim() || 'updater');
  const config = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const version = String(config.version ?? '');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new PublishError('tauri.conf.json does not contain a release version.');
  if (!existsSync(directory)) throw new PublishError(`${directory} does not exist: build the release first.`);
  const present = readdirSync(directory);
  const files = releaseFiles(present, version);

  const changelog = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  const feed = updaterFeed({
    files: present,
    signature: (name) => readFileSync(join(directory, `${name}.sig`), 'utf8'),
    version,
    tag: `v${version}`,
    repository,
    notes: plainNotes(changelog),
    pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  if (feed === null) throw new PublishError('No update signature matched an installer: latest.json was not written.');
  writeFileSync(join(directory, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);
  const notesFile = join(directory, 'release-notes.md');
  writeFileSync(notesFile, `${changelog}\n`);
  console.log(`Update feed for ${version}: ${Object.keys(feed.platforms).sort().join(', ')}`);

  const publish = argv.includes('--publish');
  const plan = publishPlan({
    version,
    files,
    repository,
    channel,
    notesFile,
    releaseExists: publish && releaseExists(`v${version}`, repository),
    channelExists: publish && releaseExists(channel, repository),
  });
  for (const command of plan) {
    console.log(`gh ${command.join(' ')}`);
    if (publish) execFileSync('gh', command, { cwd: directory, stdio: 'inherit' });
  }
  console.log(publish ? `Published ${version}; installed builds with updates find it at the ${channel} release.` : 'Plan only. Run again with --publish to upload.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof PublishError ? error.message : error);
    process.exit(1);
  }
}
