import { ACP_LAB_MODES, harnessCapabilities, historyLabel, runtimeModels } from './catalogFake';
import { isAcpHarness } from '../../../../../contracts/harness-identity-v2';
import type { DesktopTimelineBlock, SessionSnapshot } from './labContracts';
import { sessionSummary, type LabSessionRecord, type LabState } from './labState';

/** Render limits of the host's history projection (`DISPLAY_*_LIMIT`, UTF-8 bytes). */
const MESSAGE_LIMIT = 64 * 1024;
const DETAIL_LIMIT = 16 * 1024;
const MARKER = '…';

function utf8Length(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/** `bounded_display`: keeps whole characters within the byte limit and marks the cut with `…`. */
export function boundedDisplay(text: string, limit: number): { text: string; truncated: boolean } {
  let bytes = 0;
  let output = '';
  for (const character of text) {
    const size = utf8Length(character);
    if (bytes + size > limit) {
      while (bytes + utf8Length(MARKER) > limit && output.length > 0) {
        const last = [...output].pop() ?? '';
        output = output.slice(0, output.length - last.length);
        bytes -= utf8Length(last);
      }
      return { text: `${output}${MARKER}`, truncated: true };
    }
    output += character;
    bytes += size;
  }
  return { text: output, truncated: false };
}

function displayLimit(kind: DesktopTimelineBlock['kind']): number {
  return kind === 'user' || kind === 'assistant' ? MESSAGE_LIMIT : DETAIL_LIMIT;
}

/**
 * `history_block`: closed sessions are re-read from native history with generic
 * labels and bounded text. `fullAnswers` restores complete assistant text as
 * `workspace_history_v1` does.
 */
function historyBlock(block: DesktopTimelineBlock, fullAnswers: boolean): DesktopTimelineBlock {
  const bounded = block.text === undefined ? undefined : boundedDisplay(block.text, displayLimit(block.kind));
  const keepFull = fullAnswers && block.kind === 'assistant';
  const text = keepFull ? block.text : bounded?.text;
  const truncated = !keepFull && (bounded?.truncated === true || block.truncated === true);
  const title = block.kind === 'thinking' ? 'Reasoning' : block.kind === 'compaction' ? 'Context compacted' : block.title;
  return {
    id: block.id,
    ...(block.parentId === undefined ? {} : { parentId: block.parentId }),
    kind: block.kind,
    ...(block.createdAt === undefined ? {} : { createdAt: block.createdAt }),
    label: historyLabel(block.kind),
    ...(text === undefined ? {} : { text }),
    ...(block.kind === 'unknown' ? { safeSummary: 'An unsupported native history entry is shown by the generic fallback.' } : {}),
    ...(block.kind === 'error' && block.safeSummary !== undefined ? { safeSummary: block.safeSummary } : {}),
    ...(title === undefined ? {} : { title }),
    ...(block.toolName === undefined ? {} : { toolName: block.toolName }),
    ...(block.collapsible || block.kind === 'thinking' ? { collapsible: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(block.fallback ? { fallback: true } : {}),
    status: block.status,
  };
}

/** A live runtime snapshot: full native blocks with harness labels. */
export function liveSnapshot(state: LabState, record: LabSessionRecord): SessionSnapshot {
  const summary = state.harnesses.find((harness) => harness.kind === record.harness);
  return {
    session: sessionSummary(record),
    revision: record.revision,
    blocks: record.blocks.map((block) => ({ ...block })),
    approvals: (record.live?.approvals ?? []).map((approval) => ({ ...approval })),
    capabilities: harnessCapabilities(record.harness, summary),
    models: runtimeModels(record.harness),
    // Agent-advertised session modes (additive, ADR-034): live ACP sessions only.
    ...(isAcpHarness(record.harness)
      ? { modes: { current: record.mode ?? ACP_LAB_MODES[0]?.id ?? '', available: ACP_LAB_MODES.map((mode) => ({ ...mode })) } }
      : {}),
  };
}

/** `historical_snapshot`: process-free projection of saved native history. */
export function historicalSnapshot(state: LabState, record: LabSessionRecord): SessionSnapshot {
  const summary = state.harnesses.find((harness) => harness.kind === record.harness);
  return {
    session: { ...sessionSummary(record), status: 'closed' },
    revision: record.revision,
    blocks: savedBlocks(record).map((block) => historyBlock(block, false)),
    approvals: [],
    capabilities: harnessCapabilities(record.harness, summary),
    models: record.model === undefined ? [] : [record.model],
  };
}

/** `workspace_history_v1`: saved history with complete assistant answers. */
export function fullHistory(record: LabSessionRecord): DesktopTimelineBlock[] {
  return savedBlocks(record).map((block) => historyBlock(block, true));
}

/** Streaming text has not reached native history yet. */
function savedBlocks(record: LabSessionRecord): DesktopTimelineBlock[] {
  return record.blocks.filter((block) => block.status !== 'streaming' || block.kind === 'tool');
}
