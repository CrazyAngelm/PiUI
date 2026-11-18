import type { TimelineBlock } from '../../host-api/types';

/**
 * Service data is decided by where a block came from, never by what its text
 * looks like: a person who asks for JSON gets an answer that is JSON, and the
 * chat must show it as the answer. Only a block the protocol itself ties to a
 * tool call (an assistant-kind block that names a tool) is folded into a closed
 * "Service data" row. A bridge that mislabels tool arguments as an answer is
 * fixed in the bridge, not guessed at here.
 */
export function isServiceData(block: Pick<TimelineBlock, 'kind' | 'toolName'>): boolean {
  return block.kind === 'assistant' && typeof block.toolName === 'string' && block.toolName !== '';
}
