import { describe, expect, it } from 'vitest';
import { SESSION_TOOL_ERROR_COPY } from '../../../host-api/sessionToolErrors';
import { BRANCH_POINT_COPY } from '../../../app/branch/branchChat';
import { translate } from '../language';
import { branchRu } from './branch';

const translated = (key: string): boolean => translate(key, 'ru') !== key || branchRu[key] === key;

describe('Russian copy for branches and message actions', () => {
  it('translates the message action labels of the shared transcript', () => {
    const keys = [
      'Message actions',
      'Copy message',
      'Edit and send again',
      'Branch into a new chat',
      'Repeat request',
      'Refresh conversation',
      'Copied',
      'Could not complete the message action.',
    ];
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('translates the /btw command, the chat origin, the title suffix and every refusal', () => {
    const keys = [
      'Ask a side question in a branch of this chat',
      'Branch of',
      'branch',
      'The branch could not be created.',
      'The whole message could not be read. No branch was created.',
      'Linked branch: it starts from a summary. The history was not copied.',
      'Linked branch: it starts empty. The history was not copied.',
      'A linked branch: the history was not copied.',
      'Four chats are on screen. The branch "{0}" was created but not opened.',
      'A side question carries text only. Remove the attachments or send them in this chat.',
      BRANCH_POINT_COPY,
      SESSION_TOOL_ERROR_COPY.BRANCH_UNSUPPORTED ?? '',
      SESSION_TOOL_ERROR_COPY.BRANCH_POINT_NOT_FOUND ?? '',
    ];
    expect(keys.every((key) => key !== '')).toBe(true);
    expect(keys.filter((key) => !translated(key))).toEqual([]);
  });

  it('keeps placeholders intact', () => {
    for (const [key, value] of Object.entries(branchRu)) {
      const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
