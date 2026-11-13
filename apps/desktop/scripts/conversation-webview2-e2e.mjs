// Actual shared/native-wrapper presentation in WebView2, with synthetic owners.
// The outer harness owns process containment and cleanup; no native agent runs.
export async function runConversationWebview2Proof({ automation, captureScreenshot, screenshotPath }) {
  const module = "import('/e2e/conversation-native-fixture.ts')";
  const state = () => automation.evaluate(`${module}.then(module => module.conversationProofState())`);
  const assert = (value, message) => { if (!value) throw new Error(message); };
  async function activate(label) {
    const focused = await automation.evaluate(`(() => {
      const root = document.querySelector('[data-shared-proof]');
      const button = [...root.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)});
      button?.focus(); return button && !button.disabled && document.activeElement === button;
    })()`);
    assert(focused, `Could not focus conversation action ${label}`);
    // This harness dispatches untrusted DOM key events, which do not invoke a
    // native button's default activation. Keyboard activation is proved by the
    // persistent-browser tests; here prove focus and owner routing in WebView2.
    await automation.evaluate('document.activeElement.click()');
  }
  try {
    const first = await automation.evaluate(`${module}.then(module => module.beginConversationProof())`);
    assert(first.native.includes('Native generic fallback') && first.native.includes('Native streaming'), 'Native transcript wrapper did not render its original projection.');
    await captureScreenshot({ name: 'shared-conversation', path: screenshotPath });
    await activate('notes.txt');
    await activate('Allow once');
    const acted = await state();
    assert(acted.calls.some(call => call.kind === 'attachment' && call.id === 'opaque-notes'), 'Attachment did not reach its explicit owner.');
    assert(acted.calls.some(call => call.kind === 'approval' && call.id === 'approval' && call.decision === 'approve-once'), 'Approval did not reach its explicit owner.');
    const streamed = await automation.evaluate(`${module}.then(module => module.streamConversationProof())`);
    assert(streamed.native.includes('Native streamed answer') && streamed.shared.includes('Shared streamed answer'), 'Native/shared streaming snapshots did not update.');
    await automation.evaluate(`${module}.then(module => module.disconnectConversationProof())`);
    await activate('Reconnect');
    const restored = await state();
    assert(restored.shared.includes('Recovered owner history') && restored.calls.some(call => call.kind === 'reconnect'), 'Owner reconnect did not restore the display.');
    assert(await automation.evaluate(`${module}.then(module => module.proveRetiredNativeApproval())`), 'A retired native approval leaked its failure notification.');
  } finally {
    assert(await automation.evaluate(`${module}.then(module => module.endConversationProof())`), 'Conversation proof left mounted presentation.');
  }
  return { screenshots: [screenshotPath], checks: ['webview2-native-transcript-wrapper-and-generic-fallback', 'webview2-native-and-cloud-projection-streaming', 'webview2-focus-approval-and-opaque-attachment-owner', 'webview2-owner-reconnect-and-disposal', 'webview2-retired-native-approval-does-not-notify-new-chat'] };
}
