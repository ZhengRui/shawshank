# Task input, delivery, and task review

## Commit provenance

Set `project.commitProvenance: true` in shared configuration (enabled here).
New task and final runs snapshot this setting. Implementation and repair
dispatches require one compact trailer alongside Co-Authored-By:
`Agent: provider=<provider>; model=<model>; effort=<effort>; harness=<harness>`.
Keep Agent and Co-Authored-By together in the final trailer block, without a
blank line between them; a matching line elsewhere in the body is insufficient.
Use the executing worker's launch role and CLI selections (CLI takes precedence),
updated by session evidence of model switches or alias resolution. Keep configured
model selectors verbatim otherwise; known selections do not require runtime
telemetry. Use `unknown` for unspecified values, never inferred defaults or
remembered effort variants. Values are attribution evidence, not authenticated
backend telemetry. Acceptance rejects missing, duplicate or placeholder metadata
and continues to accept the original four-trailer format for existing commits
and in-flight dispatches. Historical runs retain their provenance opt-in setting.
New dispatches provide a filled attribution line and pin its known fields with
the starting HEAD. Acceptance rejects `unknown` for those fields on new commits;
pre-dispatch commits retain their original attribution. This checks omitted known
values, not the truth of a claimed runtime switch. No runtime identity is inferred
solely from the harness; configure provider explicitly when needed.

## Task lifecycle

Registration and status do not launch a worker. Explicit dispatch does.
Run the commands below with `bun <absolute-skill>/scripts/workflow.ts`.

The run path identifies a database record. Dispatch creates its directory with
`task.json`, `<attempt-id>-dispatch.md`, and a designated `<attempt-id>-report.json`.
Standalone input and brief are caller-owned; after dispatch, task.json freezes
the task fields while relative brief paths retain their original input base.
Plan-linked inputs/briefs are run-local snapshots: the saved run.task_path selects
the current immutable revision for repair, review and acceptance. The original
task.json is historical after a supported scope amendment, not the current contract.
Do not modify retained inputs or briefs while the run is active. Registration records existing user
authorization; setting a JSON field cannot grant permission.

```json
{
  "worktree": "/absolute/git-root",
  "goal": "Add the approved behavior",
  "brief": "brief.md",
  "allowedPaths": ["src/example.ts"],
  "nonGoals": ["Unrelated refactoring"],
  "acceptance": ["Run the covering tests"],
  "dependencies": [],
  "authorization": {"source": "User-approved plan", "localCommits": true},
  "tier": "standard"
}
```

The repository must have a commit, a clean worktree, and ignored `.shawshank/runs/`
storage in its common checkout. Relative brief paths resolve beside task.json.
Allowed paths are relative to the worktree. Registration checks that required
inputs exist; it does not claim the dependencies or acceptance checks passed.
Dispatch resolves the common checkout's `.shawshank/config.json` and optional
`.shawshank/config.local.json` overlay. It selects the tier's first implementer and
records that worker, project commit trailer, parent pane, and allowed tab. It
supports codex/opencode/claude entries with explicit args. Unsupported entries stop;
automatic availability fallback is not implemented.

### External-reference permissions

Standalone briefs remain at their caller-owned paths. When outside the worker's
repository, they can trigger an OpenCode external-directory approval prompt in
each fresh session, depending on its permission configuration. Final-stage workers
also read shared instructions such as `references/final-reviewer.md`, which can
trigger the same prompt when the skill is outside the repository.
Inspect the actual requested resource and follow the user's permission boundaries;
a dispatch reference is not permission to approve broader access. Do not silently
add persistent permissions. Plan-linked briefs use run-local snapshots instead.

Every OpenCode role therefore includes an explicit `--auto` in its args, in test
and end-to-end fixture configurations as well as real ones. Without it, OpenCode V2
asks for approval on nearly every dispatch, report and evidence access, and each
prompt stalls the run. Dispatch, replacement and final-run registration reject any
OpenCode role they launch or snapshot for a later stage when it lacks `--auto`,
before recording an attempt; there is no override. A retained worker that is only
prompted again is not rechecked. `--auto` approves only
requests that are not explicitly denied, so restrict workers with OpenCode deny
rules rather than prompts. It stays a configured arg, never an injected one.

## Worker configuration

Use roles.implementer for implementer tiers and roles.taskReviewer for independent
single-task review in .shawshank/config.json (with optional config.local.json overrides).
The separate roles.reviewer is the final-review role, and
roles.verifier remains final-review fix verification. Task review never falls
back to roles.reviewer. Existing runs retain their saved reviewer; runs without
a saved reviewer resolve roles.taskReviewer at first review. Configure
taskReviewer before starting a new task review.

Implementer tiers and the task reviewer are independently configurable. Each selected
entry requires kind, model, and an explicit args array. Args are passed verbatim
except for OpenCode V2 selection flags described below; model is recorded metadata,
not an automatically injected flag. Keep args consistent with model. For example,
a Claude entry is {"kind":"claude","model":"sonnet","args":["--model","sonnet"]}.
Use the installed CLI help to choose supported model and effort flags. Do not
silently add permission bypasses. Empty args deliberately uses CLI defaults.

Use the project's authorized permission settings unless explicitly overridden.
`project.workerPermissionPolicy`, when present, records the project's existing
authorization; it does not grant new authority or alter launch args.
The dispatcher does not inject permission flags or alter saved role snapshots.
An explicit Auto override remains valid and may still request approval;
do not silently change a running session.

All three kinds run as external Herdr agents with the same reports, acceptance,
repair, recovery, and cleanup rules. No Claude Agent API, native-subagent fallback,
or controller-kind-based routing exists.
Choose the controller when launching its session; the tool does not launch or
change the controller's model. Do not silently mutate saved launch settings.
Retained implementers carry their saved launch metadata into repair prompts.
An explicit replacement or tier escalation updates the current implementer
snapshot; historical dispatches remain unchanged. Older runs without a matching
snapshot retain only known kind/model values rather than borrowing current settings.

### OpenCode launch contract

Only V1 and V2 are supported; 0.x and unknown versions fail closed.
Check [OpenCode prerequisites](../SETUP.md#opencode-prerequisites) before dispatch,
including the supported-shell requirement. A one-shot probe rejects controller/pane
executable or version mismatches before session creation; API calls use the verified executable.
The probe writes only a temporary receipt, removed after confirmed completion
or a definite pre-send failure. Once sending is attempted, an incomplete receipt
is retained for inspection, never automatically replayed.
Readiness checks wait within bounded limits for incomplete observations and the
probe's transient agent detection to clear; conflicting identities fail immediately.
V1 passes args unchanged and waits for `Ask anything` plus three seconds.

V2 accepts `-m`/`--model provider/model[#variant]`, `--variant value`,
`--agent value`, and explicit `--auto`. Selection flags configure a fresh session
through `opencode api session.create` in the verified worker shell directory;
Herdr starts the full TUI with its returned `--session` ID. No project/global
configuration is written. Omitted selections use OpenCode defaults, not role
metadata; an unspecified variant is not a fixed effort claim.
Prefer explicit `--variant` for launch attribution. Dispatch attribution runs
before version discovery, so it preserves model selectors verbatim and never
infers effort from `#variant` in CLI args or model metadata. Only the V2 launcher
validates and decodes that suffix; workers may update attribution from verified
session evidence. Malformed or conflicting V2 selectors are rejected, not truncated.
Mini, run, resume/continue, startup prompts, alternate servers and other arguments
are rejected before session creation, rather than silently translated or dropped.

Before task input, verify the exact lifecycle-reported session, pane identity,
settled status, directory and explicit model/agent/variant via `session.get`.
Missing hook evidence or working/unknown status gets the same bounded read-only
polling, even when hooks are complete. Blocked/unexpected status and conflicting
worker/session identities fail immediately. Complete evidence, idle/done and the
session API check are all required before task input.
The API prepares and inspects sessions only; task prompts still use Herdr.
Failed/uncertain creation or startup is not retried automatically. Retain the
reported session ID and pane, reconcile against the attempt, and follow
[startup recovery](recovery.md#startup-and-unavailable-task-reviewers).
Do not infer delivery from an idle session or delete uncertain sessions.
Structured errors preserve the original code/cause and distinguish `prelaunch`,
`session-create`, and `session-start`. V2 failures do not enter the legacy
`startup_blocked` shortcut because it does not revalidate V2 sessions.

Upstream contracts: [OpenCode V2 API](https://opencode.ai/v2/docs/api) and
[Herdr OpenCode integration](https://herdr.dev/docs/integrations/#opencode).

### Dispatch and acceptance

The parent pane must be in the explicitly authorized tab. Dispatch creates a new
pane without focus and leaves it available for later review/repair. It does not
close user panes. Status is read-only and does not poll Herdr; use the returned
worker identity for observation. Acceptance independently checks live identity
and an idle/done worker, clean Git state, report provenance, every commit's scope
and trailer, and PASS evidence for every required check. It does not rerun arbitrary
commands found in a report or replace independent review. Success is
`implementation_accepted`, not task completion.

The report contract is in the generated dispatch; check evidence must
use an object with nonempty `command` and `result` strings describing the actual
execution, not a bare success assertion. These are worker-reported evidence;
schema validation does not prove that a command was executed.

## Execute one task

1. `register-task <task.json> --controller <id>` when starting, not resuming.
2. `dispatch-implementation <run> --controller <id> --pane <parent> --tab <tab>`.
3. Observe the returned worker using explicit Herdr name/pane. Use bounded waits;
   use `herdr agent wait <worker> --timeout 30000` for normal completion, without
   `--until idle`: both idle and done are settled states. Inspect blocked/unknown
   states. A timeout is not proof of non-delivery. Do not
   send a second prompt just because the first command did not return success.
4. Read the delivery and run `accept-implementation <run> --controller <id>`.
   This records readiness for review, not task completion. Requirements for the
   worker are in [implementer.md](implementer.md); generated dispatches
   already contain the task-specific contract and designated report path.
5. `dispatch-review <run> --controller <id>` creates an independent reviewer for
   the first review and reuses that session for scoped re-reviews after repairs.
   Observe it, read its report, then `accept-review <run> --controller <id>`.
   See [task-reviewer.md](task-reviewer.md) for the role boundary.
6. Judge every finding from evidence. Write a new decision file in the run
   directory; run `record-triage <run> --controller <id> --decision <file>`.
   An empty finding list still needs a HEAD/attempt-bound empty decision list.
7. If repair_required, use `dispatch-repair`, then repeat delivery acceptance and
   independent review. Do not reset counts or silently drop/defer findings.
8. At task_passed, verify cleanup is complete. Pending cleanup is reported
   separately and retried with `cleanup-workers` after resolving its cause.

## Task review and repair

The first review uses a new independent pane in the recorded tab and covers the
original baseline through the latest accepted HEAD. After repair, reuse the same
reviewer session with a new attempt and report. Re-review verifies prior findings
and regressions caused by the fix, using the previous reviewed HEAD through the
latest accepted HEAD; inspect affected callers as needed, not unrelated unchanged
code. Record incidental out-of-scope observations in report evidence rather than
adding new blocking findings. Report base_sha still identifies the original task
baseline for provenance. The reviewer must not edit code.
Required report fields are attempt_id, base_sha, head_sha, evidence, and findings.
Each finding has a unique id, severity (critical/major/minor), category
(in_scope/pre_existing), status (open/resolved), title, and concrete evidence.
An empty findings array is valid. A re-review must carry every prior finding id,
including deferred findings, and independently establish whether it is resolved.
The prior independent report and triage are included. No finding may disappear.

Acceptance snapshots the report and leaves the run at review_accepted. Triage
input binds attempt_id and head_sha and supplies decisions covering every finding
exactly once. Each decision contains id, action, and evidence. Actions:
fix, invalid, pre_existing, wontfix, resolved, deferred. Pre-existing and resolved
classifications must match the reviewer; wontfix is only for minor findings.
Deferred findings require user_authorization describing the actual user decision.
These fields record evidence; they do not manufacture authorization. Any fix
decision requires repair; otherwise the task passes, disclosing any deferrals.
Triage input is snapshotted separately and does not overwrite earlier decisions.

Repair reuses the accepted implementer for three rounds, then escalates one tier
and starts that tier's first configured worker, after confirming the old one is
idle/done. At the highest tier the fourth requested round stops for user judgment.
The total count is never reset. Repair delivery requires a new descendant commit,
all original scope/trailer/check gates, and an independent scoped re-review.
For unavailable workers or interruption, read [recovery.md](recovery.md).

## Worker pane cleanup

Dedicated feature tabs use the opt-in [reusable shell](feature-tab.md) lifecycle:
the assigned pane runs a worker, then returns to a shell between tasks. The rules
below describe split-only panes; reuse mode preserves its assigned shell instead
of closing it. It never reuses or closes the controller's conversation pane.

A repair decision retains both implementer and reviewer; task_passed closes all
accepted workers owned by that run. Escalation closes the idle old implementer
before creating its replacement; it does not replace the reviewer. A new task
gets a new independent reviewer. Unaccepted reports, busy/blocked/unknown
workers, changed identities, or dirty Git state prevent closing. No timeout grants
permission to close. User panes and the recorded parent pane are never targets.

Cleanup verifies the recorded pane, tab, agent name/kind, working directories,
accepted delivery, and clean accepted HEAD. It confirms pane_not_found after close;
other lookup errors do not mean absence. Herdr does not offer atomic
compare-and-close: do not concurrently repurpose owned panes during cleanup.

Cleanup is separate from the task result: failure leaves task_passed intact
and records pending cleanup. Status stays
read-only. Explicit retry rechecks identity:

```sh
bun <skill>/scripts/workflow.ts cleanup-workers <run> --controller <id>
```

Retries recognize already absent panes and do not close them twice. Pending
cleanup prevents registering another task in that worktree. A closing claim
prevents concurrent workflow mutations; recovery of a claim left by process death
requires [explicit recovery](recovery.md), not an automatic timeout. Repositories,
commits, databases, reports and decisions are retained after the pane closes.

Final reviewer/verifier cleanup is specified in [final-controller.md](final-controller.md).
For failed startup, report correction, handoff or replacement, read
[recovery.md](recovery.md) before acting.
