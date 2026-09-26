import { catalogModel } from '../catalogFake';
import { DAY, HOUR, LAB_BASE_TIME, MINUTE, seededIso } from '../labClock';
import type { DesktopTimelineBlock, HarnessKind, WorkspaceModel } from '../labContracts';
import { createRandom, labUuid } from '../labRandom';
import type { LabProject } from '../labState';
import { TranscriptBuilder } from '../transcriptBuilder';
import {
  AUDIT_ANSWER, AUDIT_GREP_OUTPUT, AUDIT_PROMPT, cargoBuildLog, CHECK_COMMAND, CHECK_OUTPUT, COMPACTION_SUMMARY,
  COMPACTION_TOPICS, compactionAnswer, CRASH_ANALYSIS_PARTIAL, CRASH_ANSWER, CRASH_ERROR, CRASH_LOG_COMMAND,
  CRASH_LOG_OUTPUT, CRASH_PROMPT, CRASH_RETRY, KEYMAP_ANSWER, KEYMAP_GREP_COMMAND, KEYMAP_GREP_OUTPUT, KEYMAP_PROMPT,
  KEYMAP_THINKING, LIFETIMES_ANSWER, LIFETIMES_PROMPT, LIFETIMES_THINKING, LISBON_FOLLOW_UP,
  LISBON_PLAN, LISBON_PROMPT, LISBON_REVISED, longReferenceAnswer, RENDER_CONFIG, RENDER_ERROR, RENDER_PARTIAL,
  RENDER_PROMPT, RENDERER_PARAGRAPHS, RENDERER_PROMPT, RENDERER_THINKING, RG_COMMAND, RG_OUTPUT, SCHEDULER_ANALYSIS,
  SCHEDULER_DECLINED, SCHEDULER_DONE, SCHEDULER_E2E_COMMAND, SCHEDULER_E2E_OUTPUT, SCHEDULER_FIX_DIFF,
  SCHEDULER_GREP_OUTPUT, SCHEDULER_PROMPT, SCHEDULER_TEST_SOURCE, SCHEDULER_THINKING, STORYBOARD_ANSWER,
  STORYBOARD_PROMPT, TEST_COMMAND, TRANSPORT_DIFF, TRANSPORT_FOLLOW_UP, TRANSPORT_PLAN, TRANSPORT_PROMPT, TRANSPORT_SUMMARY,
  vitestReport,
} from '../transcriptSamples';
import { EXTENSION_DEMO_COMMAND } from '../extensionDemo';
import { commandOutputSteps, streamSteps, usageStep, type ApprovalStep } from '../turnScripts';
import { sessionRecord, seededUsage, type LabSeed, type SeedActivity } from './seedTypes';

/** Stable ids shared by the demo modules. */
export const DEMO_PROJECTS = {
  chats: labUuid('demo:project:chats'),
  piui: labUuid('demo:project:piui'),
  video: labUuid('demo:project:video-studio'),
  legacy: labUuid('demo:project:legacy-repo'),
} as const;

/** Display paths (clearly fake) used as project folders and command working directories. */
export const DEMO_FOLDERS = {
  chats: '~/.piui-lab/chats',
  piui: '~/lab/piui',
  video: '~/lab/video-studio',
  legacy: '~/lab/legacy-repo',
} as const;

export const demoSessionId = (name: string): string => labUuid(`demo:session:${name}`);

export function demoProjects(): LabProject[] {
  const project = (id: string, name: string, displayPath: string, patch: Partial<LabProject>): LabProject => ({
    id, name, displayPath, agentKind: 'pi', trustState: 'trusted', pinned: false, missing: false, personal: false, ...patch,
  });
  return [
    project(DEMO_PROJECTS.chats, 'Chats', DEMO_FOLDERS.chats, { personal: true }),
    project(DEMO_PROJECTS.piui, 'piui', DEMO_FOLDERS.piui, { pinned: true, lastOpenedAt: seededIso(-20 * MINUTE) }),
    project(DEMO_PROJECTS.video, 'video-studio', DEMO_FOLDERS.video, { agentKind: 'prime-agent', lastOpenedAt: seededIso(-3 * HOUR) }),
    project(DEMO_PROJECTS.legacy, 'legacy-repo', DEMO_FOLDERS.legacy, { trustState: 'restricted', lastOpenedAt: seededIso(-9 * DAY) }),
  ];
}

function model(harness: HarnessKind, provider: string, id: string): WorkspaceModel {
  const entry = catalogModel(harness, id, provider);
  if (entry === undefined) throw new Error(`Unknown lab model ${provider}/${id}`);
  const { supportsFast: _fast, ...rest } = entry;
  return rest;
}

function lisbon(): LabSeed['sessions'][number] {
  const transcript = new TranscriptBuilder('pi', 'lisbon', LAB_BASE_TIME - 2 * DAY)
    .user(LISBON_PROMPT)
    .thinking('Two days, relaxed pace, food markets and viewpoints, one museum. Keep hills to a minimum and add a table for Sunday.')
    .assistant(LISBON_PLAN)
    .user(LISBON_FOLLOW_UP, 300)
    .assistant(LISBON_REVISED);
  return sessionRecord({
    id: demoSessionId('lisbon'), workspaceId: DEMO_PROJECTS.chats, harness: 'pi', title: 'Plan a weekend in Lisbon',
    blocks: transcript.build(), updatedAt: transcript.lastInstant(), model: model('pi', 'anthropic-lab', 'claude-lab-haiku'),
    thinkingLevel: 'low', usage: [seededUsage('lisbon-1', 2_140, 910), seededUsage('lisbon-2', 3_380, 420)],
  });
}

function lifetimes(): LabSeed['sessions'][number] {
  const transcript = new TranscriptBuilder('hermes', 'lifetimes', LAB_BASE_TIME - 5 * HOUR)
    .user(LIFETIMES_PROMPT)
    .thinking(LIFETIMES_THINKING)
    .assistant(LIFETIMES_ANSWER);
  return sessionRecord({
    id: demoSessionId('lifetimes'), workspaceId: DEMO_PROJECTS.chats, harness: 'hermes', title: 'Explain Rust lifetimes',
    blocks: transcript.build(), updatedAt: transcript.lastInstant(), model: model('hermes', 'nous-lab', 'hermes-lab-70b'),
  });
}

function transport(): LabSeed['sessions'][number] {
  const transcript = new TranscriptBuilder('codex', 'transport', LAB_BASE_TIME - 50 * MINUTE)
    .user(TRANSPORT_PROMPT)
    .thinking(TRANSPORT_PLAN)
    .search(RG_COMMAND, RG_OUTPUT)
    .fileChange('apps/desktop/src/host-api/transport.ts', TRANSPORT_DIFF)
    .command(CHECK_COMMAND, CHECK_OUTPUT, 'complete', 40)
    .command(TEST_COMMAND, vitestReport(47, 'transport'), 'complete', 25)
    .command('cargo build -p piui-desktop', cargoBuildLog(420), 'complete', 160)
    .assistant(TRANSPORT_SUMMARY)
    .user('Does anything still import Tauri directly from a component?', 120)
    .assistant(TRANSPORT_FOLLOW_UP);
  return sessionRecord({
    id: demoSessionId('transport'), workspaceId: DEMO_PROJECTS.piui, harness: 'codex', title: 'Route host calls through one transport',
    blocks: transcript.build(), updatedAt: transcript.lastInstant(), model: model('codex', 'openai-lab', 'gpt-lab-5-codex'),
    thinkingLevel: 'high', serviceTier: 'fast', permissionMode: 'workspace-write', live: 'idle',
    usage: [seededUsage('codex-session-total', 184_220, 12_930)],
  });
}

/** A Pi session paused on a permission request; approving it finishes the turn. */
function scheduler(): { record: LabSeed['sessions'][number]; activity: SeedActivity } {
  const id = demoSessionId('scheduler');
  const transcript = new TranscriptBuilder('pi', 'scheduler', LAB_BASE_TIME - 14 * MINUTE)
    .user(SCHEDULER_PROMPT)
    .thinking(SCHEDULER_THINKING)
    .read('apps/desktop/src-tauri/src/orchestration_scheduler.rs', SCHEDULER_TEST_SOURCE)
    .search('grep -n "revision(), 5" apps/desktop/src-tauri/src', SCHEDULER_GREP_OUTPUT)
    .assistant(SCHEDULER_ANALYSIS)
    .fileChange('apps/desktop/src-tauri/src/orchestration_scheduler.rs', SCHEDULER_FIX_DIFF);
  const blocks = transcript.build();
  const opened: DesktopTimelineBlock = {
    id: 'scheduler-e2e', kind: 'tool', label: 'bash', toolName: 'bash', collapsible: true, status: 'streaming',
    text: `$ ${SCHEDULER_E2E_COMMAND}\n`, createdAt: seededIso(-2 * MINUTE),
  };
  blocks.push(opened);
  const context = { harness: 'pi' as const, sessionId: id, turn: 1, permissionMode: 'native' as const, cwd: DEMO_FOLDERS.piui };
  const random = createRandom('scheduler-approval');
  const answer: DesktopTimelineBlock = { id: 'scheduler-answer', kind: 'assistant', label: 'Pi', status: 'complete' };
  const approvalId = 'lab-approval-scheduler-e2e';
  const step: ApprovalStep = {
    kind: 'approval',
    approval: {
      kind: 'permission',
      title: 'Run the full e2e suite?',
      description: `Pi wants to run \`${SCHEDULER_E2E_COMMAND}\`. It builds the desktop harness and takes about six minutes.`,
      decisions: ['approve-once', 'deny', 'cancel'],
    },
    approved: [
      ...commandOutputSteps(context, opened, SCHEDULER_E2E_COMMAND, SCHEDULER_E2E_OUTPUT, random),
      ...streamSteps(answer, SCHEDULER_DONE, random, 'delta', [25, 60]),
      usageStep(context, random),
      { kind: 'end', outcome: 'succeeded' },
    ],
    declined: [
      { kind: 'block', block: { ...opened, status: 'interrupted', safeSummary: 'The command was declined.' } },
      ...streamSteps(answer, SCHEDULER_DECLINED, random, 'delta', [25, 60]),
      usageStep(context, random),
      { kind: 'end', outcome: 'succeeded' },
    ],
  };
  const record = sessionRecord({
    id, workspaceId: DEMO_PROJECTS.piui, harness: 'pi', title: 'Fix flaky scheduler test',
    blocks, updatedAt: seededIso(-2 * MINUTE), model: model('pi', 'anthropic-lab', 'claude-lab-sonnet'), thinkingLevel: 'medium',
    live: 'running',
    approvals: [{ ...step.approval, id: approvalId, sessionId: id }],
    queue: {
      paused: false,
      items: [{ id: labUuid('demo:queue:changelog'), text: 'After the e2e run, add a CHANGELOG entry for the fix.', status: 'queued' }],
    },
  });
  return { record, activity: { kind: 'paused-approval', sessionId: id, approvalId, step } };
}

/** A Prime session that keeps streaming a design doc for as long as the lab runs. */
function renderer(): { record: LabSeed['sessions'][number]; activity: SeedActivity } {
  const id = demoSessionId('renderer');
  const transcript = new TranscriptBuilder('prime-agent', 'renderer', LAB_BASE_TIME - 4 * MINUTE)
    .user(RENDERER_PROMPT)
    .thinking(RENDERER_THINKING)
    .read('apps/desktop/src/components/markdown.ts', 'export function parseMarkdown(source: string): MarkdownBlock[] { … }')
    .assistant(RENDERER_PARAGRAPHS[0] ?? '');
  const record = sessionRecord({
    id, workspaceId: DEMO_PROJECTS.piui, harness: 'prime-agent', title: 'Streaming markdown renderer spike',
    blocks: transcript.build(), updatedAt: seededIso(-1 * MINUTE), model: model('prime-agent', 'prime-lab', 'prime-lab-large'),
    thinkingLevel: 'high', serviceTier: 'standard', live: 'running',
  });
  return { record, activity: { kind: 'ambient-stream', sessionId: id, firstCycle: 1 } };
}

function crash(): LabSeed['sessions'][number] {
  const transcript = new TranscriptBuilder('codex', 'crash', LAB_BASE_TIME - DAY - 3 * HOUR)
    .user(CRASH_PROMPT)
    .command(CRASH_LOG_COMMAND, CRASH_LOG_OUTPUT)
    .command('piui --diagnostics', 'error: index migration failed (IO_ERROR)\nexit code: 101', 'failed')
    .assistant(CRASH_ANALYSIS_PARTIAL, 'interrupted')
    .error(CRASH_ERROR)
    .user(CRASH_RETRY, 90)
    .thinking('Resume from the log analysis. The key facts: schema 12 backup, migration 13→14 IO_ERROR, unwrap panic at state.rs:341.')
    .unknown('Unsupported Codex item: collabAgentToolCall')
    .assistant(CRASH_ANSWER);
  return sessionRecord({
    id: demoSessionId('crash'), workspaceId: DEMO_PROJECTS.piui, harness: 'codex', title: 'Investigate crash on startup',
    blocks: transcript.build(), updatedAt: transcript.lastInstant(), model: model('codex', 'openai-lab', 'gpt-lab-5-mini'),
    thinkingLevel: 'medium',
    usage: [seededUsage('codex-session-total', 96_410, 5_870)],
    queue: {
      paused: true,
      items: [{
        id: labUuid('demo:queue:crash-uncertain'),
        text: 'Also check whether safe mode starts with the read-only index.',
        status: 'uncertain',
        error: 'Delivery could not be confirmed. Check native history before dismissing this message.',
      }],
    },
  });
}

function compaction(): LabSeed['sessions'][number] {
  const transcript = new TranscriptBuilder('pi', 'compaction', LAB_BASE_TIME - 2 * DAY - 6 * HOUR);
  COMPACTION_TOPICS.forEach((topic, index) => {
    transcript.user(topic, 180).assistant(compactionAnswer(topic, index));
    if (index === 2) transcript.compaction(COMPACTION_SUMMARY);
  });
  transcript
    .custom('permission-guard', 'Extension note: 2 tool calls were blocked by the project policy during this session.')
    .user('Generate a complete field reference for workspace protocol v15.', 240)
    .assistant(longReferenceAnswer());
  return sessionRecord({
    id: demoSessionId('compaction'), workspaceId: DEMO_PROJECTS.piui, harness: 'pi', title: 'Session compaction deep-dive',
    blocks: transcript.build(), updatedAt: transcript.lastInstant(), model: model('pi', 'openai-lab', 'gpt-lab-5'), thinkingLevel: 'high',
    usage: [seededUsage('compaction-1', 412_880, 38_020)],
  });
}

function storyboard(): LabSeed['sessions'][number] {
  const transcript = new TranscriptBuilder('prime-agent', 'storyboard', LAB_BASE_TIME - 3 * HOUR - 20 * MINUTE, DEMO_FOLDERS.video)
    .user(STORYBOARD_PROMPT)
    .thinking('Six shots in 45 seconds: roughly 7 seconds each, front-load motion, end on the logo with a single note.')
    .custom('Prime subagent', 'Native Prime subagent drafted three alternative openings; the second was kept.')
    .command('ls assets/brand', 'logo-lockup.svg\npalette-warm.json\nfont-display.woff2')
    .assistant(STORYBOARD_ANSWER);
  return sessionRecord({
    id: demoSessionId('storyboard'), workspaceId: DEMO_PROJECTS.video, harness: 'prime-agent', title: 'Storyboard the launch trailer',
    blocks: transcript.build(), updatedAt: transcript.lastInstant(), model: model('prime-agent', 'prime-lab', 'prime-lab-small'),
    thinkingLevel: 'low',
  });
}

function renderFarm(): LabSeed['sessions'][number] {
  const transcript = new TranscriptBuilder('hermes', 'render-farm', LAB_BASE_TIME - 42 * MINUTE, DEMO_FOLDERS.video)
    .user(RENDER_PROMPT)
    .read('render.yaml', RENDER_CONFIG)
    .assistant(RENDER_PARTIAL, 'failed')
    .error(RENDER_ERROR);
  return sessionRecord({
    id: demoSessionId('render-farm'), workspaceId: DEMO_PROJECTS.video, harness: 'hermes', title: 'Render farm config review',
    blocks: transcript.build(), updatedAt: transcript.lastInstant(), model: model('hermes', 'nous-lab', 'hermes-lab-8b'), live: 'failed',
  });
}

function audit(): LabSeed['sessions'][number] {
  const transcript = new TranscriptBuilder('codex', 'audit', LAB_BASE_TIME - 9 * DAY, DEMO_FOLDERS.legacy)
    .user(AUDIT_PROMPT)
    .search('rg -n "token ==|COST|No such user|createdAt" src/auth', AUDIT_GREP_OUTPUT)
    .assistant(AUDIT_ANSWER);
  return sessionRecord({
    id: demoSessionId('audit'), workspaceId: DEMO_PROJECTS.legacy, harness: 'codex', title: 'Audit legacy auth module',
    blocks: transcript.build(), updatedAt: transcript.lastInstant(), model: model('codex', 'openai-lab', 'o-lab-deep'),
    thinkingLevel: 'high', permissionMode: 'read-only',
  });
}

/** A live Claude Code chat on the user's subscription, near its usage limit. */
function keymap(): LabSeed['sessions'][number] {
  const transcript = new TranscriptBuilder('claude-code', 'keymap', LAB_BASE_TIME - 26 * MINUTE)
    .user(KEYMAP_PROMPT)
    .thinking(KEYMAP_THINKING)
    .search(KEYMAP_GREP_COMMAND, KEYMAP_GREP_OUTPUT)
    .read('apps/desktop/src/app/pipelines/PipelineEditor.svelte', "window.addEventListener('keydown', onKeydown);")
    .custom('Usage limit', 'Your Claude subscription usage is close to its limit. It resets at 2026-09-26T18:00:00.000Z.')
    .assistant(KEYMAP_ANSWER);
  return sessionRecord({
    id: demoSessionId('keymap'), workspaceId: DEMO_PROJECTS.piui, harness: 'claude-code', title: 'Map pipeline editor shortcuts',
    blocks: transcript.build(), updatedAt: transcript.lastInstant(), model: model('claude-code', 'anthropic', 'lab-opus'),
    thinkingLevel: 'xhigh', permissionMode: 'workspace-write', live: 'idle',
    usage: [seededUsage('claude-keymap-1', 28_410, 1_960)],
  });
}

/** A live Pi chat for replaying extension UI; see `extensionDemo.ts`. */
function extensionPlayground(): LabSeed['sessions'][number] {
  const transcript = new TranscriptBuilder('pi', 'extensions', LAB_BASE_TIME - 7 * MINUTE)
    .user('What can Pi extensions show in PiUI?')
    .assistant(
      `Send **${EXTENSION_DEMO_COMMAND}** in this chat. A lab extension then shows a notice, two statuses, a checklist `
      + 'panel, a window title and prepared text for the message box, and asks four questions the way Pi extensions do: '
      + 'confirm, choose, answer and edit a draft.',
    );
  return sessionRecord({
    id: demoSessionId('extensions'), workspaceId: DEMO_PROJECTS.piui, harness: 'pi', title: 'Pi extension playground',
    blocks: transcript.build(), updatedAt: transcript.lastInstant(), model: model('pi', 'anthropic-lab', 'claude-lab-haiku'),
    thinkingLevel: 'low', live: 'idle',
  });
}

/** Twelve chat sessions across all five harnesses and every block kind. */
export function demoChats(): { sessions: LabSeed['sessions']; activity: SeedActivity[] } {
  const pending = scheduler();
  const streaming = renderer();
  return {
    sessions: [
      lisbon(), lifetimes(), transport(), pending.record, streaming.record,
      crash(), compaction(), storyboard(), renderFarm(), audit(), keymap(), extensionPlayground(),
    ],
    activity: [pending.activity, streaming.activity],
  };
}
