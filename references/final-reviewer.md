# Final reviewer: inputs and scope

Use the approved plan/specification or standalone scope, repository, exact base
and reviewed HEAD, required checks/missions, and environment constraints. Read
relevant approved decisions, but do not receive the implementation conversation
or rely on an implementer's claims as proof. If material requirements are missing
or contradictory, describe the gap rather than inventing a requirement.

The controller supplies goals and boundaries, not an investigation answer.
Minimum context is the functional scope and associated effects, repository and
revision, known symptoms or acceptance requirements, permitted environment and
test account access, dedicated test-window boundary, forbidden actions, intent and
report path. Separate observed facts from hypotheses. Do not require a diagnosed
root cause, exhaustive file list, call graph or complete reproduction script
before dispatch. The reviewer discovers these and adds necessary missions.

Define three scope groups from the code and requirements:

1. Primary: every changed file and every behavior promised by the approved scope.
2. Extended: named workflows that call changed code or share changed state,
   interfaces, persistence or permissions. Add newly discovered neighbors and
   explain why they belong.
3. Excluded: unrelated behavior. Incidental pre-existing problems belong in
   separate non-gating observations, not the blocking findings list.

Inspect every changed file. Explain applicable handling for generated, binary or
non-behavioral files rather than silently omitting them. Trace affected callers
where needed; a clean changed function does not establish safe integration.

Build a coverage record connecting each promised behavior to a concrete check or
mission and its evidence. Do not impose a fixed number or upper limit on missions.
Combine overlapping scenarios when they still demonstrate each requirement.
Substantial terminal, API and backend workflows need behavioral scenarios too;
do not force browser scenarios onto work with no UI.

## Four review perspectives

### Correctness and implementation economy

Check requirements, edge cases, error handling, state transitions, compatibility
and regressions. Verify source-of-truth ownership and the effect on consumers.
Check that tests would detect the relevant failure, not merely exercise code.

Assess whether the change introduces unnecessary state, duplicated logic,
abstractions or special cases. Report concrete maintenance or correctness impact;
personal style preferences and unsolicited redesign are not defects.

### Security

Trace affected trust boundaries, validation, authorization, ownership checks,
sensitive data handling and client/server responsibilities. Evaluate realistic
misuse within the permitted environment. Do not run destructive probes or access
forbidden accounts, hosts or data to obtain review evidence.

### User-centered behavior

Start with the user's goals and objects, not the implementation's component list.
Describe the simplest reasonable expected workflow, then trace the actual one.
For each meaningful action ask:

- Will the user know what to do next?
- Is the action discoverable where expected?
- Is the resulting change understandable?
- Is success or failure apparent?
- Can the user cancel, go back, undo or recover where appropriate?

Separate the observed symptom from its state or interaction root cause. Propose
a simpler behavior when warranted; an added tooltip or confirmation is not an
automatic remedy for a structural workflow problem. Recommendations do not
authorize a redesign beyond the approved scope.

For stateful, multi-mode or interaction-heavy changes, read
[interaction-checklist.md](interaction-checklist.md) and apply relevant parts to
primary and extended scope.

### Runtime validation

For user-facing changes, execute the relevant missions in the actual permitted
running application. Source inspection, unit tests, screenshots and server health
checks are useful evidence but do not substitute for required interactive work.

Honor the supplied browser/profile, account, service and data boundaries. Do not
silently substitute another environment or start/restart services. Record test
data created and cleanup performed where the task permits such mutations.

### Autonomous investigation and pauses

Find the actual entry point, trace affected code and design the necessary checks
yourself. Within existing authority, inspect requests, logs and relevant
configuration when a mission fails. Distinguish product defects, environment
failures and missing capability; an unexpected error is not itself a reason to
return the investigation to the controller. Do not expose credentials in reports.

Pause the affected action when it requires new authority, necessary capability is
genuinely unavailable, or continuing is unsafe. Give evidence, checks already
performed, the specific missing capability or permission, and a proposed next
action. Continue other safe in-scope investigation where useful; do not reset
databases or restart shared services without authorization. Label hypotheses
when the evidence does not establish a root cause.

During a long investigation, give brief updates naming the current check and
latest evidence. The controller observes live worker/report state; a wait timeout
or unchanged terminal screen alone does not justify interrupting the reviewer.

### Dedicated browser isolation

The reviewer starts and uses ONE new dedicated test window; controller pre-login
is not a prerequisite. No specific profile is required unless explicitly requested.
Establish ownership through the selected tool and launch evidence, then target
owned pages explicitly. A new tab in a user window is not sufficient. Minimal
target inventory is allowed; never inspect or manipulate unrelated user pages.
If ownership cannot be established, pause browser actions rather than guessing.

Check authentication yourself. A separate window may share login state: do not
change the user's session, clear shared cookies or alter profile-wide settings.
Use only authorized test data and accounts. At completion close owned windows
and clean authorized disposable data; report any pending cleanup honestly.

For Chrome DevTools MCP, read [browser-devtools.md](browser-devtools.md) for the
single-window startup path and current tooling limits.

### Coverage outcomes

Distinguish PASS, FAIL, NOT RUN and justified NOT APPLICABLE for coverage items.
Missing access or an unavailable service means NOT RUN, not NOT APPLICABLE.
Identify missing necessary missions even if the controller omitted them from
the supplied list. Request missing capability/authority; do not quietly lower
the acceptance bar or expand permissions.

## Findings and reporting

Follow [artifact storage](../SKILL.md#artifact-storage) for supporting evidence.
Keep the dispatch's exact report path and retain cited temporary evidence before
submitting, without secrets or changes to earlier accepted artifacts.

A finding describes a demonstrated in-scope defect, not the proposed fix itself.
Use stable IDs and these categories only: code, security, ux, runtime. Test-code
defects use code. Classify by impact:

- critical: severe failure such as credible major data loss, security exposure
  or broad inability to complete core behavior.
- major: material broken behavior or substantial workflow friction requiring
  hidden knowledge, with concrete evidence of impact.
- minor: bounded lower-impact defects or consistency/discoverability issues.

Do not inflate severity or manufacture findings to exercise the repair loop.
Each finding includes description, concrete location/evidence, expected versus
actual behavior, and reproduction steps when applicable. Explain the root cause
for complex interaction/runtime defects where supported; label uncertainty.
Suggested fixes are optional and remain subject to controller judgment.

The report must communicate:

- exact review provenance and reviewed scope, including added neighbors;
- requirement/mission coverage, actions or commands, results and limitations;
- structured findings with stable IDs;
- separate incidental non-gating observations;
- created test data and cleanup, when applicable.

Avoid a mandatory long essay or duplicate reports that repeat identical content.
A small review may be concise; a large review must not hide coverage gaps inside
a generic statement that everything was checked. An empty findings list does
not imply complete runtime validation.

Use the exact output paths and schema supplied by the executable dispatch. Never
repair code, commit, rewrite accepted artifacts, or operate other agents/panes.
Preserve unexpected code changes and stop; do not automatically revert them.

## Coverage and completion gates

Report acceptance means a valid delivery was received, not that all findings or
required missions passed. The controller checks coverage against the approved
requirements, evaluates findings and records every disposition with evidence.

Tools can reject missing records, invalid identity, stale commits and incomplete
declared checks. They cannot certify the truth or adequacy of prose merely because
fields are populated. No claim of automatic plan-completeness verification.

Required runtime work left NOT RUN blocks repaired completion unless the user
explicitly changes the acceptance scope. Keep that decision and the untested
limitation visible; never turn unavailable evidence into a fabricated PASS.
An applicability decision needs a reason tied to actual scope, not convenience.

Report-only execution can end with findings or coverage gaps reported. Repair-loop
completion requires resolved findings or explicit permitted dispositions, required
evidence, an exact final HEAD, and visible deferrals. Later commits are not covered.
Review completion does not authorize merge, push or deployment.

## Structured delivery

The dispatch is the exact schema source. Final reports contain attempt_id,
base_sha, head_sha, evidence, findings, scope, coverage, observations and cleanup.
scope.primary_files includes every changed path once, including removed/generated
files, and may include unchanged files within the approved functional scope, even
when base equals HEAD. Explain their scope relevance in evidence; the controller
assesses relevance, not the Git file-list validator. Do not list duplicate paths.
scope.extended names neighbors and why; scope.excluded names exclusions and why.
Put generated/binary handling in evidence. observations is a separate
string list; cleanup describes data cleanup or why no data was created.

coverage is a nonempty list of unique requirement strings with status
PASS/FAIL/NOT_RUN/NOT_APPLICABLE and evidence (actions/results or concrete
limitation/applicability reason). Use declared check/mission names exactly; add
promised behaviors and necessary discovered missions. A report with NOT_RUN can
be accepted as a delivery, but is not final acceptance. Findings additionally
require location, expected, actual and reproduction (steps or why inapplicable).
Root cause and uncertainty belong in description/evidence when relevant.

Follow the saved dispatch's schema when resuming; do not rewrite accepted
reports. Field validation cannot establish that a file was read or a mission
performed; concrete evidence remains necessary.
