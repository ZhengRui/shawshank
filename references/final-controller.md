# Final review: controller operations

Read [final-reviewer.md](final-reviewer.md) for review standards and browser
boundaries. This file defines the controller's normal commands, not worker duties.
Use report_only for a report, or repair_loop when repairs and local commits are
authorized. Retain one repair implementer; start a fresh verifier each round.
At most three repair rounds. Do not implement repairs in the controller.

## Registration and execution

Use `bun <absolute-skill>/scripts/workflow.ts` for the verbs below. Registration
requires a clean Git root at reviewedHEAD, ancestor base, ignored `.shawshank/runs/`
in the common checkout, and its `.shawshank/config.json` (optional local overlay).
Use explicit absolute paths for scope/plan references so workers in a different
repository can read them. See [external-reference permissions](task-contract.md#external-reference-permissions)
for approval prompts from those paths and shared reviewer instructions.
Configuration snapshots roles.reviewer, roles.verifier
(default/hard), roles.implementer tiers and project.commitTrailer. Entries use
kind (codex/claude/opencode), model and explicit launch args under the
[worker contract](task-contract.md#worker-configuration). No silent fallback.
Controller model is chosen at its launch, not by worker configuration.
Dedicated feature tabs follow [feature-tab.md](feature-tab.md): the assigned
shell survives reviewer exit and can host final repair, without an empty split.
report_only requires only the reviewer; repair_loop also requires the default
verifier. Unused repair roles need not be configured for report_only.

Input JSON requires worktree, base and reviewedHEAD (full SHAs), intent
(report_only/repair_loop), entry (standalone/completed_plan), scope (reference,
description, allowedPaths, nonGoals), requiredChecks, runtimeMissions,
environmentConstraints, taskEvidence, and authorization (source, matching intent,
localCommits:true for repair_loop). Lists may be empty except repair allowedPaths.
Completed-plan taskEvidence must be nonempty: entries are kind:local_run with
runId of a passed local task, or kind:controller_provided with concrete source.
Authorization records existing user permission; it cannot grant new authority.

For browser work, include the transport, startup/ownership and cleanup methods,
app URL, account-access reference and mutation boundaries in
`environmentConstraints` (or an absolute brief reference). Follow the isolation
rules in [final-reviewer.md](final-reviewer.md) and record explicit user overrides.
Do not include credentials.
The approved input is the worker's browser contract; registration does not
derive it from shared configuration.

1. `register-final-review --input <json> --controller <id>` returns a run path.
2. `dispatch-final-review <run> --controller <id> --pane <parent> --tab <tab>`.
   Observe the exact returned worker with bounded Herdr waits. A timeout is not
   non-delivery; idle/done alone is not acceptance. Read the report, then
   `accept-final-review <run> --controller <id>` snapshots it and closes the
   settled owned reviewer. report_only ends at review_reported, not all-pass.
3. In repair_loop, assess coverage and every finding, then
   `record-final-triage <run> --controller <id> --decision <json>`.
   Decision binds review_id (original attempt), head_sha and verification_id
   (latest accepted verifier attempt, null initially), with decisions covering
   every finding once: id, action and evidence. Actions are fix, invalid,
   wontfix (minor only), deferred (explicit authorization_source), or keep
   (already settled only). Optional implementer_tier is cheap/standard/capable;
   verifier_tier is default/hard. Defaults are standard/default. Do not change
   the retained implementer's configuration between rounds.
4. When final_repair_ready, `dispatch-final-repair <run> --controller <id>`;
   observe and read delivery, then `accept-final-repair <run> --controller <id>`.
   Supply the handoff in [implementer.md](implementer.md), including relevant
   cross-task decisions and constraints in the decision evidence/references.
5. `dispatch-verification <run> --controller <id>` creates a fresh verifier;
   read [final-verifier.md](final-verifier.md), observe and read its report, then
   `accept-verification <run> --controller <id>`. Failed/partial findings or new
   direct regressions return to triage. No fix means skip repair/verification.
6. At final_completion_ready, `complete-final-review <run> --controller <id>
   --decision <json>`. Completion binds head_sha, deferred_ids (all wontfix and
   deferred IDs), checks and coverage_assessment: the controller's concrete
   assessment of requirement/mission completeness and remaining limitations.
   checks must cover all declared checks/missions AND every coverage requirement
   reported by the reviewer or any verifier. Each entry is requirement, status,
   evidence. Require PASS or justified NOT_APPLICABLE. An additional check that
   has consistently been inapplicable needs a concrete scope reason and controller
   assessment, not user authorization. Declared checks/missions or previously
   applicable work require authorization_source to exclude: this records a user's
   scope change, not a test pass. Missing capability is NOT_RUN, not inapplicability.
   Do not rename/drop requirements to evade this gate. Evidence applies at final HEAD.
7. Inspect cleanup; retry `cleanup-workers <run> --controller <id>` only after
   resolving its cause. Accepted reviewers/verifiers close after delivery;
   the repair implementer stays for repairs and closes at final_passed. Busy,
   unknown, changed or unaccepted workers must not be closed. Repositories and
   artifacts are preserved; cleanup failure does not erase the review outcome.

For startup failure, invalid reports or an exited reviewer, read
[recovery.md](recovery.md) before acting. Final-run takeover and replacement
remain unsupported; do not apply task recovery commands or adopt an old owner ID.

Use the schema pinned by the saved dispatch when resuming an existing run;
never rewrite accepted reports to match a newer format.
