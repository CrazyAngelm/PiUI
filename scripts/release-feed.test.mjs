import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changelogSection, plainNotes, platformKeys, releaseNotes, updaterFeed } from './release-feed.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

## [1.2.0] - 2026-10-01

### Chat

- Added **bold** things and \`code\`.

## [1.1.0] - 2026-09-01

- Older.

[1.2.0]: https://example.test/compare
`;

test('extracts one changelog section, including the real 0.2.0 entry', () => {
  assert.equal(changelogSection(CHANGELOG, '1.2.0'), '### Chat\n\n- Added **bold** things and `code`.');
  assert.equal(changelogSection(CHANGELOG, '1.1.0'), '- Older.');
  assert.throws(() => changelogSection(CHANGELOG, '1.3.0'), /no section for 1\.3\.0/);
  const real = changelogSection(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), '0.2.0');
  assert.match(real, /Signed automatic updates/);
  assert.doesNotMatch(real, /## \[0\.1\.1\]/);
});

test('in-app notes drop Markdown decoration but keep bullets', () => {
  assert.equal(plainNotes('### Chat\n\n\n\n- Added **bold** things and `code`.'), 'Chat\n\n- Added bold things and code.');
});

test('maps release files to updater platforms', () => {
  assert.deepEqual(platformKeys('PiUI_0.2.0_x64-setup.exe'), ['windows-x86_64', 'windows-x86_64-nsis']);
  assert.deepEqual(platformKeys('PiUI_0.2.0_amd64.AppImage'), ['linux-x86_64-appimage']);
  assert.deepEqual(platformKeys('PiUI_0.2.0_amd64.deb'), ['linux-x86_64-deb']);
  assert.equal(platformKeys('PiUI_0.2.0_universal.app.tar.gz').length, 4);
  for (const name of ['PiUI_0.2.0_windows_x86_64.exe', 'PiUI_0.2.0_universal.dmg', 'SHA256SUMS.txt']) {
    assert.deepEqual(platformKeys(name), [], name);
  }
});

const RELEASE_FILES = [
  'PiUI_0.2.0_amd64.AppImage',
  'PiUI_0.2.0_amd64.AppImage.sig',
  'PiUI_0.2.0_amd64.deb',
  'PiUI_0.2.0_universal.dmg',
  'PiUI_0.2.0_windows_x86_64.exe',
  'PiUI_0.2.0_x64-setup.exe',
  'PiUI_0.2.0_x64-setup.exe.sig',
  'SHA256SUMS.txt',
];

test('the update feed lists only signed artifacts with release URLs', () => {
  const feed = updaterFeed({
    files: RELEASE_FILES,
    signature: (name) => `signature of ${name}\n`,
    version: '0.2.0',
    tag: 'v0.2.0',
    repository: 'example/piui',
    notes: 'Notes',
    pubDate: '2026-09-27T12:00:00Z',
  });
  assert.deepEqual(feed, {
    version: '0.2.0',
    notes: 'Notes',
    pub_date: '2026-09-27T12:00:00Z',
    platforms: {
      'linux-x86_64-appimage': {
        signature: 'signature of PiUI_0.2.0_amd64.AppImage',
        url: 'https://github.com/example/piui/releases/download/v0.2.0/PiUI_0.2.0_amd64.AppImage',
      },
      'windows-x86_64': {
        signature: 'signature of PiUI_0.2.0_x64-setup.exe',
        url: 'https://github.com/example/piui/releases/download/v0.2.0/PiUI_0.2.0_x64-setup.exe',
      },
      'windows-x86_64-nsis': {
        signature: 'signature of PiUI_0.2.0_x64-setup.exe',
        url: 'https://github.com/example/piui/releases/download/v0.2.0/PiUI_0.2.0_x64-setup.exe',
      },
    },
  });
  const unsigned = RELEASE_FILES.filter((name) => !name.endsWith('.sig'));
  assert.equal(updaterFeed({ files: unsigned, signature: () => '', version: '0.2.0', tag: 'v0.2.0', repository: 'example/piui', notes: '', pubDate: '' }), null);
  assert.throws(
    () =>
      updaterFeed({
        files: ['A_amd64.deb', 'A_amd64.deb.sig', 'B_amd64.deb', 'B_amd64.deb.sig'],
        signature: () => 'x',
        version: '0.2.0',
        tag: 'v0.2.0',
        repository: 'example/piui',
        notes: '',
        pubDate: '',
      }),
    /Two release files claim/,
  );
});

test('release notes describe every platform, signing and the update feed honestly', () => {
  const unsigned = releaseNotes({ files: RELEASE_FILES, tag: 'v0.2.0', version: '0.2.0', windowsSigning: 'unsigned', feed: false, changelog: '- Change.' });
  assert.match(unsigned, /Not code-signed yet/);
  assert.match(unsigned, /`PiUI_0\.2\.0_x64-setup\.exe`<br>`PiUI_0\.2\.0_windows_x86_64\.exe`/);
  assert.match(unsigned, /Experimental: ad-hoc signed and not notarized/);
  assert.match(unsigned, /This release has no update feed/);
  assert.match(unsigned, /Claude subscription login/);
  assert.doesNotMatch(unsigned, /Pi sessions only/);
  assert.match(unsigned, /## What changed\n\n- Change\.\n$/);
  const signed = releaseNotes({
    files: RELEASE_FILES.filter((name) => !name.endsWith('.dmg')),
    tag: 'v0.2.0',
    version: '0.2.0',
    windowsSigning: 'signed',
    feed: true,
    changelog: '',
  });
  assert.match(signed, /Authenticode-signed\./);
  assert.match(signed, /\| macOS \(Apple Silicon and Intel\) \| — \| Not built for this release\. \|/);
  assert.match(signed, /publishes a signed update feed/);
});
