# Agent input and result handoffs

The graph's Input field describes what a task expects from upstream agents.
Task remains the assignment. Profile instructions remain reusable behavior.

Profiles also have `whenToCall`, `inputInstructions` and `expectedResult`.
The task's Input overrides the profile input default. The authorized roster
projects these descriptions for allowed dynamic profiles; it does not expose
unapproved profiles. Expected result is included in the launched agent's task.
Dynamic children inherit the selected template's input requirements.

Portable system format v2 adds optional `agents[].input`. Both v1 and v2 use
their own strict schemas; the same parser handles UI import and `system:check`.
Export writes v2, and importing v1 preserves its assignments without inventing
an input contract. The orchestration IPC is v4 and pipeline steps persist
`inputInstructions`. Old run schema versions 1–3 migrate to v4 without changing
their prompts or native history; absent input fields remain absent.

When admitting a task, the coordinator reads its frozen run snapshot. It appends
the task's own input requirement and the input requirements of its outgoing
result/message recipients. Every admission path uses this preparation, including
controlled launch, retries and leases. Actual dependency results still resolve
through verified native history references; this does not replace them with a
second history format. Observation alone does not grant message delivery.

These are instructions to the agents, not an assertion that arbitrary natural
language requirements can be validated automatically. Agents must identify
missing evidence rather than fabricate it. External text cannot change these
requirements or increase permissions.

The supplied video `gNsjZvzdGEE` at 23:36–24:07 separates invocation criteria,
input, expected output and system prompt. Its locally extracted Russian captions
were inspected again for this change. The second video `u3gbL1cEEUs` discusses
developer/reviewer coordination. PiUI uses the explicit input contract while
retaining its own typed routing and native harness boundaries.
