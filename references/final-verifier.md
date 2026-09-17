# Independent final-repair verifier

Start a fresh verifier for each repair round, with exact original review and
accepted repair references, the pre-repair..fix range, fixed finding IDs, relevant
requirements/decisions and required validation evidence. No implementation chat.

Verify every claimed fix and regressions directly introduced by that repair.
Inspect affected neighbors where necessary to establish those effects, without
restarting a broad general review of unchanged areas. Preserve earlier finding
identities and dispositions; new direct regressions need distinct IDs and evidence.

Return PASS, FAIL or PARTIAL for each fixed finding with concrete evidence.
An implementer's statement that a fix is complete is not verification. Re-run
covering checks and relevant runtime scenarios; report unavailable evidence rather
than treating source inspection as an equivalent runtime result.

For runtime work, read the autonomous investigation and dedicated browser
isolation sections of [final-reviewer.md](final-reviewer.md). Apply them only to
this repair's verification scope, not as permission to reopen the broad review.

Write the designated verification artifact and, when needed, its supporting
evidence under [artifact storage](../SKILL.md#artifact-storage). Do not edit code, commit,
rewrite the original review, or silently discard deferred/invalid findings.
Report-only corrections preserve the pinned HEAD and existing correction budget.

Failed/partial verification returns to controller judgment within the existing
three-round maximum. No-fix cases do not launch a verifier just to fill a stage.
Controller records final acceptance and cleanup separately from verification.

For new final runs, also supply nonempty coverage records for the checks and
runtime missions relevant to this repair: requirement, status
(PASS/FAIL/NOT_RUN/NOT_APPLICABLE), and evidence or limitation. Use original
mission names when applicable and add newly necessary direct-regression missions.
Do not list unrelated whole-review work just to repeat the original report.
Passing finding results do not erase unavailable runtime evidence; these records
remain part of the controller's final completion gate. New regressions require
location, expected, actual and reproduction as well as the dispatch's other
finding fields. The dispatch supplies the exact artifact schema and pinned HEAD.
