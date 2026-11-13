// Real Tauri command guards and WebView2 media decoding. The renderer's artwork
// is generated in memory by the synthetic Lab helper; this is not provider proof.
export async function runAvatarWebview2Proof({ automation, safe }) {
  const result = await automation.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const scope = await invoke('nano_avatar_scope_v1');
    let refusal;
    try { await invoke('nano_avatar_load_v1', { request: { context: 'synthetic-stale-context' } }); }
    catch (error) { refusal = error.code; }
    return { scope, refusal, visible: document.querySelectorAll('canvas.pet').length };
  })()`);
  if (result.scope.protocol !== 1 || result.scope.context !== null || result.scope.workspaceId !== null || result.visible !== 0) {
    throw new Error('Unavailable avatars left an active scope or visible decoration.');
  }
  if (result.refusal !== (safe ? 'safe-mode' : 'feature-unavailable')) {
    throw new Error('Native avatar load did not refuse the unavailable account.');
  }
  const checks = [safe ? 'native-safe-mode-avatar-refused' : 'native-signed-out-avatar-refused'];
  if (safe) return { checks };

  const rendered = await automation.evaluate(`import('/e2e/avatar-native-fixture.ts').then(module => module.proveAvatarRendering())`);
  if (!rendered.visible || !rendered.reducedFrame || !rendered.rejected || !rendered.released || !rendered.removed) {
    throw new Error(`Native avatar rendering or cleanup failed: ${JSON.stringify(rendered)}`);
  }
  checks.push('webview2-synthetic-avatar-decode-paint-and-release', 'webview2-descriptor-reduced-motion-frame', 'webview2-corrupt-avatar-refused');
  return { checks, timings: rendered.timings };
}
