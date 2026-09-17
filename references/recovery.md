# Recovery and exceptional operations

Read only the section matching the observed condition. Start with status and
inspect saved inputs, attempts, reports, Git state and live identities. Do not
register a replacement run or replay a prompt merely because a command timed out.
Preserve partial commits and dirty files; never edit SQLite or manufacture reports.

## Launcher context

Some Codex CLI launches use a shared app-server whose tool environment lacks the
launching pane's Herdr variables. In the tested CLI, per-launch -c overrides for
shell_environment_policy.set.HERDR_ENV, HERDR_WORKSPACE_ID, HERDR_TAB_ID,
HERDR_PANE_ID, and HERDR_SOCKET_PATH kept execution local and preserved the actual
pane identity. This is a verified launch recipe, not a universal Codex guarantee.
A launcher must read the real authorized pane/session identity, pass those values
only to that session, and verify them inside its tool shell before pane control.
Never persist pane identities globally, reuse another pane's identity, or infer
them from UI focus. Resume on a different pane requires its actual launch context.

## Startup and unavailable task reviewers

Submission or startup uncertainty blocks further dispatch. Inspect the saved
attempt and pane rather than repeat a prompt. Explicit reconciliation is described
under Task controller takeover below. A recorded `startup_blocked` attempt can
continue with the same dispatch command after its approval is resolved and the
original worker is ready; it does not create a new pane. For task implementation,
a coarse `prepared` record requires an explicit
`--startup-decision <file>` containing the exact `attempt_id`,
`prompt_submitted: false`, and concrete `evidence`. The controller must establish
non-submission, not infer it from idle state. A `prompting` attempt cannot replay.
This records operator reconciliation, not automatic proof of non-delivery.

If OpenCode startup stops before task input because its UI did not appear,
inspect the original pane. Once its input UI is visible, wait three seconds and
continue the same startup_blocked dispatch; do not create another worker. The
automatic check recognizes the standard TUI's "Ask anything" input placeholder;
custom or minimal UIs require inspection rather than assuming readiness.

If the retained reviewer is unavailable or its identity changes, dispatch stops
without sending the prompt or silently launching another reviewer. Inspect the
saved outstanding review attempt and use explicit interruption recovery or
replace-worker with stop evidence. A replacement receives the prior report,
triage, task, and scoped fix range; chat memory is never the only record. A
reviewer already recorded closed gets a new independent session with those same
durable inputs.
For a retained session that becomes ready again without replacement, resume its
unprompted startup_blocked attempt with dispatch-review; identity and HEAD are
rechecked. Never repeat a prompt whose submission is unresolved.

## Explicit continuation after a confirmed pause

If a submitted implementation/repair was explicitly paused and that same worker
acknowledged the stop, inspect its live identity, partial files, current task input,
attempt and prior dispatch. Confirm no command/background writer remains active.
The owner may save an immutable continuation note and send that worker an explicit
follow-up for the same attempt. Reference the current task/brief and any recorded
scope amendment; state exactly which stale instruction is superseded. Preserve
the original dispatch, attempt ID, report path/schema, findings and all budgets.
Do not call dispatch-repair again, overwrite the old dispatch or re-register.
This is an acknowledged continuation, not replay after timeout or uncertain
submission. If identity, pause or delivery is uncertain, use normal recovery.
Replacement must carry the applicable continuation note as part of its preserved
partial-work context. Normal acceptance and independent review still apply.

## Invalid commit attribution

When acceptance rejects attribution on the current HEAD, continue within existing
local-commit authority: dispatch a correction to the retained implementer, wait,
then retry normal acceptance. The controller must not amend the commit itself.

Use the implementation/repair dispatch verb with `--correct-commit <decision.json>`
(including `dispatch-final-repair`). Supply `attempt_id`, validation `evidence`,
current `head_sha`, `unpushed:true` and concrete `unpushed_evidence`. Inspect push
history and remote state when necessary; absence of a remote-tracking ref alone
does not establish that a commit was never published. Uncertainty requires a stop.

This shares the one-correction budget with report correction, not the code-repair
budget. Only the last, unaccepted commit created after this dispatch may be amended.
The original report is preserved; the new report may change only head_sha.
Acceptance checks unchanged tree, parents and author, then all normal delivery
gates. It does not accept the task or skip independent review.
Earlier/inherited/accepted/published commits, another correction, or an unavailable
worker require user judgment. Do not rebase or replace a worker to bypass this
boundary. Unknown prompt submission is not retry permission; use existing task
reconciliation with the same correction mode, or stop for final-run limits.

## Invalid reports

For an invalid report, the corresponding dispatch verb supports
`--correct-report <decision.json>` instead of normal dispatch arguments. The
decision names attempt_id and evidence of the validation failure. This permits
one report-only correction on the same worker; the original report is retained,
the corrected output has a different path, and correction_count remains 1.
The attempt records correction-time HEAD; implementation/repair acceptance
rejects any additional commit during a report-only correction and preserves it.
Reaccept with accept-review or accept-implementation. A second correction stops
for user judgment. Report correction is not a repair round. Unknown submission
remains unresolved and cannot be replayed automatically.

For final runs, use the corresponding final dispatch verb's --correct-report
with the same one-correction budget, then its normal acceptance command. Preserve
pinned HEAD, IDs and original artifacts; correction grants no repair/review round.
Final startup_blocked can continue after approval and readiness; ambiguous
prepared/prompting submission cannot be replayed.

## Planned task handoff

For a planned orchestrator handoff, stop issuing workflow commands at the agreed
checkpoint. Save `handoff.md` in the run directory with the old controller id,
observed stage/attempt, authorized Herdr session/parent/tab and exact old agent
identity if available, plus factual evidence that no command is still running.
State that control is relinquished; do not mutate afterward. The next orchestrator
must recheck these claims against live state and perform take-over. This file is
handoff evidence, not a second progress database or permission to bypass checks.

## Task controller takeover and worker replacement

For tasks linked to a registered plan, start with plan-status and use the
[coordinated plan handoff](plan-registration.md#resume-and-controller-handoff).
Task take-over also requires that plan's current fingerprint and identity; it
transfers plan/task owners together, never only the task. Standalone runs keep
the contract below unchanged.

```sh
bun <skill>/scripts/workflow.ts take-over <run> --controller <new-id> --decision <file>
bun <skill>/scripts/workflow.ts replace-worker <run> --controller <current-id> --decision <file>
```

Stop the old command before recovery. A controller id is a coordination identity,
not authentication. Do not reuse an old id or run arbitrary competing writers.
Neither idle state nor a timeout proves prompt non-delivery or absence of writers.
All decisions require previous_controller, stage, latest attempt_id (null before
dispatch), previous_command_stopped:
true, concrete evidence of that termination, and session_evidence establishing
that observations refer to the same Herdr server/session. These fields record
operator evidence; they do not establish facts merely because a boolean is true.
Do not supply credentials or private terminal dumps as evidence.

Takeover never starts or prompts a worker. It retains baseline, repair count,
findings/triage and files. Later commands from the old controller are rejected.
After establishing the required evidence, transfer controller ownership before
waiting for the retained worker to complete. Recovery accepts matching workers
in working or blocked state as well as idle/done; do not require a delivery
report or settled worker merely to take over. Ordinary retain takeover does not
require head_sha or worktree_fingerprint: normal worker edits and commits must not
block ownership transfer. Worker identity and unchanged ledger/decision are still
checked. Missing evidence still requires a stop.
After takeover, observe the same worker. Delivery acceptance requires idle/done,
valid reports and the normal Git/check gates; replacement and closure retain
their own stop-evidence requirements. For ordinary completion waits, omit
`--until idle` so Herdr can return either idle or done (or blocked for inspection).
The same controller may use take-over to reconcile its own stopped command.
resolution is one of:

- retain: keep a settled stage; submitted workers must still match live identity.
- submitted: reconcile a lost dispatch receipt, with positive submission_evidence;
  preserve the attempt and proceed to normal report acceptance, never accept it
  merely because a result file exists.
- not_submitted: positive non_submission_evidence permits the original idle worker
  to receive its existing dispatch once through the corresponding dispatch verb.
- unresolved: transfer ownership but block workflow actions until a new explicit
  decision reconciles the outstanding attempt. Never guess from idle state.

Interrupted report correction also supports submitted/not_submitted. The latter
records correction_ready; invoke the same --correct-report action with the
original correction decision to send the retained correction prompt. This does
not grant another correction or relax the pinned HEAD check. Other takeover
resolutions and worker replacement require head_sha and worktree_fingerprint from
fresh status. Fingerprints cover HEAD, working diff, staged diff, status, and
untracked contents independently; re-inspect when they change.

A stale closing claim additionally requires cleanup_command_stopped: true. It is
changed to pending, not closed: cleanup-workers must recheck the actual pane.
Missing identities or unavailable sessions remain blocked, not presumed dead.
There are no leases, timeout-based reclamation, automatic fallback, or new tables.
Recovery decisions are preserved in run files; config points to the latest one
without replacing the current triage decision_path.

Replacement additionally requires worker_stopped: true, worker_stop_evidence that
the old worker and any background writers are stopped, and partial_work describing
what the replacement must preserve and finish. The current fingerprint must match.
An existing old pane must be idle/done with matching identity, then is closed and
confirmed absent before a new pane starts. In feature-tab reuse mode, the owned
agent instead exits and the same pane must return to a verified shell before
replacement starts; see [feature-tab.md](feature-tab.md). Confirmed already-absent panes are safe
to reconcile only in the verified same session. A missing pane receipt requires
positive no_pane_created: true and no_pane_evidence; absence of a receipt alone is
insufficient. Partial commits and dirty files are never reset, stashed, or erased.
The replacement gets a new attempt but inherits the original baseline, repair
count and report-correction budget. It uses the snapshotted role; implementers may
select worker_index within the current tier. Unknown launch/submission outcomes
stop for another explicit decision rather than retrying blindly.

## Final-run limits

Final-run takeover and worker replacement are not implemented. Do not apply task
recovery commands or adopt the old controller ID. Stop for an interrupted owner
or ambiguous execution and report the saved/live evidence. Same-owner normal
transitions and explicit report/commit-message correction remain available.

### Initial report after worker exit

Only the current controller can use `accept-final-review <run> --controller <id>
--recovery-decision <file>` for a submitted initial report. Normal acceptance
still requires the live matching reviewer. This exception does not cover an
uncertain dispatch, a different controller, repair delivery or verification.

Record a JSON decision with `run_id`, `previous_controller` (current owner),
`stage`, `attempt_id`, `head_sha`, `worktree_fingerprint` (from inspected status),
and `report_sha256` (SHA-256 of the exact saved report bytes). Also include
`previous_command_stopped:true`, `evidence` of command termination,
`session_evidence` identifying the verified same Herdr session, and
`worker_stopped:true` with `worker_stop_evidence` covering the worker and any
background writers. These are evidence-backed operator assertions; a digest
does not authenticate authorship or establish process termination.

The tool requires `agent_not_found` for the saved reviewer. Split-only mode also
requires `pane_not_found`. Feature-tab reuse mode instead requires the assigned
pane in the saved tab to be a verified idle shell in the worktree, never the
controller pane. Transport failures or a busy/unidentified pane are not proof
of termination.
All ordinary report/coverage and clean pinned-HEAD gates still apply. Changed
decision, report, worktree or ledger state rejects acceptance. The original
report is preserved, exact report and decision snapshots are saved, and
`config_json.finalReportRecoveryDecision` references the decision artifact.
The normal report_only/repair_loop transition and pane-cleanup reconciliation
follow. This does not certify browser cleanup or complete runtime coverage.
