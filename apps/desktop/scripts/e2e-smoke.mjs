import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const app = await readFile(resolve(root, 'src/app/App.svelte'), 'utf8');
const sidebar = await readFile(resolve(root, 'src/features/projects/ProjectSidebar.svelte'), 'utf8');
const chatPanel = await readFile(resolve(root, 'src/features/runtime/ChatPanel.svelte'), 'utf8');
const timeline = await readFile(resolve(root, 'src/features/sessions/Timeline.svelte'), 'utf8');
const activityGroup = await readFile(resolve(root, 'src/features/sessions/ActivityGroup.svelte'), 'utf8');
const timelineView = await readFile(resolve(root, 'src/features/sessions/timelineView.ts'), 'utf8');
const markdown = await readFile(resolve(root, 'src/components/MarkdownContent.svelte'), 'utf8');
const catalogView = await readFile(resolve(root, 'src/features/sessions/catalogView.ts'), 'utf8');
const settings = await readFile(resolve(root, 'src/features/settings/SettingsView.svelte'), 'utf8');
const tokens = await readFile(resolve(root, 'src/styles/tokens.css'), 'utf8');
const hostClient = await readFile(resolve(root, 'src/host-api/client.ts'), 'utf8');

for (const requiredText of ['TrustDialog', 'ReadOnlyTree', 'SettingsView', 'listExtensions', 'setExtensionEnabled', 'openNewChat', 'getSessionCatalog', 'refreshSessionCatalog', 'listenSessionCatalogEvents', 'listenSessionRootHints', 'waitForCurrentProjectCatalog', 'waitForCurrentPersonalCatalog', 'projectRecoveryEpoch', 'pendingProjectSessionResolution', 'newChatProjectId', 'composingPersonalChat', 'onlyNewCatalogSession', 'retryPersistedSessionDiscovery', 'historyScroller', 'handleHistoryScroll', 'scrollHistoryToLatest', 'nextBrowserFrame', 'height: 100dvh', 'updateFontSize', 'updateChatWidth', 'applyPreferences(next)', 'applyPreferences(previous)']) {
  if (!app.includes(requiredText)) {
    throw new Error(`Foundation UI smoke check is missing: ${requiredText}`);
  }
}

for (const requiredText of ['New chat', 'Chats', 'onSelectPersonalSession', 'aria-expanded', 'Scanning local Pi sessions']) {
  if (!sidebar.includes(requiredText)) {
    throw new Error(`Chats sidebar smoke check is missing: ${requiredText}`);
  }
}

for (const requiredText of ['startPersonalChat', 'loadCatalogFromCurrentRuntime', 'CATALOG_STORAGE_KEY', 'Load models…', 'No user folder is attached', 'onRequestTrust', 'Review trust', 'composer-submit', 'Stop current turn', 'Thinking', 'onNewSessionStarting', 'onNewSessionStartAborted', 'onRetryPersistedSession', 'Retry discovery', 'onBlocksChanged', 'projectLiveBlock', 'onNewChatProjectChange', 'aria-label="Project"', 'runtimeSessionKey']) {
  if (!chatPanel.includes(requiredText)) {
    throw new Error(`Personal-chat runtime smoke check is missing: ${requiredText}`);
  }
}

for (const requiredText of ['MarkdownContent', 'ActivityGroup', 'groupTimelineBlocks', 'Compatibility view', '--piui-chat-column-width', '--piui-chat-reading-width']) {
  if (!timeline.includes(requiredText)) throw new Error(`Semantic timeline smoke check is missing: ${requiredText}`);
}
for (const requiredText of ['activity-group', 'activity-rows', 'ontoggle', 'Copy', 'Long output was shortened']) {
  if (!activityGroup.includes(requiredText)) throw new Error(`Activity group smoke check is missing: ${requiredText}`);
}
for (const requiredText of ['TimelineActivityGroup', 'groupTimelineBlocks', 'shouldAutoOpenActivity', 'completed']) {
  if (!timelineView.includes(requiredText)) throw new Error(`Timeline view smoke check is missing: ${requiredText}`);
}
for (const requiredText of ['parseMarkdown', 'code-block', 'Copy', 'safe-link', '--piui-chat-font-size']) {
  if (!markdown.includes(requiredText)) throw new Error(`Safe Markdown smoke check is missing: ${requiredText}`);
}
for (const requiredText of ['Appearance', 'Chat text size', 'Conversation width', 'font-size-preference', 'chat-width-preference']) {
  if (!settings.includes(requiredText)) throw new Error(`Appearance settings smoke check is missing: ${requiredText}`);
}
for (const requiredText of ['--piui-chat-column-width: 1280px', 'data-font-size="large"', 'data-chat-width="centered"']) {
  if (!tokens.includes(requiredText)) throw new Error(`Appearance tokens smoke check is missing: ${requiredText}`);
}
if (!hostClient.includes("'update_preferences_v8'")) throw new Error('Appearance preferences must use the versioned v8 host command.');
if (!catalogView.includes('acceptsCatalogSnapshot') || !catalogView.includes('sequence')) throw new Error('Cache-first catalog watermark guard is missing.');
if (markdown.includes('{@html')) throw new Error('Markdown renderer must not render raw HTML.');
if (chatPanel.includes('chat-stream')) throw new Error('Live output must share the canonical timeline scroll.');

await access(resolve(root, 'dist/index.html'));
console.log('PiUI static UI smoke check passed (not a browser/Tauri E2E test).');
