import { startPluginBackend } from './piui-plugin-backend.mjs';

// The status-tools example backend (manifest version 2). The status item
// and the keybinding run "chat-title"; PiUI starts this backend under Node's
// permission model, so it only answers: no files, no programs, no network.
startPluginBackend({
  commands: {
    'chat-title': ({ context }) => {
      if (!context.chat) return { notice: 'Open a chat to see its title.' };
      const words = context.chat.title.trim().split(/\s+/u).filter(Boolean).length;
      return { notice: `“${context.chat.title}” (${words} ${words === 1 ? 'word' : 'words'})` };
    },
  },
});
