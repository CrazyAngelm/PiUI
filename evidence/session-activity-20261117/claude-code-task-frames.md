# Claude Code task frames (real provider)

Date: 2026-11-17. Claude Code 2.1.325 on Windows, the person's subscription
sign-in, model `haiku`, `--output-format stream-json --verbose`. Two short
runs in an empty scratch folder. This is real-provider evidence for the frame
shapes only; it is not a test of Nano Desktop. Native ids are random per run
and file paths are shortened.

## Run 1: one background shell, two subagents (`-p`)

Prompt: start `sleep 6` in the background, start two subagents (the second
with `run_in_background`), wait for the background work, answer `finished`.

Frames of `type: "system"` in the order they arrived (other frames omitted):

```
background_tasks_changed  tasks:[{task_id:"bxoumnfd2", run_id, task_type:"local_bash", description:"…"}]
task_started              task_id:"bxoumnfd2", run_id, tool_use_id, description, is_backgrounded:true, task_type:"local_bash"
background_tasks_changed  tasks:[shell, {task_id:"af3ef615…", task_type:"local_agent", subagent_type:"general-purpose", description:"Say hi"}]
task_started              task_id:"af3ef615…", tool_use_id, description:"Say hi", subagent_type:"general-purpose", is_backgrounded:true, spawn_depth:1, task_type:"local_agent", prompt:"…"
background_tasks_changed  tasks:[shell, agent 1, agent 2]
task_started              task_id:"a766fafc…", tool_use_id, description:"Count to three", subagent_type:"general-purpose", is_backgrounded:true, spawn_depth:1, task_type:"local_agent", prompt:"…"
task_updated              task_id:"af3ef615…", patch:{status:"completed", end_time:1794849801567}
task_notification         task_id:"af3ef615…", tool_use_id, status:"completed", output_file:"<temp>/tasks/<id>.output", summary:"hi", usage:{total_tokens:25293, tool_uses:0, duration_ms:1226}
background_tasks_changed  tasks:[shell, agent 2]
task_progress             task_id:"a766fafc…", tool_use_id, description:"Running Sleep 3 seconds then print \"three\"", subagent_type:"general-purpose", usage:{total_tokens:25531, tool_uses:1, duration_ms:1904}, last_tool_name:"PowerShell"
task_updated              task_id:"bxoumnfd2", patch:{status:"completed", end_time:1794849804597}
task_notification         task_id:"bxoumnfd2", tool_use_id, status:"completed", output_file:"<temp>/tasks/<id>.output", summary:"Background command \"…\" completed (exit code 0)"
background_tasks_changed  tasks:[agent 2]
task_started              task_id:"be77w5o9w", owned_by_subagent:true, tool_use_id, description:"Sleep 3 seconds then print \"three\"", is_backgrounded:false, parent_task_id:"a766fafc…", task_type:"local_bash"
task_notification         task_id:"be77w5o9w", tool_use_id, status:"completed", output_file:"", summary:"Sleep 3 seconds then print \"three\""
task_updated              task_id:"a766fafc…", patch:{status:"completed", end_time:1794849808707}
task_notification         task_id:"a766fafc…", tool_use_id, status:"completed", output_file:"<temp>/tasks/<id>.output", summary:"Counted", usage:{total_tokens:28927, tool_uses:1, duration_ms:7911}
background_tasks_changed  tasks:[]
```

Observed:

- `background_tasks_changed` arrives before the `task_started` of the same task.
- A shell task's `description` is the tool call's description, not its command.
- A command a subagent runs is reported with `owned_by_subagent: true` and a
  `parent_task_id`; it gets a `task_notification` and no `task_updated`.
- Each finished background task starts a new native turn (`system/init`,
  an assistant message, a `result`).

## Run 2: stopping a task (`--input-format stream-json`)

After `initialize`, one user message started `sleep 120` in the background.
1.5 s after its `task_started` the probe sent
`{type:"control_request", request:{subtype:"stop_task", task_id}}`.

```
background_tasks_changed  tasks:[{task_id:"bf7vwdgf9", task_type:"local_bash", description:"Sleep 120 seconds in background"}]
task_started              task_id:"bf7vwdgf9", tool_use_id, description, is_backgrounded:true, task_type:"local_bash"
task_updated              task_id:"bf7vwdgf9", patch:{status:"killed", end_time:1794850025649}
task_notification         task_id:"bf7vwdgf9", tool_use_id, status:"stopped", output_file:"<temp>/tasks/<id>.output", summary:"Sleep 120 seconds in background"
background_tasks_changed  tasks:[]
control_response          subtype:"success", request_id:"stop-1", response:{}
control_response          subtype:"success", request_id:"stop-2", response:{}      (task_id "nope": an unknown id also succeeds)
```
