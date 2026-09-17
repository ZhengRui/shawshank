# External implementer and repair worker

Use only the designated dispatch and its referenced task/brief, not the
orchestrator's conversation history. The dispatch specifies the repository,
allowed changes, baseline, checks, commit trailer, and exact report location.
For an explicitly acknowledged pause, a retained Controller continuation note
may supersede named stale instructions using a recorded contract revision. Keep
the same attempt/report and partial work; this is not authority to expand scope.

- Implement the approved task, or only the explicitly triaged repair findings.
- Do not delegate, review your own work as an independent reviewer, control
  panes, push, or expand scope. Report blockers instead of guessing permission.
- Preserve existing partial commits and dirty files on an explicit continuation.
  Do not reset, stash, or discard them to make acceptance pass.
- Run required checks and record actual command/result evidence. A check not run
  is not PASS. Leave a clean tree and scope-limited commits when delivering.
- Follow dispatch provenance requirements for provider, model/version, effort
  and harness. Identify yourself, not the Controller; record unknowns honestly.
  Preserve original attribution of existing partial commits after replacement.
- Write your own JSON report to the exact dispatch path. Bind its attempt_id,
  original base_sha, resulting head_sha, status, checks, and concerns. The
  executable dispatch carries the full schema; do not invent a different format.
- For report-only correction, edit only the designated report, preserving code,
  commits, and the pinned HEAD. Use the new correction report path, retaining the
  original report. Correction is not another implementation or repair round.
- For an explicit commit-message correction dispatch, amend only its designated
  unaccepted, unpushed HEAD and update the new report's head_sha. Preserve the
  code tree, parents, author and original report; do not infer amend authority
  from a report-only correction.
- After delivery, stop work and disclose any remaining background process. Do
  not close your pane; the orchestrator may need the same worker for repair.

The tool validates delivery. Your completion message alone does not pass a task.

Follow [artifact storage](../SKILL.md#artifact-storage) for supporting evidence
and temporary files. Keep the designated report path; `evidence/` does not replace it.

## Final-review repair handoff

This section applies to final-review repairs, not the single-task loop.

Controller first confirms each finding against requirements, code and available
runtime evidence. Resolve cross-task conflicts and explain relevant decisions;
do not forward contradictory suggestions as an executable repair plan.

Send one repair implementer the confirmed set, including related findings
together. Its handoff contains:

- original approved requirements and relevant plan/decision references;
- original review, exact current HEAD and confirmed finding IDs/evidence;
- required behavior, affected interfaces/neighbors and constraints that must hold;
- allowed paths, non-goals, permitted local commits and required checks/missions;
- prior repair/verification evidence for subsequent rounds;
- exact report path/schema and when to stop for missing context or scope changes.

Do not rely on chat memory or send only a terse findings list. Do not paste the
entire historical conversation either. The implementer reads the relevant code
and asks for material missing context. Controller owns scope/design judgments;
implementer owns scoped edits, tests and commits. A fresh implementer is not
assumed to understand cross-task decisions without this handoff.

Retain the repair implementer across rounds when its identity remains valid.
Do not split each finding into a separate fixer or silently substitute models.

For final repairs, base_sha is the dispatch's pre-repair HEAD, not the original
review baseline. Follow the final-repair schema instead of the task schema.
