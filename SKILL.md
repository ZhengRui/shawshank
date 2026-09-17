---
name: shawshank
description: Execute an approved coding task or plan, or an explicitly requested final review, with configurable external workers and durable progress through Herdr. Use for shawshank requests and existing runs. Not for brainstorming, task decomposition, or ordinary direct coding.
---

# Shawshank

For user-facing plan guidance and copyable prompts, see [README.md](README.md).
Execution rules remain in this file and the references below.
For first-time project configuration, follow [SETUP.md](SETUP.md).

The current conversation's agent is the controller by default; do not start a
separate controller agent. Its model is selected in the user's session.

When the user explicitly selects Shawshank to execute a plan produced elsewhere,
use Shawshank's implementation, review and recovery flow instead of execution
routing embedded in that plan. Preserve approved requirements, constraints and
acceptance checks; do not rewrite the plan or broaden authority. Do not run a
second execution workflow alongside it. If execution has already started under
another workflow, reconcile existing work and live workers before dispatching.

The controller dispatches, observes, validates, triages and reports; it does not
implement or repair task code. Claude and Codex can orchestrate.
Workers are configurable external Herdr agents
(codex/opencode/claude). Review instructions are internal: no other review skill
or native subagent API is required. Do not silently substitute a role or transport.

## Start here

Use `bun <absolute-skill-directory>/scripts/workflow.ts` from any directory.
Read the matching reference before action and again after losing context:

- One approved task: [task-contract.md](references/task-contract.md).
- Explicit final review: [final-controller.md](references/final-controller.md)
  and [final-reviewer.md](references/final-reviewer.md).
- Failed startup, invalid report/commit attribution, handoff, interruption or exited worker:
  [recovery.md](references/recovery.md), only when that condition occurs.
- Approved-plan registration/task preparation: [plan-registration.md](references/plan-registration.md).
  Register the plan baseline and task list, not prebuilt inputs for every task.
  The controller sequences approved tasks and final review using saved progress.

For an existing run, start with `status <run-path>`; do not register another.
Status does not poll Herdr, and next_action is guidance, not proof of readiness.
A new controller must use explicit recovery, never adopt the saved owner ID.
Final-run takeover/replacement is not supported.

Before dispatch, establish the approved scope, repository, local commit authority
and allowed Herdr parent pane/tab. Inspect Git state and preserve unrelated work.
For a dedicated feature tab, follow [feature-tab.md](references/feature-tab.md)
to create it when authorized and reuse its assigned shell without an empty split.
Read installed Herdr CLI help and verify HERDR_ENV=1 plus the actual session and
explicit targets; never infer them from focus. If inherited context is missing,
stop and arrange a verified launcher; see recovery's launcher-context section.
Do not fabricate environment identities. Registration does not dispatch; retain
the returned absolute run path.

Read model and permission settings from the project's role configuration and
existing authorization. Do not infer permission bypass from the worker kind.
Honor explicit overrides and verify startup mode; role args and snapshots are
documented in the task contract.

## Normal flow

- Approved plan: register → prepare the next task → complete its task loop →
  repeat in approved order → whole-branch final review → plan_complete.
  The controller drives these steps; no background scheduler runs them.

- Task: register → dispatch implementation → observe and accept delivery →
  independent task review → controller triage → repair/re-review if needed →
  task_passed and cleanup.
- Final review: register → independent review → accept report. report_only ends
  at review_reported, possibly with findings or gaps. repair_loop continues through
  controller triage → retained repair implementer → fresh verifier → final
  acceptance and cleanup, with at most three repair rounds.

Use explicit worker names/panes and bounded `herdr agent wait <worker>
--timeout 30000`. Both idle and done are settled; inspect blocked/unknown states.
A timeout is not proof of non-delivery and never authorizes a repeated prompt.
For OpenCode only, wait for the input UI to appear, then allow three more seconds
before the first task message. The transport does this at startup without sending
a probe message; other worker kinds are unchanged.
Read the report before acceptance. Worker completion alone does not pass a task.

Worker duties are in [implementer.md](references/implementer.md),
[task-reviewer.md](references/task-reviewer.md), and the final-review references.
Read the implementer handoff before final repair and
[final-verifier.md](references/final-verifier.md) before verification.
Generated dispatches provide exact inputs, output paths and schemas.
For interaction-heavy scope, read
[interaction-checklist.md](references/interaction-checklist.md).

## Artifact storage

For new work, keep evidence needed to explain acceptance under the corresponding
run's `evidence/` directory, created only when needed. Before submitting a report,
preserve cited temporary evidence there and cite that retained path. Use unique
names per attempt; do not overwrite earlier evidence or copy credentials into it.

Keep temporary service environments, credentials, caches and regenerable large
fixtures in a separate temporary directory. Preserve them while later review or
repair still needs them. After owned services stop and no consumer needs them,
clean only authorized disposable materials and record cleanup or pending cleanup.
Retain fixture generation details/hashes when needed to understand the checks.

Controllers prepare registration JSON, task JSON and briefs before registration.
Only remove disposable source inputs after confirming retained snapshots contain
everything needed and no live run or external reference still depends on them;
linked files are not automatically copied. Do not delete the user's approved plan.
Leave historical artifacts and accepted reports unchanged. These are storage
conventions, not automatic archiving or new workflow commands.

## Authority and completion

An approved task authorizes its normal loop; do not ask permission at every
transition. Respect explicit checkpoints. Stop for changed scope, unavailable
required capability, unresolved execution, an approval dialog, exhausted budgets
or a decision needing new authority. JSON fields record permission, not grant it.
Never edit SQLite or manufacture worker reports to advance a run.

Report outcome, accepted HEAD, evidence, deferrals, limitations, cleanup state,
run path and next step. Preserve repositories and artifacts; close only owned
worker panes under the relevant cleanup rules. A task ends at task_passed, not
feature_complete. Final review requires explicit approval, which may already be
included in the registered plan authorization. Completion
does not authorize merge, push or deployment.

Planning, task decomposition, an autonomous background scheduler, plugin packaging and
replacement of other installed skills remain outside this implementation.
