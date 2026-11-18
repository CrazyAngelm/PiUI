import test from 'node:test';
import assert from 'node:assert/strict';
import { PublishError, checkChecksums, checkFeedPlatforms, publishOptions, publishPlan, releaseFiles } from './publish-update.mjs';

const BUILT = [
  'NanoDesktop_0.3.6_x64-setup.exe',
  'NanoDesktop_0.3.6_x64-setup.exe.sig',
  'NanoDesktop_0.3.6_windows_x86_64.exe',
  'SHA256SUMS.txt',
  'NanoDesktop_0.3.5_x64-setup.exe',
];
const COMMIT = 'a'.repeat(40);

test('a release carries the files of its own version, the checksums and the feed', () => {
  assert.deepEqual(releaseFiles(BUILT, '0.3.6'), [
    'NanoDesktop_0.3.6_windows_x86_64.exe',
    'NanoDesktop_0.3.6_x64-setup.exe',
    'NanoDesktop_0.3.6_x64-setup.exe.sig',
    'SHA256SUMS.txt',
    'latest.json',
  ]);
});

test('a build without an update signature is refused before anything is published', () => {
  const unsigned = BUILT.filter((name) => !name.endsWith('.sig'));
  assert.throws(() => releaseFiles(unsigned, '0.3.6'), (error) => error instanceof PublishError && /\.sig is missing/.test(error.message));
  assert.throws(() => releaseFiles(BUILT, '0.3.7'), PublishError);
});

test('options are parsed strictly, so a mistyped target never falls back to the default release', () => {
  assert.deepEqual(publishOptions([], {}), { dir: 'artifacts', repository: 'CrazyAngelm/PiUI', channel: 'updater', publish: false, dropPlatforms: false });
  assert.equal(publishOptions(['--channel=beta', '--repository=me/fork'], {}).channel, 'beta');
  assert.equal(publishOptions(['--channel=beta', '--repository=me/fork'], {}).repository, 'me/fork');
  assert.equal(publishOptions([], { PIUI_UPDATER_CHANNEL_TAG: ' nightly ' }).channel, 'nightly');
  assert.throws(() => publishOptions(['--chanel', 'beta'], {}), PublishError);
  assert.throws(() => publishOptions(['--channel'], {}), PublishError);
  assert.throws(() => publishOptions(['--repository', 'not a repo'], {}), PublishError);
  assert.throws(() => publishOptions(['--channel', 'v0.3.6'], {}), PublishError);
});

test('every uploaded program must match the checksums of its build', () => {
  const files = releaseFiles(BUILT, '0.3.6');
  const sums = ['1'.repeat(64), '2'.repeat(64)].map((hash, index) => `${hash}  ${files[index]}`).join('\n');
  const hashes = { [files[0]]: '1'.repeat(64), [files[1]]: '2'.repeat(64) };
  assert.doesNotThrow(() => checkChecksums(sums, files, (name) => hashes[name]));
  assert.throws(() => checkChecksums(sums, files, (name) => (name === files[1] ? '3'.repeat(64) : hashes[name])), /does not match/);
  assert.throws(() => checkChecksums(sums.split('\n')[0], files, (name) => hashes[name]), /not in SHA256SUMS/);
});

test('a Windows-only feed does not silently take the update channel from other platforms', () => {
  const next = { platforms: { 'windows-x86_64': {}, 'windows-x86_64-nsis': {} } };
  assert.doesNotThrow(() => checkFeedPlatforms(undefined, next, false));
  assert.doesNotThrow(() => checkFeedPlatforms({ platforms: { 'windows-x86_64': {} } }, next, false));
  const mixed = { platforms: { 'windows-x86_64': {}, 'linux-x86_64': {} } };
  assert.throws(() => checkFeedPlatforms(mixed, next, false), /linux-x86_64/);
  assert.doesNotThrow(() => checkFeedPlatforms(mixed, next, true));
});

test('the plan tags new releases at this commit and always refreshes the update channel last', () => {
  const files = releaseFiles(BUILT, '0.3.6');
  const fresh = publishPlan({ version: '0.3.6', files, repository: 'o/r', channel: 'updater', notesFile: 'notes.md', commit: COMMIT, releaseExists: false, channelExists: false });
  assert.deepEqual(fresh.map((command) => command.slice(0, 3)), [
    ['release', 'create', 'v0.3.6'],
    ['release', 'upload', 'v0.3.6'],
    ['release', 'create', 'updater'],
    ['release', 'upload', 'updater'],
  ]);
  assert.ok(fresh[0].includes('--prerelease'));
  assert.equal(fresh[0][fresh[0].indexOf('--target') + 1], COMMIT);
  assert.deepEqual(fresh.at(-1).slice(-2), ['--clobber', 'latest.json']);
  const again = publishPlan({ version: '0.3.6', files, repository: 'o/r', channel: 'updater', notesFile: 'notes.md', commit: COMMIT, releaseExists: true, channelExists: true });
  assert.deepEqual(again.map((command) => command[1]), ['upload', 'upload']);
});
