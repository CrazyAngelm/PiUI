import { describe, expect, it } from 'vitest';
import { translate } from '../../features/locale/language';

/** Visible copy of the trigger screens (dialogs, labels, settings, notices). */
const COPY = [
  // Run a pipeline from a chat
  'Run a saved pipeline of this project', 'Run pipeline…', 'Run a pipeline', 'Saved pipelines', 'Next…', 'Start run', 'Cancel',
  'Starts a saved pipeline of {0}. The run appears in Runs; the chat is not changed.',
  'Open a chat in a project first, then run one of its pipelines.', 'This project folder is missing.',
  'Trust this folder from the sidebar to run its pipelines.', 'Safe mode keeps runs read-only.',
  'This project has no saved pipelines yet. Build one in Pipelines first.', 'This pipeline asks for inputs on the next step.',
  'Run started: {0}', 'Follow it in Runs. This chat is not changed.', 'Open run', 'Could not start the run',
  'This pipeline is no longer saved. Choose another one.',
  // Run header
  'Started by {0}', 'Started by {0} after run', 'Open run {0}', 'Started by {0} when files changed', 'chained run {0} of {1}',
  'Started from a chat',
  // Automations
  'Pause all', 'Resume automations', 'All automations are paused. Nothing starts until you resume them.',
  'Watching project files', 'Waiting for {0} to finish', 'Turn it on to react to events.',
  'Start saved pipelines on a schedule or after an event. They run while PiUI is open or in the tray.',
  'Run a pipeline every morning, when another pipeline finishes or when project files change.',
  'Runs a saved pipeline on a schedule or after an event while PiUI is open or in the tray.', 'Pipeline to run',
  'On a schedule', 'After an event', 'Event', 'When a pipeline finishes', 'When files change', 'Pipeline to wait for',
  'Start when that pipeline', 'Succeeds', 'Fails', 'Is stopped', 'Files to watch', 'Ignore', 'optional', 'seconds',
  'Wait until files are quiet for', '2 to 3600 seconds. Changes during the wait start one run together.',
  'One pattern per line, relative to the project folder. src/**/*.ts matches TypeScript files under src; *.md matches Markdown files in any folder.',
  'This automation starts the pipeline it waits for, so each run can start the next one. The chain stops after 3 automatic runs.',
  'If PiUI was closed or paused at that time',
  'Automations run only while PiUI is open or in the tray; they do not wake the computer. Each run uses your harness subscriptions like a manual run.',
  // Background mode and tray
  'Background', 'Automations keep running while PiUI is in the tray. Scheduled runs can use your paid plans.',
  'Keep running in the tray when the window is closed',
  'Closing the window hides PiUI in the tray. Quit from the tray menu stops PiUI and every agent it started.',
  'Start PiUI when I sign in to Windows', 'Start PiUI when I sign in', 'Not available in this build.',
  'PiUI starts in the tray when the option above is on; otherwise it opens its window.', 'Pause all automations',
  'Nothing starts on a schedule or after an event until you resume. Runs already working continue.',
  'Safe mode keeps background settings read-only.', 'Open PiUI', 'Quit PiUI', 'PiUI (automations paused)',
];

describe('trigger screens in Russian', () => {
  it('translate every visible string', () => {
    const missing = COPY.filter((value) => translate(value, 'ru') === value);
    expect(missing).toEqual([]);
  });
});
