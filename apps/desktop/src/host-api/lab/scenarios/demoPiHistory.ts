import { DAY, HOUR, MINUTE, seededIso } from '../labClock';
import { hashString } from '../labRandom';
import type { LabIndexedSession, LabNativeHistory } from '../piHistoryFake';
import type { SessionTree, SessionTreeNode, TimelineBlock } from '../../types';
import { DEMO_PROJECTS } from './demoChats';

/**
 * Native session history that the host index would find in each demo folder:
 * sessions a user ran with the Pi (or Prime Agent) terminal app, not chats
 * PiUI created. They exercise the read-only history browser: a session with
 * three branches, a long transcript that needs several pages, extension and
 * unknown entries behind the generic fallback, and a partly readable file.
 */

const entryId = (seed: string): string => hashString(seed).toString(16).padStart(8, '0').slice(0, 8);

interface TreeEntry {
  readonly id: string;
  readonly parent?: string;
}

/** The host's flat depth-first projection: roots in order, children in insertion order. */
export function flatTree(entries: readonly TreeEntry[], currentLeaf: string, diagnosticCount = 0, issues: Readonly<Record<string, SessionTreeNode['issue']>> = {}): SessionTree {
  const ids = new Set(entries.map((entry) => entry.id));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  const parentOf = new Map<string, string | undefined>();
  for (const entry of entries) {
    parentOf.set(entry.id, entry.parent);
    if (entry.parent !== undefined && ids.has(entry.parent)) children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry.id]);
    else roots.push(entry.id);
  }
  const current = new Set<string>();
  for (let cursor: string | undefined = currentLeaf; cursor !== undefined && !current.has(cursor); cursor = parentOf.get(cursor)) current.add(cursor);
  const nodes: SessionTreeNode[] = [];
  const stack: [string, number][] = roots.map((id): [string, number] => [id, 0]).reverse();
  while (stack.length > 0) {
    const [id, depth] = stack.pop() as [string, number];
    const parentId = parentOf.get(id);
    const issue = issues[id];
    nodes.push({
      entryId: id,
      ...(parentId === undefined ? {} : { parentId }),
      label: id,
      kind: 'entry',
      depth,
      isCurrentPath: current.has(id),
      ...(issue === undefined ? {} : { issue }),
    });
    for (const child of [...(children.get(id) ?? [])].reverse()) stack.push([child, depth + 1]);
  }
  return { nodes, diagnosticCount, navigationSupported: false };
}

/** Index projection blocks carry scanner ids (`timeline-N`) and host labels. */
class Blocks {
  private readonly items: TimelineBlock[] = [];
  private instant: number;

  constructor(start: number) {
    this.instant = start;
  }

  private push(block: Omit<TimelineBlock, 'id' | 'status' | 'createdAt'> & { status?: TimelineBlock['status'] }, gap = 40_000): this {
    this.instant += gap;
    this.items.push({ status: 'complete', ...block, id: `timeline-${this.items.length}`, createdAt: seededIso(this.instant) });
    return this;
  }

  user(text: string): this {
    return this.push({ kind: 'user', label: 'You', text }, 90_000);
  }

  assistant(text: string, status: TimelineBlock['status'] = 'complete'): this {
    return this.push({ kind: 'assistant', label: 'Pi', text, status });
  }

  thinking(text: string): this {
    return this.push({ kind: 'thinking', label: 'Reasoning', text, collapsible: true });
  }

  tool(title: string, toolName: string, text: string, status: TimelineBlock['status'] = 'complete'): this {
    return this.push({ kind: 'tool', label: 'Tool activity', title, toolName, text, collapsible: true, status });
  }

  custom(text: string): this {
    return this.push({ kind: 'custom', label: 'Extension message', text, fallback: true, collapsible: true });
  }

  compaction(): this {
    return this.push({ kind: 'compaction', label: 'Context compacted', safeSummary: 'The session records a context compaction boundary.', collapsible: true });
  }

  unknown(): this {
    return this.push({ kind: 'unknown', label: 'Unrecognized session entry', safeSummary: 'An unsupported entry is retained through the generic fallback.', fallback: true });
  }

  error(text: string): this {
    return this.push({ kind: 'error', label: 'Runtime notice', text, status: 'failed' });
  }

  build(): TimelineBlock[] {
    return this.items;
  }

  last(): string {
    return seededIso(this.instant);
  }
}

function session(
  id: string,
  title: string,
  blocks: Blocks,
  tree: SessionTree,
  extra: { preview?: string; parseState?: LabIndexedSession['summary']['parseState']; titleSource?: LabIndexedSession['summary']['titleSource'] } = {},
): LabIndexedSession {
  const built = blocks.build();
  const leaves = tree.nodes.filter((node) => !tree.nodes.some((candidate) => candidate.parentId === node.entryId)).length;
  return {
    summary: {
      id,
      title,
      titleSource: extra.titleSource ?? 'pi-name',
      createdAt: built[0]?.createdAt,
      updatedAt: blocks.last(),
      preview: extra.preview ?? built.find((block) => block.kind === 'user')?.text?.slice(0, 140),
      entryCount: tree.nodes.length,
      branchCount: leaves,
      parseState: extra.parseState ?? 'healthy',
    },
    blocks: built,
    tree,
    fileRevision: hashString(`${id}:${built.length}`).toString(16).padStart(8, '0').repeat(8),
  };
}

/** Three branches: the current line, a retry of the parser and an early "tests first" detour. */
function branchedSession(): LabIndexedSession {
  const e = (name: string) => entryId(`index-refactor:${name}`);
  const entries: TreeEntry[] = [
    { id: e('1') },
    { id: e('2'), parent: e('1') },
    { id: e('3'), parent: e('2') },
    { id: e('4'), parent: e('3') },
    { id: e('5'), parent: e('4') },
    { id: e('6'), parent: e('5') },
    { id: e('7'), parent: e('6') },
    { id: e('8'), parent: e('7') },
    { id: e('5a'), parent: e('4') },
    { id: e('6a'), parent: e('5a') },
    { id: e('3b'), parent: e('2') },
    { id: e('4b'), parent: e('3b') },
    { id: e('5b'), parent: e('4b') },
    { id: e('6b'), parent: e('5b') },
  ];
  const blocks = new Blocks(-2 * DAY - 5 * HOUR)
    .user('The session index scanner re-reads every JSONL file on refresh. Can we make it incremental?')
    .thinking('The scanner keys rows by file path and mtime. An append-only JSONL can resume from the last byte offset if the prefix hash still matches.')
    .assistant('Yes. Pi only appends to session files, so the scanner can remember a **byte offset** and a hash of the prefix it already read:\n\n1. On refresh, compare size and prefix hash.\n2. If they match, parse only the new tail.\n3. Otherwise fall back to a full scan.')
    .user('Show me where the offset would live.')
    .tool('read crates/piui-index/src/lib.rs', 'read', 'pub struct SessionIndexRow {\n    pub file_revision: String,\n    pub entry_count: usize,\n    // …\n}')
    .assistant('The row already has `file_revision`. Add `scanned_bytes` next to it and store the prefix hash in the same transaction.')
    .user('Try the streaming parser from the spike instead of the line reader.')
    .tool('bash cargo test -p piui-index scanner', 'bash', 'running 42 tests\n…\ntest result: ok. 42 passed; 0 failed', 'complete')
    .assistant('The streaming parser passes the scanner suite. It keeps LF-only framing, so Unicode line separators inside JSON strings stay intact.')
    .user('Good. Summarize the change for the PR.')
    .assistant('**Incremental session scan**\n\n- Remember `scanned_bytes` and a prefix hash per session row.\n- Parse only the appended tail when the prefix is unchanged.\n- Fall back to a full scan after truncation or rewrite.\n\nTests: `piui-index` scanner suite, 42 passed.');
  return session(entryId('session:index-refactor'), 'Make the session index incremental', blocks, flatTree(entries, e('8')));
}

/** Long enough for three pages of the host's 100-block default. */
function longSession(): LabIndexedSession {
  const blocks = new Blocks(-6 * DAY);
  const entries: TreeEntry[] = [];
  const steps = ['schema', 'journal', 'revisions', 'snapshots', 'schedules', 'runs', 'artifacts', 'usage', 'recovery'];
  for (let index = 0; index < 87; index += 1) {
    const step = steps[index % steps.length] ?? 'store';
    blocks
      .user(`Step ${index + 1}: migrate the ${step} table and keep the old reader working.`)
      .tool(`bash cargo test -p piui-orchestration ${step}`, 'bash', `test ${step}::migrates_v5_rows ... ok\ntest ${step}::keeps_v5_reader ... ok`)
      .assistant(`Step ${index + 1} is done: the ${step} rows migrate in one transaction and the v5 reader still opens them.`);
    entries.push({ id: entryId(`migration:${index}:user`), ...(index === 0 ? {} : { parent: entryId(`migration:${index - 1}:assistant`) }) });
    entries.push({ id: entryId(`migration:${index}:assistant`), parent: entryId(`migration:${index}:user`) });
  }
  const leaf = entryId('migration:86:assistant');
  return session(entryId('session:migration'), 'Walk through the orchestration store migration', blocks, flatTree(entries, leaf), {
    preview: 'Step 1: migrate the schema table and keep the old reader working.',
  });
}

function releaseNotes(): LabIndexedSession {
  const e = (name: string) => entryId(`release-notes:${name}`);
  const entries: TreeEntry[] = ['1', '2', '3', '4', '5', '6', '7'].map((name, index, all) => ({
    id: e(name),
    ...(index === 0 ? {} : { parent: e(all[index - 1] ?? '1') }),
  }));
  const blocks = new Blocks(-20 * HOUR)
    .user('Draft release notes for 0.2.0 from the merged changes.')
    .custom('commit-digest: 86 commits grouped into 7 areas (chat, pipelines, runs, automations, harnesses, lab, docs).')
    .assistant('## PiUI 0.2.0\n\n- A new workbench shell with a composer-first home.\n- Pipelines on a canvas, with runs you can watch.\n- Claude Code on your own subscription.')
    .compaction()
    .user('Add a line about the history browser.')
    .unknown()
    .assistant('Added: *Read your Pi terminal sessions in PiUI, including their branches, without changing the files.*');
  return session(entryId('session:release-notes'), 'Draft release notes for 0.2.0', blocks, flatTree(entries, e('7')));
}

/** An interrupted write: the index keeps what it can read and reports the rest. */
function damagedSession(): LabIndexedSession {
  const e = (name: string) => entryId(`damaged:${name}`);
  const entries: TreeEntry[] = [
    { id: e('1') },
    { id: e('2'), parent: e('1') },
    { id: e('3'), parent: e('2') },
    { id: e('orphan'), parent: entryId('damaged:missing-parent') },
  ];
  const blocks = new Blocks(-3 * DAY - 2 * HOUR)
    .user('Rename the watcher module and update its imports.')
    .tool('bash rg -l catalog_watch', 'bash', 'apps/desktop/src-tauri/src/lib.rs\napps/desktop/src-tauri/src/catalog_watch.rs', 'complete')
    .assistant('Renaming now. I will update `lib.rs` after the move.', 'interrupted')
    .error('The session file ended in the middle of an entry.')
    .unknown();
  return session(entryId('session:damaged'), 'Rename the catalog watcher', blocks, flatTree(entries, e('3'), 2, { [e('orphan')]: 'orphan' }), {
    parseState: 'partial',
  });
}

function linear(key: string, title: string, start: number, turns: readonly (readonly [string, string])[]): LabIndexedSession {
  const blocks = new Blocks(start);
  const entries: TreeEntry[] = [];
  turns.forEach(([prompt, answer], index) => {
    blocks.user(prompt).assistant(answer);
    entries.push({ id: entryId(`${key}:${index}:u`), ...(index === 0 ? {} : { parent: entryId(`${key}:${index - 1}:a`) }) });
    entries.push({ id: entryId(`${key}:${index}:a`), parent: entryId(`${key}:${index}:u`) });
  });
  return session(entryId(`session:${key}`), title, blocks, flatTree(entries, entryId(`${key}:${turns.length - 1}:a`)));
}

export function demoPiHistory(): LabNativeHistory {
  return {
    byProject: new Map([
      [DEMO_PROJECTS.piui, [branchedSession(), releaseNotes(), damagedSession(), longSession()]],
      [DEMO_PROJECTS.video, [
        linear('grading', 'Color grading notes for the trailer', -4 * HOUR, [
          ['Suggest a warm grade for the dusk shots.', 'Lift the shadows slightly toward teal, keep skin tones warm and pull highlights down a quarter stop.'],
          ['And for the logo reveal?', 'Keep it neutral: the brand palette already carries the warmth.'],
        ]),
      ]],
      [DEMO_PROJECTS.legacy, [
        linear('legacy-auth', 'Map the legacy auth flow', -12 * DAY, [
          ['Where does the session cookie get its expiry?', 'In `src/auth/session.ts`: `maxAge` comes from `COOKIE_TTL`, which defaults to 14 days.'],
        ]),
      ]],
      [DEMO_PROJECTS.chats, [
        linear('regex', 'Regex for ISO dates', -30 * MINUTE, [
          ['A regex for ISO 8601 dates without time?', '`^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$` — it checks ranges, not calendar validity (Feb 30 passes).'],
        ]),
        linear('paper', 'Summarize a scheduling paper', -2 * DAY, [
          ['Summarize the key idea of work-stealing schedulers.', 'Idle workers steal tasks from the tail of busy workers\' deques, which balances load with little coordination.'],
          ['Why the tail?', 'The owner pops from the head, so stealing from the tail avoids contention on the same end.'],
        ]),
      ]],
    ]),
  };
}
