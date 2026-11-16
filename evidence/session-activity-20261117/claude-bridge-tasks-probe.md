Date: 2026-11-16
Claude Code: 2.1.325 (Claude Code)
Model: haiku

1. PASS: A running background command was listed.
2. PASS: The background command links to a snapshot tool block.
3. PASS: The general-purpose subagent was listed.
4. INFO: Foreground command appeared=false; removed in a later list=false.
5. PASS: stopTask resolved and the command became stopped with endedAt.
6. PASS: An unknown opaque task id was rejected.
7. PASS: Task reports contain no private paths, toolu_ ids, internal hand-back notices, native hex ids or unexpected keys.
8. PASS: The final idle snapshot retains the stopped command.

Tasks event sequence:
9: command|sleep 90|running|bg=true|Sleep 90 seconds in background||||block=yes
14: command|sleep 90|running|bg=true|Sleep 90 seconds in background||||block=yes ; agent|Say hi|running|bg=true|general-purpose||||block=yes
16: command|sleep 90|running|bg=true|Sleep 90 seconds in background||||block=yes ; agent|Say hi|running|bg=true|general-purpose||1|27360|block=yes
20: command|sleep 90|running|bg=true|Sleep 90 seconds in background||||block=yes ; agent|Say hi|completed|bg=true|general-purpose||1|27360|block=yes
21: command|sleep 90|running|bg=true|Sleep 90 seconds in background||||block=yes ; agent|Say hi|completed|bg=true|general-purpose||1|27385|block=yes
25: command|sleep 90|stopped|bg=true|Sleep 90 seconds in background||||block=yes ; agent|Say hi|completed|bg=true|general-purpose||1|27385|block=yes
26: command|sleep 90|stopped|bg=true|Sleep 90 seconds in background||||block=yes ; agent|Say hi|completed|bg=true|general-purpose||1|27385|block=yes
