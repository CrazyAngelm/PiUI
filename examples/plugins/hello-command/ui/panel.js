// Inline scripts are blocked in plugin panels: code lives in files.
const panel = window.piuiPanel;
const chat = document.getElementById('chat');
const greeting = document.getElementById('greeting');

function showChat(context) {
  chat.textContent = context.chat ? `Open chat: ${context.chat.title}` : 'No chat is open.';
}

async function showGreeting() {
  const settings = await panel.getSettings();
  greeting.textContent = `Greeting: ${settings.greeting ?? 'Hello'}`;
}

panel.ready.then(async () => {
  showChat(await panel.getContext());
  await showGreeting();
});
panel.on('context', showChat);

document.getElementById('hello').addEventListener('click', () => {
  panel.runCommand('say-hello').catch((error) => panel.showNotice(error.message, 'error'));
});

document.getElementById('louder').addEventListener('click', async () => {
  await panel.setSettings({ greeting: 'Hi' });
  await showGreeting();
  await panel.showNotice('The greeting is now “Hi”.');
});
