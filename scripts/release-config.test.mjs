import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releasePlan } from './release-build.mjs';
import { ReleaseConfigError, isTauriPublicKey, releaseConfig, writeReleaseConfig } from './release-config.mjs';

// minisign's published test public key (from minisign-verify's tests), in the
// Tauri encoding. No signing key is created or stored by these tests.
const PUBLIC_KEY = Buffer.from(
  'untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n',
).toString('base64');
const PRIVATE_KEY_MARKER = 'placeholder-private-key-value';
const UPDATER = {
  PIUI_UPDATER_PUBKEY: PUBLIC_KEY,
  PIUI_UPDATER_ENDPOINT: 'https://github.com/example/piui/releases/download/updater/latest.json',
  TAURI_SIGNING_PRIVATE_KEY: PRIVATE_KEY_MARKER,
};
const AZURE = {
  PIUI_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net/',
  PIUI_AZURE_SIGNING_ACCOUNT: 'piui-signing',
  PIUI_AZURE_SIGNING_PROFILE: 'piui-public',
  AZURE_CLIENT_ID: 'client',
  AZURE_CLIENT_SECRET: 'placeholder-client-secret',
  AZURE_TENANT_ID: 'tenant',
};

test('without release variables the build stays the plain unsigned build', () => {
  for (const platform of ['windows', 'linux', 'macos']) {
    const result = releaseConfig({ TAURI_SIGNING_PRIVATE_KEY: '   ' }, platform);
    assert.equal(result.config, null);
    assert.equal(result.updater, false);
    assert.equal(result.windowsSigning, null);
    assert.ok(result.notices.some((notice) => notice.startsWith('Updates: off')));
  }
  assert.ok(releaseConfig({}, 'windows').notices.some((notice) => notice.startsWith('Windows signing: off')));
});

test('a complete updater setup adds the public key, endpoints and updater artifacts', () => {
  const result = releaseConfig({ ...UPDATER, PIUI_UPDATER_ENDPOINT: `${UPDATER.PIUI_UPDATER_ENDPOINT}, https://mirror.example.test/latest.json` }, 'linux');
  assert.equal(result.updater, true);
  assert.deepEqual(result.config, {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: PUBLIC_KEY,
        endpoints: [UPDATER.PIUI_UPDATER_ENDPOINT, 'https://mirror.example.test/latest.json'],
        windows: { installMode: 'passive' },
      },
    },
  });
  assert.ok(result.notices.includes('Updates: on (feed github.com); the bundler signs the updater artifacts.'));
});

test('a partial updater setup skips updater artifacts and names what is missing', () => {
  const withoutKey = releaseConfig({ ...UPDATER, TAURI_SIGNING_PRIVATE_KEY: '' }, 'windows');
  assert.equal(withoutKey.updater, false);
  assert.equal(withoutKey.config, null);
  assert.ok(withoutKey.notices.some((notice) => notice.includes('TAURI_SIGNING_PRIVATE_KEY not set')));
  const keyOnly = releaseConfig({ TAURI_SIGNING_PRIVATE_KEY: PRIVATE_KEY_MARKER }, 'windows');
  assert.equal(keyOnly.updater, false);
  assert.ok(keyOnly.notices.some((notice) => notice.includes('PIUI_UPDATER_PUBKEY, PIUI_UPDATER_ENDPOINT not set')));
});

test('invalid updater values fail instead of shipping silently', () => {
  for (const env of [
    { ...UPDATER, PIUI_UPDATER_PUBKEY: 'not-a-key' },
    { ...UPDATER, PIUI_UPDATER_PUBKEY: Buffer.from('untrusted comment: note\nRWQ\n').toString('base64') },
    { ...UPDATER, PIUI_UPDATER_ENDPOINT: 'http://github.com/latest.json' },
    { ...UPDATER, PIUI_UPDATER_ENDPOINT: 'https://user:pass@example.test/latest.json' },
    { ...UPDATER, PIUI_UPDATER_ENDPOINT: 'latest.json' },
    { PIUI_UPDATER_ENDPOINT: 'ftp://example.test/latest.json' },
  ]) {
    assert.throws(() => releaseConfig(env, 'windows'), ReleaseConfigError);
  }
  assert.throws(() => releaseConfig({}, 'freebsd'), ReleaseConfigError);
  assert.equal(isTauriPublicKey(PUBLIC_KEY), true);
  assert.equal(isTauriPublicKey(`${PUBLIC_KEY}\n`), false);
});

test('a certificate thumbprint signs Windows builds only', () => {
  const env = { PIUI_WINDOWS_CERTIFICATE_THUMBPRINT: 'ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01' };
  const windows = releaseConfig(env, 'windows');
  assert.equal(windows.windowsSigning, 'certificate');
  assert.deepEqual(windows.config, {
    bundle: {
      windows: {
        certificateThumbprint: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
        digestAlgorithm: 'sha256',
        timestampUrl: 'http://timestamp.digicert.com',
        tsp: true,
      },
    },
  });
  assert.equal(releaseConfig(env, 'linux').config, null);
  assert.throws(() => releaseConfig({ PIUI_WINDOWS_CERTIFICATE_THUMBPRINT: 'abc' }, 'windows'), ReleaseConfigError);
  assert.throws(
    () => releaseConfig({ ...env, PIUI_WINDOWS_TIMESTAMP_URL: 'javascript:alert(1)' }, 'windows'),
    ReleaseConfigError,
  );
});

test('Azure Artifact Signing needs every setting and cannot be combined with a certificate', () => {
  const result = releaseConfig({ ...AZURE, ...UPDATER }, 'windows');
  assert.equal(result.windowsSigning, 'azure');
  assert.deepEqual(result.config.bundle, {
    createUpdaterArtifacts: true,
    windows: {
      signCommand: {
        cmd: 'artifact-signing-cli',
        args: ['-e', AZURE.PIUI_AZURE_SIGNING_ENDPOINT, '-a', 'piui-signing', '-c', 'piui-public', '%1'],
      },
    },
  });
  assert.throws(() => releaseConfig({ ...AZURE, AZURE_CLIENT_SECRET: '' }, 'windows'), /AZURE_CLIENT_SECRET/);
  assert.throws(() => releaseConfig({ ...AZURE, PIUI_AZURE_SIGNING_PROFILE: 'bad profile' }, 'windows'), ReleaseConfigError);
  assert.throws(
    () => releaseConfig({ ...AZURE, PIUI_WINDOWS_CERTIFICATE_THUMBPRINT: 'AB'.repeat(20) }, 'windows'),
    /Choose one Windows signing method/,
  );
});

test('secret values never reach the notices or the written fragment', () => {
  const root = mkdtempSync(join(tmpdir(), 'piui-release-config-'));
  try {
    const result = writeReleaseConfig(root, { ...UPDATER, ...AZURE, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'placeholder-password' }, 'windows');
    const written = readFileSync(result.path, 'utf8');
    assert.equal(result.path, join(root, 'target', 'release-config', 'tauri.release.conf.json'));
    for (const secret of [PRIVATE_KEY_MARKER, 'placeholder-password', AZURE.AZURE_CLIENT_SECRET]) {
      assert.ok(!written.includes(secret), secret);
      assert.ok(!result.notices.join('\n').includes(secret), secret);
    }
    assert.deepEqual(JSON.parse(written), result.config);
    assert.equal(writeReleaseConfig(root, {}, 'linux').path, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the release build plan adds the fragment and the signature check only when configured', () => {
  const root = join('repo');
  const plan = (platform, options = {}) =>
    releasePlan(root, platform, { tauriCli: 'tauri.js', node: 'node', ...options }).map((step) => step.command.join(' '));
  const windowsCollect = `powershell -NoProfile -ExecutionPolicy Bypass -File ${join(root, 'scripts', 'prepare-windows-release.ps1')}`;
  assert.deepEqual(plan('windows'), ['node tauri.js build --ci --bundles nsis', windowsCollect]);
  assert.deepEqual(plan('windows', { configPath: 'fragment.json', windowsSigning: true }), [
    'node tauri.js build --ci --bundles nsis --config fragment.json',
    `${windowsCollect} -RequireSignature`,
  ]);
  assert.deepEqual(plan('linux'), [
    'node tauri.js build --ci --bundles deb,appimage',
    `node ${join(root, 'scripts', 'prepare-release-artifacts.mjs')} linux`,
  ]);
  assert.deepEqual(plan('macos', { configPath: 'fragment.json' }), [
    'node tauri.js build --ci --bundles app,dmg --target universal-apple-darwin --config fragment.json',
    `node ${join(root, 'scripts', 'prepare-release-artifacts.mjs')} macos`,
  ]);
  assert.equal(releasePlan(root, 'linux', { tauriCli: 'tauri.js' })[0].cwd, join(root, 'apps', 'desktop'));
});
