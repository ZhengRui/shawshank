# Approved-plan registration and task preparation

This workflow stores an already approved plan and prepares its tasks in order.
It prepares and links the final run after all tasks pass, but does not dispatch
workers. Explicit takeover coordinates plan and task ownership before final-run
registration. The controller drives dispatch and sequencing. Registration reserves
the worktree until final_passed and completed cleanup.
Planning, decomposition and approval happen before this entry.

Commands, via `bun <skill>/scripts/workflow.ts`:

- `register-plan <plan.json> --controller <id>`
- `plan-status <returned-plan-path>` (read-only; no migration or live polling)
- `prepare-next-run <plan-path> --controller <id> --task <key> --input <task.json>`
- `prepare-plan-final-review <plan-path> --controller <id>`
- `take-over-plan <plan-path> --controller <new-id> --decision <json>`
- `amend-plan-scope <plan-path> --controller <id> --decision <json>` (omitted files only)
- `retire-plan <plan-path> --controller <id> --decision <json>`

Input example:

```json
{
  "worktree": "/absolute/git-root",
  "reference": "approved-plan.md",
  "authorization": {
    "source": "User approved this plan including final repair and local commits",
    "intent": "repair_loop",
    "localCommits": true
  },
  "tasks": [
    {"key": "task-1", "title": "Implement the approved feature"},
    {"key": "task-2", "title": "Integrate the feature into its caller"}
  ],
  "finalReview": {
    "entry": "completed_plan",
    "intent": "repair_loop",
    "targetBranch": "refs/heads/main",
    "scope": {
      "reference": "approved-plan.md",
      "description": "The complete approved feature",
      "allowedPaths": ["src/feature.ts"],
      "nonGoals": []
    },
    "requiredChecks": ["Run covering tests"],
    "runtimeMissions": [],
    "environmentConstraints": []
  }
}
```

The user supplies an approved Markdown plan. The controller prepares this internal
registration JSON without replanning; users need not rewrite their plan as JSON.
Task keys are unique; titles identify the corresponding tasks in the plan and
array order is execution order. Registration requires no task JSON or brief.
Relative references resolve beside plan.json.
The final template omits worktree, base, reviewedHEAD,
taskEvidence and authorization: these will derive from the plan and passed runs.
`finalReview.targetBranch` must explicitly name the agreed local or remote-tracking
branch (`refs/heads/...` or `refs/remotes/...`); never assume main or infer it from
the current branch. Registration pins its commit and the unique merge base with
the starting HEAD in `reviewBaseline`. No fetch is performed. Later target-ref
movement does not silently change the review range. The plan's initial HEAD still
governs task sequencing; it is not the whole-branch review baseline.

Registration requires a clean committed Git root, ignored common-checkout
`.shawshank/runs/`, and no unfinished run/plan or pending worker cleanup. It snapshots
the plan baseline, ordered task list and final scope reference in ignored runtime
storage, records the initial HEAD and reserves the worktree. The saved
`sourceReference` records the original Markdown path for provenance only;
`reference` points to the unchanged approved baseline used for execution.
Later edits to the original are not automatically adopted. Other linked references
are not recursively copied. Registration also creates `adjustments.md` in the
ignored plan directory: the controller appends corrections there, not to the original
plan. This is a short decision record, not a third full copy of the plan.
Snapshot files are retained, write-once artifacts, not access-controlled storage;
never edit them or the SQLite records to resume or bypass a boundary.

## Task preparation and plan adjustments

Follow [artifact storage](../SKILL.md#artifact-storage) when preparing inputs and
runtime tests. Input staging directories must not become the sole home of evidence
cited by accepted reports; preserve that evidence in the corresponding run first.

Inspect affected callers and existing tests, including shared E2E fixtures, before
selecting allowed paths; do not invent test directories without checking.
Prepare only the task about to start, using the approved baseline and relevant results
from preceding tasks. Its JSON uses the existing [task input](task-contract.md),
and its brief contains the actual requirements. Retain the exact dispatched inputs;
never silently overwrite an active task's instructions or rewrite completed work.

Read plan status, the approved baseline and `adjustments_path` first, including
after compaction. For `prepare_task`, the controller extracts that task's
requirements and relevant prior decisions, then writes its JSON and brief. Do not
ask the user to author JSON, generate all future briefs, or send the full plan and
accumulated conversation to the worker. The tool validates structured inputs; it
does not extract Markdown or prove semantic agreement with the approved plan.

Call `prepare-next-run` with the exact registered task key. It requires the plan
owner, all preceding tasks passed with cleanup complete, and clean Git at the last
accepted HEAD (initial baseline for the first task). It snapshots this task's brief,
input and the current adjustment record into the new run, then creates the run and its association
in one SQLite transaction. No worker is launched. Use the returned run with the
existing single-task dispatch/review/repair commands. The initial stage is only
`registered`, not an accepted implementation.

Repeating the command for the same key returns the same run, including after that
task has completed; it never advances on retry or replaces saved inputs. The input
file is not reread on reuse. Inspect the returned stage/status before dispatching;
use recovery for interruptions. A different task key must satisfy the next-task
gates. All tasks passed yields `prepare_final_review`, not completion.
For an owner change use coordinated plan takeover below, not the saved owner ID.
Original plans may be tracked, ignored or external. Corrections in the ignored run
directory leave Git boundaries unchanged; no documentation-commit exception exists.

The controller may resolve implementation details while preserving the requested
behavior, authorized scope and acceptance criteria. Append the affected task keys,
what changed and why to `adjustments.md`; preserve earlier entries, and explicitly
supersede an earlier decision when necessary. A changed goal, expanded
scope, weakened acceptance or new authority requires user approval before affected
execution continues. Record that approval with the change. Incorporate applicable
corrections into the task brief so workers need not reconstruct requirements from
multiple records. The tool preserves the adjustment snapshot but cannot prove the
controller interpreted it correctly. Missing information is
not permission to invent requirements. Task-list/order changes must also be
explicitly reconciled before sequencing; the registered list is not auto-refreshed.
There is no plan-list update command yet; stop if that list must change.
For active tasks, communicate an authorized correction explicitly and retain its
record. For completed tasks, record any needed rework instead of changing history.

`plans` and `plan_tasks` only associate approved work with existing runs. Status
reports those links and saved run/cleanup state, not a second execution state.
It reports run preparation only, with a saved-state next action. Unknown IDs or old databases
without plan tables fail without migration. A failed registration may retain an
unlinked snapshot directory for inspection; it is not a registered plan or run.

## Final-review association

At `prepare_final_review`, call `prepare-plan-final-review`. It requires the plan
owner, every task passed, completed worker cleanup, and clean Git at the last
task's accepted HEAD. It derives the full range from the pinned branch merge base
through that HEAD, including changes before plan registration, and includes exactly
the ordered local task runs as evidence. Whole-branch inspection does not expand
repair authority: request authorization for fixes outside approved allowed paths.
The saved final-review template (including supported scope corrections) and
original authorization remain authoritative. The
review scope artifact snapshots the approved plan, final scope, scope corrections and adjustment
record; adjustments do not silently override structured scope/checks/authority.
It also includes each task's latest accepted findings paired with its final triage
decisions, reasons, deferral authorization and report/decision paths. Missing or
stale handoff evidence blocks registration. The reviewer must reconsider deferred,
wontfix, invalid and pre-existing findings in the whole-branch context, preserving
the original reasons/authority, not assuming either resolution or mandatory repair.
Resolved findings remain visible as context. These task dispositions are context,
not automatically imported final-review findings or replacement user authorization.
If those fields must change, stop for an explicit supported update rather than
editing saved JSON. General template updates remain unsupported; only the narrow
scope correction below is supported before final registration.

Creation and plan association share one transaction. Repeats return the same final
run without launching a reviewer or rereading model configuration. Follow
[final-controller.md](final-controller.md) from dispatch onward with that run.
The initial `final_ready` stage is not review acceptance. Saved plan progress is
`resume_final_review` until final_passed, then `cleanup_final_review` if needed,
and finally `plan_complete`. Only then is the worktree released for another run.
The initial plan authorization already includes this bounded final repair loop;
do not ask for permission again at this transition. Merge/push remain excluded.

## Correct omitted file scope before repair

Use `amend-plan-scope <plan> --controller <owner> --decision <json>` to add
existing specific files already authorized by the approved plan. It requires the
current task at `repair_required`, clean accepted HEAD, settled retained workers,
and no registered final run. It adds the same files to task and final allowedPaths
atomically by switching to new immutable input revisions. Prior inputs, reports,
decisions, IDs and budgets remain intact; no worker is dispatched.

Decision fields: `plan_id`, `run_id`, `plan_fingerprint` (current plan-status
recovery_fingerprint), `head_sha`, `add_paths`, `reason`, `authorization` (identify
the applicable existing approval), and `within_approved_plan:true`. Evidence
records judgment, not proof that prose authorizes a file. Expanded goals, new
authority or weakened acceptance still require the user and are not supported
by this command. Directories, wildcards, symlinks and removals are not accepted.
Stale retries require inspection, never blind replay. Read `scopeAmendments` in
the current plan input alongside baseline/adjustments after recovery. Subsequent
dispatches must explain the correction to retained workers; earlier briefs and
reports remain historical. Failed transactions may retain unlinked artifacts,
not effective changes.

## Retire an unreachable plan

A plan reserves its worktree until `final_passed` with completed cleanup. When no
supported transition can still reach that state, `retire-plan` abandons the plan
and releases the reservation so other work can register. The common cause is an
interrupted final run whose snapshotted reviewer/verifier role is unobtainable:
final replacement must preserve that exact kind and model, final-run takeover is
unsupported, and a different controller may not take over a plan once its final
run exists. Retirement is the documented end of that road, not a way around a
boundary that is still passable. If the plan can be resumed by its owner or taken
over between tasks, do that instead.

Retirement is additive. Stages, reports, triage decisions, counters, commits,
task links and snapshots are left exactly as delivered; a `retired_at` marker is
added to the plan and to its unfinished runs. `plan-status` then reports
`plan_retired` and `status` reports `run_retired`. Both stay readable for
inspection forever; both refuse every command that would dispatch, accept, repair
or resume them. Retiring never deletes evidence and never closes a live worker.

Requires user authorization, a clean working tree, and a decision file with
`plan_id`, `plan_fingerprint` (current plan-status `recovery_fingerprint`),
`head_sha`, `unreachable: true`, `reason`, `authorization`, and `retire_runs`
listing `{run_id, stage}` for every unfinished linked run — task runs and the
final run alike. That enumeration must match the live ledger exactly, by id and
current stage, so an unfinished run cannot be retired without being named. Every
tracked worker pane is checked through Herdr first: a pane that still exists
aborts the command, and only panes Herdr reports absent have their cleanup
closed. The command writes a write-once `retirement-<uuid>.json` beside the plan
snapshot recording the decision, the retired runs and the closed panes.

Retirement records judgment, not proof. Setting `unreachable` does not make a
plan unreachable; establish that first and cite it in `reason`.

## Resume and controller handoff

After compaction or resuming the same controller, read `plan-status`, the approved
baseline, adjustments.md and any scopeAmendments in the current plan input.
Follow the saved next action: prepare the next task,
resume the existing task/final run, or finish its pending cleanup. Read that run's
status and its retained brief, reports and decisions. Query live worker identities
before deciding whether to wait or accept delivery. SQLite is saved progress, not
worker liveness. Do not start again at task 1 or replay a prompt from chat memory.

A different controller first establishes that the old controller's workflow
commands have stopped and relinquished control. Do not require a retained worker
to finish first. Use `take-over-plan` with an evidence file containing `plan_id`,
`plan_fingerprint` from plan-status's `recovery_fingerprint`, `previous_controller`,
`previous_command_stopped:true`, concrete `evidence`, and verified `session_evidence`.
These are operator evidence, not authentication or proof merely by setting fields.

- With an unfinished task or pending task cleanup: include that run's normal
  takeover decision fields from [recovery.md](recovery.md). The command reuses its
  live identity and submission-reconciliation checks. Ordinary retain allows a
  working worker and changing files; it does not accept that work or restart it.
- Between tasks (also before the first task): use `stage:"between_tasks"`,
  `attempt_id:null`, `resolution:"retain"`, and `head_sha` at the last accepted
  boundary. All linked tasks must have passed and cleaned up; Git must be clean.

Plan and linked task coordination owners change in one transaction. Historical
reports, triage, commits, counters and task links remain unchanged; completed runs'
controller fields now name the coordinator, not their original author. Saved
takeover decisions retain the previous owner/evidence. Old workflow calls reject
the old owner. Direct task take-over for a plan member requires the same plan
evidence and cannot transfer the task alone. Stale fingerprints require inspection
and a fresh decision, never automatic retry or rewriting SQLite.

Once a final run is registered, plan takeover is unsupported, even before reviewer
dispatch: stop for a different controller. The same owner can resume normally.
No leases, timeout reclamation, worker replacement or new recovery state machine
are introduced by this wrapper.
