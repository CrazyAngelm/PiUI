import test from 'node:test';
import assert from 'node:assert/strict';
import { PublishError, publishPlan, releaseFiles } from './publish-update.mjs';

const BUILT = [
  'NanoDesktop_0.3.6_x64-setup.exe',
  'NanoDesktop_0.3.6_x64-setup.exe.sig',
  'NanoDesktop_0.3.6_windows_x86_64.exe',
  'SHA256SUMS.txt',
  'NanoDesktop_0.3.5_x64-setup.exe',
];

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

test('the plan creates missing releases and always refreshes the update channel last', () => {
  const files = releaseFiles(BUILT, '0.3.6');
  const fresh = publishPlan({ version: '0.3.6', files, repository: 'o/r', channel: 'updater', notesFile: 'notes.md', releaseExists: false, channelExists: false });
  assert.deepEqual(fresh.map((command) => command.slice(0, 3)), [
    ['release', 'create', 'v0.3.6'],
    ['release', 'upload', 'v0.3.6'],
    ['release', 'create', 'updater'],
    ['release', 'upload', 'updater'],
  ]);
  assert.ok(fresh[0].includes('--prerelease'));
  assert.deepEqual(fresh.at(-1).slice(-2), ['--clobber', 'latest.json']);
  const again = publishPlan({ version: '0.3.6', files, repository: 'o/r', channel: 'updater', notesFile: 'notes.md', releaseExists: true, channelExists: true });
  assert.deepEqual(again.map((command) => command[1]), ['upload', 'upload']);
});
