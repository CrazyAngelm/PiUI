/**
 * Native Computer Use grant for one local chat. Leaving enabled undefined
 * reads state; false revokes even an already-running MCP process.
 */
export interface ComputerUseSettings {
  protocol: 1;
  available: boolean;
  enabled: boolean;
}
