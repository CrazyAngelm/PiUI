import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const app = await readFile(resolve(root, 'src/app/App.svelte'), 'utf8');
const emptyState = await readFile(resolve(root, 'src/components/EmptyState.svelte'), 'utf8');
const sidebar = await readFile(resolve(root, 'src/features/projects/ProjectSidebar.svelte'), 'utf8');
const commandPalette = await readFile(resolve(root, 'src/features/navigation/CommandPalette.svelte'), 'utf8');
const chatPanel = await readFile(resolve(root, 'src/features/runtime/ChatPanel.svelte'), 'utf8');
const extensionUiDialog = await readFile(resolve(root, 'src/features/runtime/ExtensionUiDialog.svelte'), 'utf8');
const modelPicker = await readFile(resolve(root, 'src/features/runtime/ModelPicker.svelte'), 'utf8');
const extensionUiState = await readFile(resolve(root, 'src/features/runtime/extensionUiState.ts'), 'utf8');
const runtimeCommands = await readFile(resolve(root, 'src/features/runtime/runtimeCommands.ts'), 'utf8');
const timeline = await readFile(resolve(root, 'src/features/sessions/Timeline.svelte'), 'utf8');
const activityGroup = await readFile(resolve(root, 'src/features/sessions/ActivityGroup.svelte'), 'utf8');
const timelineView = await readFile(resolve(root, 'src/features/sessions/timelineView.ts'), 'utf8');
const markdown = await readFile(resolve(root, 'src/components/MarkdownContent.svelte'), 'utf8');
const catalogView = await readFile(resolve(root, 'src/features/sessions/catalogView.ts'), 'utf8');
const projectSessionPagination = await readFile(resolve(root, 'src/features/sessions/projectSessionPagination.ts'), 'utf8');
const sessionPersistenceFeedback = await readFile(resolve(root, 'src/features/runtime/sessionPersistenceFeedback.ts'), 'utf8');
const settings = await readFile(resolve(root, 'src/features/settings/SettingsView.svelte'), 'utf8');
const tokens = await readFile(resolve(root, 'src/styles/tokens.css'), 'utf8');
const hostClient = await readFile(resolve(root, 'src/host-api/client.ts'), 'utf8');

for (const requiredText of ['TrustDialog', 'ReadOnlyTree', 'SettingsView', 'listExtensions', 'listPiUiContributions', 'setExtensionEnabled', 'openNewChat', 'getSessionCatalog', 'refreshSessionCatalog', 'listenSessionCatalogEvents', 'listenSessionRootHints', 'waitForCurrentProjectCatalog', 'waitForCurrentPersonalCatalog', 'projectRecoveryEpoch', 'pendingProjectSessionResolution', 'newChatProjectId', 'composingPersonalChat', 'resolveNewCatalogSession', 'retryPersistedSessionDiscovery', 'historyScroller', 'handleHistoryScroll', 'scrollHistoryToLatest', 'nextBrowserFrame', 'height: 100dvh', 'updateFontSize', 'updateChatWidth', 'applyPreferences(next)', 'applyPreferences(previous)', '<EmptyState fill={true} eyebrow="Chats"', '<EmptyState fill={true} eyebrow="Session history"']) {
  if (!app.includes(requiredText)) {
    throw new Error(`Foundation UI smoke check is missing: ${requiredText}`);
  }
}

for (const requiredText of ['New chat', 'Chats', 'personalDraftActive', 'onSelectPersonalSession', 'aria-expanded', 'Scanning local Pi sessions', 'Show all (', 'session-pagination']) {
  if (!sidebar.includes(requiredText)) {
    throw new Error(`Chats sidebar smoke check is missing: ${requiredText}`);
  }
}
if (sidebar.includes('entries ·') || sidebar.includes('session-meta')) {
  throw new Error('Session rows must not display redundant entry-count or health text.');
}
if (commandPalette.includes('entries ·') || commandPalette.includes('result-meta')) {
  throw new Error('Search results must not display redundant entry-count or health text.');
}

for (const requiredText of ['startPersonalChat', 'loadCatalogFromCurrentRuntime', 'getRuntimeCommands', 'respondExtensionUi', 'ExtensionUiDialog', 'Extension composer actions', 'ensureRuntimeCommandCatalog', 'aria-activedescendant', 'Pi commands', 'CATALOG_STORAGE_KEY', 'Load models…', 'ModelPicker', 'Finishing history sync…', 'onRequestTrust', 'Review trust', 'composer-submit', 'Stop current turn', 'Thinking', 'onNewSessionStarting', 'onNewSessionStartAborted', 'onRetryPersistedSession', 'Try again', 'onBlocksChanged', 'projectLiveBlock', 'onNewChatProjectChange', 'aria-label="Project"', 'runtimeSessionKey', 'schedulePersistenceFeedback', 'reconcilePersistedSession']) {
  if (!chatPanel.includes(requiredText)) {
    throw new Error(`Personal-chat runtime smoke check is missing: ${requiredText}`);
  }
}
for (const requiredText of ['Choose model', 'Find a model…', 'Available models', 'Unavailable', 'aria-haspopup="dialog"', 'providerDisplayName', 'role="listbox"']) {
  if (!modelPicker.includes(requiredText)) throw new Error(`Themed model picker smoke check is missing: ${requiredText}`);
}
if (chatPanel.includes('select aria-label="Model"')) throw new Error('The model picker must not fall back to the native unthemed select menu.');
for (const requiredText of ['<dialog', 'aria-modal="true"', 'Cancel', "'Yes'", "'Submit'", 'data-extension-option']) {
  if (!extensionUiDialog.includes(requiredText)) throw new Error(`Extension dialog smoke check is missing: ${requiredText}`);
}
for (const requiredText of ['MAX_QUEUED_DIALOGS = 32', 'editorSuggestion', 'unsupported', 'aboveEditor']) {
  if (!extensionUiState.includes(requiredText)) throw new Error(`Extension UI mailbox smoke check is missing: ${requiredText}`);
}
for (const requiredText of ['slashCommandQuery', 'filterRuntimeCommands', 'runtimeCommandProvenance', 'package']) {
  if (!runtimeCommands.includes(requiredText)) throw new Error(`Runtime command aperture smoke check is missing: ${requiredText}`);
}
if (!commandPalette.includes('Pi commands') || !commandPalette.includes('runtimeCommandProvenance') || !commandPalette.includes('applyPiUiCommandContributions')) throw new Error('Command palette must expose Pi commands with provenance and declarative labels.');

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
for (const command of ["'get_runtime_commands'", "'respond_extension_ui'", "'list_piui_contributions'"]) {
  if (!hostClient.includes(command)) throw new Error(`Extension host command smoke check is missing: ${command}`);
}
if (!catalogView.includes('acceptsCatalogSnapshot') || !catalogView.includes('sequence')) throw new Error('Cache-first catalog watermark guard is missing.');
if (!projectSessionPagination.includes('PROJECT_SESSION_PAGE_SIZE = 5') || !projectSessionPagination.includes('nextProjectSessionCount')) throw new Error('Project session pagination must reveal five-session pages.');
if (!sessionPersistenceFeedback.includes('SESSION_PERSISTENCE_FEEDBACK_DELAY_MS') || !sessionPersistenceFeedback.includes('didResolveNewSession') || !sessionPersistenceFeedback.includes('resolveNewCatalogSession') || !sessionPersistenceFeedback.includes('withoutPersistedLiveBlocks')) throw new Error('New-session persistence feedback must tolerate incomplete catalog baselines without dropping queued output.');
if (markdown.includes('{@html')) throw new Error('Markdown renderer must not render raw HTML.');
if (chatPanel.includes('chat-stream')) throw new Error('Live output must share the canonical timeline scroll.');
if (!emptyState.includes('export let fill = false') || !emptyState.includes('.empty-state--fill')) throw new Error('Empty chat states must fill the history region so the composer stays at the bottom.');

await access(resolve(root, 'dist/index.html'));
console.log('PiUI static UI smoke check passed (not a browser/Tauri E2E test).');
