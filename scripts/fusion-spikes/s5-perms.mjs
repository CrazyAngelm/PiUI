// S5: what a workspace-write sidekick can actually do on this machine.
// claude: real subscription turn asking for one Bash command (records approvals).
// codex: synthetic provider drives exec_command inside/outside the workspace.
// Usage: node scripts/fusion-spikes/s5-perms.mjs claude|codex
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeAdapter } from '../../crates/piui-runtime/bridge/claude.mjs';
import { claudeExe, codexCli, codexHome, eventSink, outRoot, recorder, sleep, syntheticProvider, unpinnedCodexFactory } from './lib.mjs';

const harness = process.argv[2] ?? 'codex';
const { log } = recorder(`s5-${harness}${process.argv[3] ? `-${process.argv[3]}` : ''}`);
const approvals = [];
const sinkFor = () => eventSink((record) => {
  if (record.event?.type === 'approval') approvals.push(record.event.approval);
  return log(record);
}, 'sidekick');

if (harness === 'claude') {
  const project = join(outRoot, 'homes', 's5-claude', 'project');
  mkdirSync(project, { recursive: true });
  const sink = sinkFor();
  const adapter = await createClaudeAdapter({ harness: 'claude-code', cwd: project, sessionDir: project, permissionMode: 'workspace-write', nativeSubagents: false, model: { id: 'haiku', provider: 'anthropic', name: 'haiku' }, thinkingLevel: 'low', runtimeProgram: claudeExe }, sink.emit);
  try {
    const done = sink.nextTurn(240000);
    await adapter.prompt({ text: 'Run exactly this shell command with the Bash tool: node --version . Then create a file named note.txt containing the word ok using the Write tool. Reply with the command output and whether the file was written.', mode: 'prompt' });
    // Never approve: record what is asked, then deny so the turn ends.
    const deny = setInterval(() => { for (const approval of approvals.splice(0)) { log({ kind: 'denying', id: approval.id, title: approval.title }); adapter.respond({ requestId: approval.id, decision: 'deny' }).catch((error) => log({ kind: 'respond-error', message: error.message })); } }, 1000);
    const outcome = await done;
    clearInterval(deny);
    console.log(JSON.stringify({ outcome, noteWritten: existsSync(join(project, 'note.txt')), lastAssistant: sink.lastAssistant()?.slice(0, 400) }));
  } finally { await adapter.dispose().catch(() => {}); }
} else {
  const outside = join(outRoot, 'homes', 's5-outside.txt');
  const steps = [
    { label: 'version', cmd: 'node --version' },
    { label: 'write-inside', cmd: 'node -e "require(\'fs\').writeFileSync(\'inside.txt\',\'ok\')"' },
    { label: 'write-outside', cmd: `node -e "require('fs').writeFileSync('${outside.replace(/\\/g, '/')}','ok')"` },
    { label: 'failing', cmd: 'node -e "process.exit(3)"' },
  ];
  let schemaLogged = false;
  const provider = await syntheticProvider((payload, index) => {
    if (!schemaLogged) { schemaLogged = true; log({ kind: 'exec-schema', schema: JSON.stringify(payload.tools?.find((tool) => tool.name === 'exec_command')?.parameters).slice(0, 800) }); }
    const outputs = (payload.input ?? []).filter((item) => item.type === 'function_call_output');
    if (outputs.length) log({ kind: 'exec-output', output: JSON.stringify(outputs.at(-1)).slice(0, 500) });
    const step = steps[index];
    return step ? [{ call: { name: 'exec_command', args: { cmd: step.cmd } } }] : [{ text: 'DONE' }];
  }, log);
  const sandbox = process.argv[3]; // e.g. unelevated
  const paths = codexHome(`s5-codex${sandbox ? `-${sandbox}` : ''}`, provider.baseUrl);
  if (sandbox) (await import('node:fs')).appendFileSync(join(paths.agent, 'config.toml'), `[windows]
sandbox = "${sandbox}"
`);
  process.env.CODEX_HOME = paths.agent;
  const createCodexAdapter = await unpinnedCodexFactory();
  const sink = sinkFor();
  const adapter = await createCodexAdapter({ harness: 'codex', cwd: paths.project, sessionDir: paths.sessions, permissionMode: 'workspace-write', nativeSubagents: false, runtimeProgram: process.execPath, runtimeArgs: [codexCli] }, sink.emit);
  try {
    const done = sink.nextTurn(240000);
    await adapter.prompt({ text: 'S5 run the steps', mode: 'prompt' });
    const outcome = await done;
    await sleep(1000);
    const tools = [...sink.blocks.values()].filter((block) => block.kind === 'tool').map((block) => ({ title: block.title, status: block.status, text: block.text?.slice(0, 160) }));
    console.log(JSON.stringify({ outcome, approvals: approvals.length, insideWritten: existsSync(join(paths.project, 'inside.txt')), outsideWritten: existsSync(outside), tools }, null, 1));
  } finally { await adapter.dispose().catch(() => {}); provider.close(); }
}
