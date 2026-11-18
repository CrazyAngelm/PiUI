import { summarizeInteractiveBlocks } from '../interactive/summaries';
import { messageText } from './messageActions';

type Reader = Parameters<typeof messageText>[1];

/** Copies a message and keeps its "copied" state for a moment. A failed copy throws. */
export class CopyFeedback {
  /** The block that was copied last, while its state shows. */
  id = $state('');
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly write: (text: string) => Promise<void> = (text) => navigator.clipboard.writeText(text),
    private readonly duration = 1500,
  ) {}

  async copy(block: Parameters<typeof messageText>[0], readHistory: Reader = undefined): Promise<void> {
    // A live interactive block is not text to paste: its one-line summary is.
    const text = await messageText(block, readHistory);
    await this.write(block.kind === 'assistant' ? summarizeInteractiveBlocks(text) : text);
    this.id = block.id;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.id = '';
      this.timer = undefined;
    }, this.duration);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
