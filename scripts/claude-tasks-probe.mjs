// Real-provider probe: spends a little of the person's Claude subscription.
// Never run by CI or tests. Takes no arguments.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClaudeAdapter } from '../crates/piui-runtime/bridge/claude.mjs';

const prompt = 'Do exactly these steps in order. 1) Start one shell command in the background (run_in_background true) that sleeps for 90 seconds. 2) Run one short foreground shell command that prints foreground-done. 3) Start one subagent with the Agent tool (subagent_type general-purpose, description "Say hi") whose prompt is: Reply with the single word hi. Do not use tools. 4) Reply with the single word started.';
const allowed = new Set(['id', 'kind', 'title', 'status', 'background', 'startedAt', 'endedAt', 'detail', 'activity', 'toolUses', 'totalTokens', 'blockId']);
const events = [];
let adapter, cwd, sessionDir, snapshot, selected, version = 'unavailable';
let status, completed = false, stopped = false, rejected = false, command;
let failure;
const wait = async (predicate, seconds) => {
  const deadline = performance.now() + seconds * 1000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Probe wait expired.');
    await sleep(50);
  }
};
const latestTasks = () => events.filter(row => row.event.type === 'tasks').at(-1)?.event.tasks ?? [];
const removeTemp = async path => {
  // Windows can retain the child's cwd handle briefly after disposal.
  // A few short retries cover Windows child cwd-handle release.
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      await sleep(100);
    }
  }
  console.log(`Leftover temporary directory: ${basename(path)}`);
};
const emit = event => {
  events.push({ index: events.length + 1, event: structuredClone(event) });
  if (event.type === 'status') status = event.status;
  if (event.type === 'turnCompleted') completed = true;
  if (event.type === 'approval') {
    Promise.resolve().then(() => adapter.respond({ requestId: event.approval.id, decision: 'approve-once' }))
      .catch(() => { failure = 'Approval response failed.'; });
  }
};
try {
  // Same installed npm Claude executable as s1-claude; resolve via PATH,
  // without reading or printing environment variables or credentials.
  const launchers = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  const candidates = launchers.flatMap(path => [path.endsWith('.exe') ? path : '', join(dirname(path), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]);
  const runtimeProgram = candidates.find(path => path && existsSync(path));
  if (!runtimeProgram) throw new Error('Installed Claude executable unavailable.');
  version = execFileSync(runtimeProgram, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  cwd = await mkdtemp(join(tmpdir(), 'claude-tasks-cwd-'));
  sessionDir = await mkdtemp(join(tmpdir(), 'claude-tasks-session-'));
  adapter = await createClaudeAdapter({ harness: 'claude-code', cwd, sessionDir, permissionMode: 'native', thinkingLevel: 'low', runtimeProgram }, emit);
  const model = (await adapter.models()).find(model => model.id.toLowerCase().includes('haiku'));
  if (model) await adapter.setModel({ model });
  selected = (await adapter.snapshot()).model?.id ?? 'default';
  await adapter.prompt({ text: prompt, mode: 'prompt' });
  await wait(() => completed && status === 'idle', 240);
  command = latestTasks().find(task => task.kind === 'command' && task.status === 'running' && task.background);
  if (command) {
    await adapter.stopTask({ taskId: command.id });
    stopped = true;
    await wait(() => latestTasks().some(task => task.id === command.id && task.status === 'stopped' && task.endedAt), 30);
    await wait(() => status === 'idle', 90);
  }
  try { await adapter.stopTask({ taskId: 'claude-task-000000000000000000000000' }); }
  catch { rejected = true; }
  snapshot = await adapter.snapshot();
} catch (error) {
  // Adapter safe messages are designed for display; never print raw exceptions.
  failure = error.safeMessage ?? (error.message === 'Probe wait expired.' ? error.message : 'Probe setup or operation failed.');
} finally {
  if (adapter) await adapter.dispose().catch(() => { failure ??= 'Dispose failed.'; });
  if (cwd) await removeTemp(cwd);
  if (sessionDir) await removeTemp(sessionDir);
}
const taskEvents = events.filter(row => row.event.type === 'tasks');
const allTasks = [...taskEvents.flatMap(row => row.event.tasks), ...(snapshot?.tasks ?? [])];
const safe = text => String(text ?? '').replaceAll(cwd ?? '\0', '[cwd]').replaceAll(sessionDir ?? '\0', '[session]').replace(/toolu_[A-Za-z0-9_-]+/g, '[tool]').replace(/[\r\n\u2028\u2029]/g, ' ');
const check = (number, ok, description) => `${number}. ${ok ? 'PASS' : 'FAIL'}: ${description}`;
const foreground = taskEvents.flatMap((row, index) => row.event.tasks.filter(task => task.kind === 'command' && !task.background).map(task => ({ task, index })));
const checks = [
  check(1, !!command, 'A running background command was listed.'),
  check(2, !!command?.blockId && !!snapshot?.blocks.some(block => block.kind === 'tool' && block.id === command.blockId), 'The background command links to a snapshot tool block.'),
  check(3, allTasks.some(task => task.kind === 'agent' && task.detail === 'general-purpose'), 'The general-purpose subagent was listed.'),
  `4. INFO: Foreground command appeared=${foreground.length > 0}; removed in a later list=${foreground.some(({task,index}) => taskEvents.slice(index + 1).some(row => !row.event.tasks.some(next => next.id === task.id)))}.`,
  check(5, stopped && allTasks.some(task => task.id === command?.id && task.status === 'stopped' && task.endedAt), 'stopTask resolved and the command became stopped with endedAt.'),
  check(6, rejected, 'An unknown opaque task id was rejected.'),
  check(7, allTasks.every(task => Object.keys(task).every(key => allowed.has(key)) && !Object.values(task).some(value => typeof value === 'string' && /SubagentHandback|[0-9a-f]{16,}/i.test(value) && ![task.id, task.blockId].includes(value)) && ![cwd, sessionDir, 'toolu_'].filter(Boolean).some(marker => Object.values(task).some(value => typeof value === 'string' && value.includes(marker)))), 'Task reports contain no private paths, toolu_ ids, internal hand-back notices, native hex ids or unexpected keys.'),
  check(8, snapshot?.status === 'idle' && !!snapshot?.tasks?.some(task => task.id === command?.id && task.status === 'stopped'), 'The final idle snapshot retains the stopped command.'),
];
const sequence = taskEvents.map(({index,event}) => `${index}: ${event.tasks.map(task => [task.kind, safe(task.title), task.status, `bg=${task.background}`, safe(task.detail), safe(task.activity), task.toolUses ?? '', task.totalTokens ?? '', `block=${task.blockId ? 'yes' : 'no'}`].join('|')).join(' ; ') || '(empty)'}`);
const report = [`Date: ${new Date().toISOString().slice(0, 10)}`, `Claude Code: ${safe(version)}`, `Model: ${safe(selected ?? 'unavailable')}`, '', ...checks, ...(failure ? ['', `Failure: ${safe(failure)}`] : []), '', 'Tasks event sequence:', ...sequence, ''].join('\n');
console.log(report);
await writeFile(new URL('../evidence/session-activity-20261117/claude-bridge-tasks-probe.md', import.meta.url), report);
process.exitCode = failure || checks.some(line => line.includes('FAIL:')) ? 1 : 0;
