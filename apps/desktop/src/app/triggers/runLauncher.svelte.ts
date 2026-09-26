/**
 * "Run a pipeline" requested from a chat (`/run`) or the command palette.
 * A small cross-screen domain store: the shell mounts the dialog while a
 * request is open. Nothing is written into the chat's native history.
 */
export interface RunLaunchRequest {
  /** The project whose saved pipelines are offered; the chat's project when started from a chat. */
  readonly workspaceId: string | undefined;
  /** The chat that asked, recorded on the run as its `chat` trigger. */
  readonly sessionId: string | undefined;
}

class RunLauncher {
  request = $state.raw<RunLaunchRequest | undefined>();

  open(workspaceId: string | undefined, sessionId: string | undefined = undefined): void {
    this.request = { workspaceId, sessionId };
  }

  close(): void {
    this.request = undefined;
  }
}

export const runLauncher = new RunLauncher();
