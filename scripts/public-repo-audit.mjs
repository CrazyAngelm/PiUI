import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const ignoredPathPatterns = [
  /^\.pi(?:\/|$)/,
  /^\.piui(?:\/|$)/,
  /^mutants\.out(?:[^/]*)?(?:\/|$)/,
  /(?:^|\/)node_modules(?:\/|$)/,
  /(?:^|\/)target(?:\/|$)/,
  /(?:^|\/)dist(?:\/|$)/,
  /(?:^|\/)__pycache__(?:\/|$)/,
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)(?:auth\.json|NUL)$/i,
];

const sensitiveContentPatterns = [
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Windows user home path', /[A-Za-z]:\\(?:Users|Documents and Settings)\\(?!(?:example|test-user|fixture)(?:\\|\/|$))/i],
  ['macOS user home path', /\/Users\/(?!(?:example|test-user|fixture)(?:\/|$))[^/\s]+/],
  ['private email address', /\b[A-Z0-9._%+-]+@(?!(?:example\.(?:com|org|net|test)|localhost)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];

function candidatePaths() {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer', windowsHide: true },
  );
  return [...new Set(output.toString('utf8').split('\0').filter(Boolean))].sort();
}

function isLikelyText(buffer) {
  return !buffer.includes(0);
}

const findings = [];
for (const file of candidatePaths()) {
  if (file !== '.env.example' && ignoredPathPatterns.some((pattern) => pattern.test(file))) {
    findings.push([file, 'private or generated path']);
    continue;
  }

  let stats;
  try {
    stats = statSync(file);
  } catch {
    findings.push([file, 'unreadable candidate']);
    continue;
  }
  if (!stats.isFile() || stats.size > MAX_TEXT_BYTES) continue;

  let content;
  try {
    content = readFileSync(file);
  } catch {
    findings.push([file, 'unreadable candidate']);
    continue;
  }
  if (!isLikelyText(content)) continue;

  const text = content.toString('utf8');
  for (const [category, pattern] of sensitiveContentPatterns) {
    if (pattern.test(text)) findings.push([file, category]);
  }
}

if (findings.length > 0) {
  console.error('Public repository audit failed. Remove or redact the following candidates:');
  for (const [file, category] of findings) console.error(`- ${file}: ${category}`);
  process.exitCode = 1;
} else {
  console.log(`Public repository audit passed (${candidatePaths().length} Git candidates checked).`);
}
