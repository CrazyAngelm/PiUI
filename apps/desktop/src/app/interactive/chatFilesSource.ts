import { previewChatFile, resolveChatFile } from '../../host-api/chatFilesClient';
import type { InteractiveFileSource } from './files';

/**
 * The files of one chat (ADR-074) as the source an answer's `file` names resolve through. The
 * session is read at each call, so a transcript that is shown for another chat later never
 * resolves a name against the previous one. No session: nothing is there.
 */
export function chatFilesSource(sessionId: () => string | undefined): InteractiveFileSource {
  return {
    async resolve(name) {
      const id = sessionId();
      return id === undefined ? null : resolveChatFile(id, name);
    },
    async preview(fileId) {
      const id = sessionId();
      if (id === undefined) throw new Error('No chat');
      const { mediaType, data } = await previewChatFile(id, fileId);
      return { mediaType, data };
    },
  };
}
