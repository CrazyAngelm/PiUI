import { liveLabel } from './catalogFake';
import type { DesktopTimelineBlock, WorkspaceExtensionUiAction } from './labContracts';
import { createRandom } from './labRandom';
import { streamSteps, usageStep, type ApprovalStep, type TurnContext, type TurnStep } from './turnScripts';

/**
 * UI Lab replay of a Pi extension using every `extension_ui_request` method
 * the new shell shows: notices, statuses, widgets above and below the message
 * box, the window title, prepared composer text, an unsupported request, and
 * the four dialog kinds as the Pi bridge maps them (confirm → permission;
 * select → choices; input; editor with prefill and a native timeout).
 * Type the command in any trusted Pi chat.
 */
export const EXTENSION_DEMO_COMMAND = '/extension-demo';

export function isExtensionDemo(prompt: string): boolean {
  return prompt.trim().split(/\s+/)[0] === EXTENSION_DEMO_COMMAND;
}

const surface = (action: WorkspaceExtensionUiAction): TurnStep => ({ kind: 'extensionUi', action });
const wait = (ms: number): TurnStep => ({ kind: 'wait', ms });
// Opaque ids and keys as the host projects them (`piui-extension-…`).
const key = (kind: string, name: string) => `piui-extension-${kind}-lab-${name}`;
const notice = (name: string, message: string, level: 'info' | 'warning' | 'error'): TurnStep =>
  surface({ action: 'notify', id: `piui-extension-lab-${name}`, message, level });

/** Each dialog continues the replay whether it is answered or declined. */
function dialog(approval: ApprovalStep['approval'], answered: string, declined: string, next: readonly TurnStep[]): ApprovalStep {
  return {
    kind: 'approval',
    approval,
    approved: [notice(`${approval.title}-answered`, answered, 'info'), wait(250), ...next],
    declined: [notice(`${approval.title}-declined`, declined, 'warning'), wait(250), ...next],
  };
}

export function extensionDemoTurn(context: TurnContext, prompt: string): TurnStep[] {
  const random = createRandom(`${context.sessionId}:extension-demo:${context.turn}`);
  const id = (name: string) => `live-${context.sessionId.slice(0, 8)}-x${context.turn}-${name}`;
  const block = (name: string, kind: 'user' | 'assistant'): DesktopTimelineBlock => ({
    id: id(name), kind, label: liveLabel(context.harness, kind), status: 'complete',
  });
  const closing: TurnStep[] = [
    surface({ action: 'status', key: key('status', 'checks'), text: 'Checks: passed' }),
    surface({ action: 'widget', key: key('widget', 'tip'), lines: ['Tip: extension panels can sit below the message box too.'], placement: 'belowEditor' }),
    surface({ action: 'unsupported', id: 'piui-extension-lab-custom', method: 'unsupported', safeSummary: 'This extension UI request is not supported.' }),
    surface({ action: 'editorText', text: 'Summarize what the extension showed.' }),
    wait(200),
    ...streamSteps(block('done', 'assistant'), 'Done. The statuses and panels stay while this chat’s agent runs; stopping the agent clears them. The prepared text went into the message box (or waits as a suggestion if you had typed something).', random, 'delta', [20, 50]),
    usageStep(context, random),
    { kind: 'end', outcome: 'succeeded' },
  ];
  const editor = dialog(
    {
      kind: 'input',
      title: 'Edit the release note',
      description: 'The extension prepared a draft. Edit it or send it as is; it closes by itself after two minutes.',
      decisions: ['approve-once', 'cancel'],
      inputLabel: 'Release note',
      prefill: 'feat(history): read Pi sessions and their branches in PiUI',
      timeoutMs: 120_000,
    },
    'Release note saved.',
    'Release note skipped.',
    closing,
  );
  const input = dialog(
    {
      kind: 'input',
      title: 'Name the preview',
      description: 'Pi needs a response to continue.',
      decisions: ['approve-once', 'cancel'],
      inputLabel: 'Preview name',
    },
    'Preview named.',
    'No preview name given.',
    [editor],
  );
  const select = dialog(
    {
      kind: 'input',
      title: 'Where should the preview go?',
      description: 'Pi needs a response to continue.',
      decisions: ['approve-once', 'cancel'],
      options: [
        { id: 'option-1', label: 'Staging' },
        { id: 'option-2', label: 'Preview' },
        { id: 'option-3', label: 'Nowhere yet' },
      ],
    },
    'Target chosen.',
    'No target chosen.',
    [input],
  );
  const confirm = dialog(
    {
      kind: 'permission',
      title: 'Build a preview?',
      description: 'The extension wants to run the preview build. It only reads the project.',
      decisions: ['approve-once', 'deny', 'cancel'],
    },
    'Preview build allowed.',
    'Preview build declined.',
    [select],
  );
  return [
    { kind: 'status', status: 'running' },
    { kind: 'block', block: { ...block('prompt', 'user'), text: prompt } },
    wait(300),
    notice('start', 'Extension demo: notices, statuses and panels appear next to the message box.', 'info'),
    surface({ action: 'status', key: key('status', 'checks'), text: 'Checks: running' }),
    surface({ action: 'status', key: key('status', 'branch'), text: 'Branch: feat/classic-port' }),
    surface({ action: 'widget', key: key('widget', 'checklist'), lines: ['Release checklist', '1. Tests pass', '2. Docs updated', '3. Preview checked'], placement: 'aboveEditor' }),
    surface({ action: 'title', title: 'Extension demo' }),
    ...streamSteps(block('intro', 'assistant'), 'The extension will ask four questions: a confirmation, a choice, a short answer and an editable draft.', random, 'delta', [20, 50]),
    wait(250),
    confirm,
  ];
}
