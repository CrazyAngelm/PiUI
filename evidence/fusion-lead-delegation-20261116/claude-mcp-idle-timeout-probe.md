# Claude Code MCP idle limit and alwaysLoad probe (2026-11-16)

Real provider run on the person's Claude subscription. Not synthetic.

- Claude Code 2.1.325, `claude -p --model haiku --strict-mcp-config`, one HTTP MCP
  server on loopback with `"timeout": 600000` in `--mcp-config`, `MCP_TOOL_TIMEOUT=600000`.
- The server listed two tools: `slow` with `_meta: {"anthropic/alwaysLoad": true}`, and
  `plain` without it. `slow` answered one plain JSON body after 330 s with no progress
  notification.
- Server log: `tools/call slow` at 15:37:12.538Z (request `_meta` carried
  `claudecode/toolUseId` and `progressToken`), answered at 15:42:42.551Z.
- Result: the model called `mcp__probe__slow` directly, with no `ToolSearch` call first,
  and received "slow answered after 330s"; the run ended `success` after 336544 ms.

Before the change, real Fusion lead sessions failed the same kind of call at 300 s with
"MCP server "piui-workspace" tool "sidekick" sent no response or progress for 300s;
aborting" (a `wait` of 420 s, and a `brief` whose default 240 s wait came after the
sidekick's start-up).

Conclusion: the per-server `timeout` lifts Claude Code's 300 s MCP idle abort, so the
bridge sets it on the session's `piui-workspace` server when the `sidekick` or `sessions`
tool is enabled; `anthropic/alwaysLoad` is honoured on a listed tool.
