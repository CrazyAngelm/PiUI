---
name: bes-deep-mode
description: Plan and verify complex or high-impact work by exploring plausible approaches, working backward from the result, and combining the strongest parts. Use for hard debugging, architecture, or migrations when a first-pass answer is risky.
license: MIT
---

# BES Deep Mode

Adapted from CrazyAngelm's BES Deep Mode, which applies bidirectional evolutionary search to practical agent work. See `LICENSE` in this directory.

1. **Frame the work.** Record the requested result, the constraints that apply, and the checks that would prove completion. Read the relevant source or reproduce the failure before relying on a hypothesis.
2. **Search forward.** When materially different approaches are plausible, identify what each one changes, its dependencies, and its likely failure modes. Prefer the smallest approach that can satisfy the actual requirements.
3. **Search backward.** Start from the requested result and trace which behavior and invariants it requires. Use these to reject approaches that cannot preserve the needed behavior or be verified.
4. **Combine and act.** Keep only the pieces that address the requirements. Use the tools and permissions available in this session. For read-only work, return findings and a concrete plan.
5. **Verify.** Run checks through the relevant entry point when the session permits it. Include a failure case when it affects the result. If evidence contradicts the plan, revise the affected part and recheck. Report the observed result and any gaps that remain.
