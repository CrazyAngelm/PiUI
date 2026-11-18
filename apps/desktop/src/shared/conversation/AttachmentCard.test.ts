import { Tooltip } from 'bits-ui';
import { createRawSnippet, getAllContexts } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { ConversationAttachment } from '../../../../../contracts/conversation-presentation-v1';
import AttachmentCard from './AttachmentCard.svelte';

const act = async (): Promise<void> => undefined;

interface Ports {
  open?: (id: string) => Promise<void>;
  download?: (id: string) => Promise<void>;
  reveal?: (id: string) => Promise<void>;
  printMode?: boolean;
}
const ports: Ports = { open: act, download: act, reveal: act };

function card(attachment: Partial<ConversationAttachment>, props: Ports = ports): string {
  const full: ConversationAttachment = { id: 'f1', blockId: 'b1', label: 'report.pdf', downloadable: true, ...attachment };
  const children = createRawSnippet(() => ({
    render: () => `<div>${render(AttachmentCard, { props: { attachment: full, ...props }, context: getAllContexts() }).body}</div>`,
  }));
  return render(Tooltip.Provider, { props: { children } }).body.replace(/<!--[\s\S]*?-->/g, '');
}

const labels = (markup: string): string[] => [...markup.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1] ?? '');

describe('AttachmentCard folder action', () => {
  it('offers Open containing folder only for a revealable file whose owner supplies the port', () => {
    expect(labels(card({ revealable: true }))).toContain('Open containing folder');
    expect(labels(card({}))).not.toContain('Open containing folder');
    expect(labels(card({ revealable: false }))).not.toContain('Open containing folder');
    expect(labels(card({ revealable: true }, { open: act, download: act }))).not.toContain('Open containing folder');
  });

  it('hides the folder action for a file that is gone and for a printed transcript', () => {
    expect(labels(card({ revealable: true, unavailable: true }))).not.toContain('Open containing folder');
    expect(labels(card({ revealable: true }, { ...ports, printMode: true }))).not.toContain('Open containing folder');
  });

  it('names the download button Save as only for a chat file', () => {
    expect(labels(card({ saveAs: true }))).toContain('Save as…');
    expect(labels(card({ saveAs: true }))).not.toContain('Download attachment');
    expect(labels(card({}))).toContain('Download attachment');
    expect(labels(card({}))).not.toContain('Save as…');
  });

  it('leaves a card without the new fields as it was', () => {
    const markup = card({ label: 'notes.txt' });
    expect(markup).not.toContain('chat-file');
    expect(labels(markup)).toContain('Download attachment');
    expect(labels(markup)).not.toContain('Open containing folder');
    expect(markup).toContain('data-file-name="notes.txt"');
  });

  it('marks a chat file card so its preview is bounded', () => {
    expect(card({ saveAs: true })).toContain('chat-file');
  });
});
