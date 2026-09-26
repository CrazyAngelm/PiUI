// Turns release environment variables into a Tauri config fragment for
// `tauri build --config`. Without any of them the build is exactly the
// unsigned local build: no fragment, no updater, no code signing.
//
// Signed updates (all three are required; otherwise updates stay off):
//   PIUI_UPDATER_PUBKEY        contents of the `.key.pub` file from `pnpm tauri signer generate`
//   PIUI_UPDATER_ENDPOINT      HTTPS URL of latest.json (several: separate with spaces or commas)
//   TAURI_SIGNING_PRIVATE_KEY  the private key; read by the Tauri CLI, only checked for presence here
//                              (TAURI_SIGNING_PRIVATE_KEY_PASSWORD when the key has a password)
// Windows Authenticode (one of):
//   PIUI_WINDOWS_CERTIFICATE_THUMBPRINT  SHA-1 thumbprint of a certificate in the Windows store
//   PIUI_AZURE_SIGNING_ENDPOINT, PIUI_AZURE_SIGNING_ACCOUNT, PIUI_AZURE_SIGNING_PROFILE
//                              Azure Artifact Signing (formerly Trusted Signing) through
//                              `artifact-signing-cli`; it reads
//                              AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_TENANT_ID itself
//   PIUI_WINDOWS_TIMESTAMP_URL           RFC 3161 timestamp server (default DigiCert)
//
// Secret values are never printed or written; the fragment holds only the
// public key, endpoints and signing settings.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLATFORMS = ['windows', 'linux', 'macos'];
const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com';
const MAX_ENDPOINTS = 8;

export class ReleaseConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseConfigError';
  }
}

function value(env, name) {
  const text = env[name];
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined;
}

/** A minisign public key in the Tauri encoding: base64 of the `.pub` file. */
export function isTauriPublicKey(text) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length > 4096) return false;
  const decoded = Buffer.from(text, 'base64');
  if (decoded.toString('base64') !== text) return false;
  const lines = decoded.toString('utf8').split(/\r?\n/).filter((line) => line !== '');
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment:')) return false;
  const key = Buffer.from(lines[1], 'base64');
  return key.length === 42 && key.subarray(0, 2).toString('latin1') === 'Ed' && key.toString('base64') === lines[1];
}

function endpoints(text) {
  const urls = text.split(/[\s,]+/).filter(Boolean);
  if (urls.length === 0 || urls.length > MAX_ENDPOINTS) {
    throw new ReleaseConfigError(`PIUI_UPDATER_ENDPOINT needs one to ${MAX_ENDPOINTS} HTTPS URLs.`);
  }
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ReleaseConfigError('PIUI_UPDATER_ENDPOINT contains a value that is not a URL.');
    }
    if (parsed.protocol !== 'https:' || parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') {
      throw new ReleaseConfigError('PIUI_UPDATER_ENDPOINT must use https:// with a host and no credentials.');
    }
  }
  return urls;
}

function updaterSection(env, notices) {
  const pubkey = value(env, 'PIUI_UPDATER_PUBKEY');
  const endpoint = value(env, 'PIUI_UPDATER_ENDPOINT');
  const privateKey = value(env, 'TAURI_SIGNING_PRIVATE_KEY') ?? value(env, 'TAURI_SIGNING_PRIVATE_KEY_PATH');
  if (pubkey === undefined && endpoint === undefined && privateKey === undefined) {
    notices.push('Updates: off (no updater key configured). The build never checks for updates.');
    return undefined;
  }
  // Validate whatever was provided, so a typo never ships silently.
  if (pubkey !== undefined && !isTauriPublicKey(pubkey)) {
    throw new ReleaseConfigError('PIUI_UPDATER_PUBKEY is not the contents of a `tauri signer generate` .key.pub file.');
  }
  const urls = endpoint === undefined ? undefined : endpoints(endpoint);
  const missing = [
    pubkey === undefined && 'PIUI_UPDATER_PUBKEY',
    endpoint === undefined && 'PIUI_UPDATER_ENDPOINT',
    privateKey === undefined && 'TAURI_SIGNING_PRIVATE_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    notices.push(`Updates: off (${missing.join(', ')} not set). No updater artifacts are created.`);
    return undefined;
  }
  notices.push(`Updates: on (feed ${new URL(urls[0]).hostname}); the bundler signs the updater artifacts.`);
  return { pubkey, endpoints: urls, windows: { installMode: 'passive' } };
}

function windowsSigning(env, notices) {
  const thumbprint = value(env, 'PIUI_WINDOWS_CERTIFICATE_THUMBPRINT');
  const azure = ['PIUI_AZURE_SIGNING_ENDPOINT', 'PIUI_AZURE_SIGNING_ACCOUNT', 'PIUI_AZURE_SIGNING_PROFILE'].map((name) => [name, value(env, name)]);
  const azureRequested = azure.some(([, setting]) => setting !== undefined);
  if (thumbprint !== undefined && azureRequested) {
    throw new ReleaseConfigError('Choose one Windows signing method: a certificate thumbprint or Azure Artifact Signing.');
  }
  const timestampUrl = value(env, 'PIUI_WINDOWS_TIMESTAMP_URL') ?? DEFAULT_TIMESTAMP_URL;
  if (!/^https?:\/\/[^\s/@]+(\/\S*)?$/.test(timestampUrl)) {
    throw new ReleaseConfigError('PIUI_WINDOWS_TIMESTAMP_URL must be an http(s) URL.');
  }
  if (thumbprint !== undefined) {
    const normalized = thumbprint.replace(/\s+/g, '').toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(normalized)) {
      throw new ReleaseConfigError('PIUI_WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character SHA-1 thumbprint.');
    }
    notices.push('Windows signing: Authenticode with a certificate from the Windows certificate store.');
    return { certificateThumbprint: normalized, digestAlgorithm: 'sha256', timestampUrl, tsp: true };
  }
  if (azureRequested) {
    const missing = [
      ...azure.filter(([, setting]) => setting === undefined).map(([name]) => name),
      ...['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID'].filter((name) => value(env, name) === undefined),
    ];
    if (missing.length > 0) {
      throw new ReleaseConfigError(`Azure Artifact Signing needs ${missing.join(', ')}.`);
    }
    const [[, endpoint], [, account], [, profile]] = azure;
    for (const [name, setting] of azure) {
      if (!/^[A-Za-z0-9:/._-]+$/.test(setting)) throw new ReleaseConfigError(`${name} contains unsupported characters.`);
    }
    notices.push('Windows signing: Authenticode with Azure Artifact Signing (artifact-signing-cli).');
    return {
      signCommand: {
        cmd: 'artifact-signing-cli',
        args: ['-e', endpoint, '-a', account, '-c', profile, '%1'],
      },
    };
  }
  notices.push('Windows signing: off (no certificate configured). The installer and executable are unsigned.');
  return undefined;
}

/**
 * The fragment for one platform, or null when nothing is configured.
 * Throws ReleaseConfigError for incomplete or invalid values.
 */
export function releaseConfig(env, platform) {
  if (!PLATFORMS.includes(platform)) throw new ReleaseConfigError(`Unknown platform "${platform}".`);
  const notices = [];
  const updater = updaterSection(env, notices);
  const signing = platform === 'windows' ? windowsSigning(env, notices) : undefined;
  const config = {};
  if (updater) {
    config.bundle = { createUpdaterArtifacts: true };
    config.plugins = { updater };
  }
  if (signing) {
    config.bundle = { ...config.bundle, windows: signing };
  }
  return {
    config: Object.keys(config).length > 0 ? config : null,
    updater: updater !== undefined,
    windowsSigning: signing === undefined ? null : 'certificateThumbprint' in signing ? 'certificate' : 'azure',
    notices,
  };
}

export const RELEASE_CONFIG_PATH = ['target', 'release-config', 'tauri.release.conf.json'];

/** Writes the fragment under the repository's ignored target folder; returns its path or null. */
export function writeReleaseConfig(root, env, platform) {
  const result = releaseConfig(env, platform);
  if (result.config === null) return { ...result, path: null };
  const path = join(root, ...RELEASE_CONFIG_PATH);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result.config, null, 2)}\n`);
  return { ...result, path };
}

function main(argv) {
  const platform = argv[0];
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  try {
    const result = writeReleaseConfig(root, process.env, platform);
    for (const notice of result.notices) console.log(notice);
    console.log(result.path ? `Release config: ${result.path}` : 'Release config: none (plain unsigned build).');
  } catch (error) {
    if (!(error instanceof ReleaseConfigError)) throw error;
    console.error(`Release configuration error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
