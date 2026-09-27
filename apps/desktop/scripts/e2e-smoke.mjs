import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');
const extensionUiState = await read('src/features/runtime/extensionUiState.ts');
const timeline = await read('src/features/sessions/Timeline.svelte');
const activityGroup = await read('src/features/sessions/ActivityGroup.svelte');
const timelineView = await read('src/features/sessions/timelineView.ts');
const markdown = await read('src/components/MarkdownContent.svelte');
const catalogView = await read('src/features/sessions/catalogView.ts');
const tokens = await read('src/styles/tokens.css');
const projectsClient = await read('src/host-api/projectsClient.ts');
const extensionsClient = await read('src/host-api/extensionsClient.ts');
const pluginRegistry = await read('src/app/plugins/pluginRegistry.svelte.ts');

for (const requiredText of ['MAX_QUEUED_DIALOGS = 32', 'editorSuggestion', 'unsupported', 'aboveEditor']) {
  if (!extensionUiState.includes(requiredText)) throw new Error(`Extension UI mailbox smoke check is missing: ${requiredText}`);
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
for (const requiredText of ['--piui-chat-column-width: 1280px', 'data-font-size="large"', 'data-chat-width="centered"']) {
  if (!tokens.includes(requiredText)) throw new Error(`Appearance tokens smoke check is missing: ${requiredText}`);
}
if (!projectsClient.includes("'update_preferences_v8'")) throw new Error('Appearance preferences must use the versioned v8 host command.');
if (!projectsClient.includes("'bootstrap_v10'")) throw new Error('Startup must use the versioned v10 host command.');
for (const command of ["'list_extensions_v10'", "'set_extension_enabled_v10'"]) {
  if (!extensionsClient.includes(command)) throw new Error(`Runtime-scoped extension command is missing: ${command}`);
}
if (!pluginRegistry.includes("'list_piui_contributions'")) throw new Error('PiUI contribution discovery must use the list_piui_contributions host command.');
if (!catalogView.includes('acceptsCatalogSnapshot') || !catalogView.includes('sequence')) throw new Error('Cache-first catalog watermark guard is missing.');
if (markdown.includes('{@html')) throw new Error('Markdown renderer must not render raw HTML.');

await access(resolve(root, 'dist/index.html'));
console.log('PiUI static UI smoke check passed (not a browser/Tauri E2E test).');
