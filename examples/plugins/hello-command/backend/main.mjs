import { startPluginBackend } from './piui-plugin-backend.mjs';

// The hello-command example backend. PiUI starts it with Node.js the first
// time "Say hello" runs and stops it when the plugin is disabled or PiUI
// quits. It only answers: no files, no network.
startPluginBackend({
  commands: {
    'say-hello': ({ settings, context }) => {
      const greeting = typeof settings.greeting === 'string' && settings.greeting.trim() ? settings.greeting.trim() : 'Hello';
      const where = context.chat ? ` to “${context.chat.title}”` : '';
      return {
        notice: `${greeting}${where} from the Hello command plugin!`,
        ...(settings.prepareText === true && context.chat ? { text: `${greeting}! Could you summarize where we are?` } : {}),
      };
    },
  },
});
