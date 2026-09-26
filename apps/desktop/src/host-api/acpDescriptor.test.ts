import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkAcpDescriptor, parseAcpDescriptor, secretEnvironment, secretLikeEnvironment } from './acpDescriptor';

const directory = new URL('../../../../contracts/fixtures/acp-descriptors/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, directory), 'utf8');

const minimal = { schemaVersion: 1, id: 'lab-agent', displayName: 'Lab Agent', command: { program: 'lab-agent' }, version: { args: ['--version'] } };

describe('ACP agent descriptor v1 mirror of the host rules', () => {
  it('agrees with the host on every shared fixture', () => {
    const names = readdirSync(directory).filter((name) => name.endsWith('.json'));
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) {
      expect(parseAcpDescriptor(fixture(name)).ok, name).toBe(name.startsWith('valid-'));
    }
  });

  it('reports the host problem codes and messages', () => {
    const problem = (name: string) => {
      const result = parseAcpDescriptor(fixture(name));
      return result.ok ? undefined : result.problem;
    };
    expect(problem('invalid-capability-claim.json')).toBe('capability-override');
    expect(problem('invalid-credential-field.json')).toBe('malformed');
    expect(problem('invalid-denied-environment.json')).toBe('environment-denied');
    expect(problem('invalid-id.json')).toBe('malformed');
    expect(problem('invalid-schema-version.json')).toBe('unsupported-schema');
    expect(problem('invalid-semantic-duplicate-environment.json')).toBe('environment-name');
    expect(problem('invalid-semantic-pattern.json')).toBe('version-pattern');
    expect(problem('invalid-semantic-range.json')).toBe('verified-range');
    expect(problem('invalid-shell-program.json')).toBe('program');
    expect(problem('invalid-unknown-field.json')).toBe('malformed');
    expect(parseAcpDescriptor('{')).toEqual({ ok: false, problem: 'malformed', message: 'The descriptor is not valid JSON or contains unknown fields.' });
    expect(parseAcpDescriptor(`"${'x'.repeat(33 * 1024)}"`)).toMatchObject({ ok: false, problem: 'too-large' });
    expect(checkAcpDescriptor({ ...minimal, schemaVersion: undefined })).toMatchObject({ problem: 'malformed' });
    expect(checkAcpDescriptor({ ...minimal, displayName: ' Lab' })).toMatchObject({ problem: 'display-name' });
    expect(checkAcpDescriptor({ ...minimal, command: { program: 'bin/lab-agent' } })).toMatchObject({ problem: 'program' });
    expect(checkAcpDescriptor({ ...minimal, command: { program: '..' } })).toMatchObject({ problem: 'program' });
    expect(checkAcpDescriptor({ ...minimal, command: { program: 'lab', args: ['ok', 'bad\nline'] } })).toMatchObject({ problem: 'arguments' });
    expect(checkAcpDescriptor({ ...minimal, version: { args: [] } })).toMatchObject({ problem: 'version-arguments' });
    expect(checkAcpDescriptor({ ...minimal, environment: ['PIUI_TOKEN'] })).toMatchObject({ problem: 'environment-denied' });
    expect(checkAcpDescriptor({ ...minimal, environment: ['1BAD'] })).toMatchObject({ problem: 'environment-name' });
    expect(checkAcpDescriptor({ ...minimal, authHint: 'x'.repeat(401) })).toMatchObject({ problem: 'auth-hint' });
    expect(checkAcpDescriptor({ ...minimal, docsUrl: 'http://example.com' })).toMatchObject({ problem: 'docs-url' });
  });

  it('normalizes like serde: absolute programs, null options and the host field order', () => {
    for (const program of ['C:\\Tools\\agent.exe', 'C:/Tools/agent.exe', '/usr/local/bin/agent', '\\\\server\\share\\agent.exe']) {
      expect(checkAcpDescriptor({ ...minimal, command: { program } }).ok, program).toBe(true);
    }
    const result = checkAcpDescriptor({
      capabilities: { mcpHttp: false, models: null }, docsUrl: null, authHint: 'Sign in first.', environment: [],
      version: { verified: null, pattern: null, args: ['-V'] }, command: { args: [], program: 'lab' },
      displayName: 'Lab', id: 'lab', schemaVersion: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.descriptor)).toBe(
      '{"schemaVersion":1,"id":"lab","displayName":"Lab","command":{"program":"lab"},"version":{"args":["-V"]},"authHint":"Sign in first.","capabilities":{"mcpHttp":false}}',
    );
  });

  it('marks secret-like environment names for an explicit confirmation', () => {
    expect(['GEMINI_API_KEY', 'github_token', 'MY_SECRET', 'DB_PASSWORD', 'AUTH_HEADER', 'SESSION_ID', 'PRIVATE_PATH', 'AWS_CREDENTIALS'].every(secretLikeEnvironment)).toBe(true);
    expect(['HTTPS_PROXY', 'NO_PROXY', 'GOOGLE_CLOUD_PROJECT', 'LANG'].some(secretLikeEnvironment)).toBe(false);
    const gemini = parseAcpDescriptor(fixture('valid-builtin-gemini-cli.json'));
    expect(gemini.ok && secretEnvironment(gemini.descriptor)).toEqual(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']);
  });
});
