import { readyHarnesses } from '../catalogFake';
import { DAY, LAB_BASE_TIME } from '../labClock';
import { createRandom, labUuid, type LabRandom } from '../labRandom';
import type { LabProject } from '../labState';
import { TranscriptBuilder } from '../transcriptBuilder';
import { LIVE_COMMANDS, LIVE_REPLY_SECTIONS, LIVE_THINKING } from '../transcriptSamples';
import { sessionRecord, seededUsage, type LabSeed } from './seedTypes';

/** One very long Pi transcript (~3,000 blocks) for scroll, search and render performance work. */
const TURNS = 750;
const QUESTIONS = [
  'Why does the timeline re-render on every delta?',
  'Can we virtualize completed messages?',
  'What is the p95 parse time per chunk?',
  'Show me the flame graph summary.',
  'Does search still work with virtualization?',
  'Summarize what changed since the last checkpoint.',
];

function answer(random: LabRandom, turn: number): string {
  const first = random.pick(LIVE_REPLY_SECTIONS);
  const second = random.pick(LIVE_REPLY_SECTIONS);
  return [`## Checkpoint ${turn + 1}`, '', `Measured **${random.int(2, 90)} ms** for ${random.int(50, 900)} blocks.`, '', first, '', second]
    .join('\n');
}

function output(random: LabRandom): string {
  const base = random.pick(LIVE_COMMANDS).output.split('\n');
  const lines = Array.from({ length: random.int(1, 6) }, () => base).flat();
  return lines.join('\n');
}

export function longSeed(): LabSeed {
  const personal: LabProject = {
    id: labUuid('long:project:chats'), name: 'Chats', displayPath: '~/.piui-lab/chats', agentKind: 'pi',
    trustState: 'trusted', pinned: false, missing: false, personal: true,
  };
  const project: LabProject = {
    id: labUuid('long:project:perf-lab'), name: 'perf-lab', displayPath: '~/lab/perf-lab', agentKind: 'pi',
    trustState: 'trusted', pinned: true, missing: false, personal: false,
  };
  const random = createRandom('long-transcript');
  const transcript = new TranscriptBuilder('pi', 'long', LAB_BASE_TIME - 14 * DAY);
  for (let turn = 0; turn < TURNS; turn += 1) {
    const command = random.pick(LIVE_COMMANDS).command;
    transcript
      .user(`${random.pick(QUESTIONS)} (#${turn + 1})`, 30)
      .thinking(random.pick(LIVE_THINKING), 3)
      .command(command, output(random), random.chance(0.04) ? 'failed' : 'complete', 6)
      .assistant(answer(random, turn), 'complete', 9);
  }
  const blocks = transcript.build();
  const session = sessionRecord({
    id: labUuid('long:session:stress'),
    workspaceId: project.id,
    harness: 'pi',
    title: `Stress transcript (${blocks.length.toLocaleString('en-US')} blocks)`,
    blocks,
    updatedAt: transcript.lastInstant(),
    model: { id: 'claude-lab-sonnet', provider: 'anthropic-lab', name: 'Claude Lab Sonnet' },
    thinkingLevel: 'medium',
    usage: [seededUsage('long-total', 3_812_004, 402_117)],
  });
  return {
    safeMode: false,
    projects: [personal, project],
    harnesses: readyHarnesses(),
    sessions: [session],
    orchestration: [],
    activity: [],
  };
}
