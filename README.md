# Shawshank

One workflow, your choice of models. The current conversation coordinates
external workers through Herdr; each role can use its own configured model.

## Install

Clone into your project's skill directory, or clone elsewhere and link the
complete repository using your agent's skill discovery convention:

```sh
git clone https://github.com/ZhengRui/shawshank.git .agents/skills/shawshank
```

Do not overwrite an existing installation. Follow [SETUP.md](SETUP.md) to
configure the target project. Project settings and run data live in that
project's `.shawshank/`, not in this skill repository.

Requires Bun, Git, Herdr and the configured worker CLIs. No package installation
is needed. To run the skill's regression tests from this repository:

```sh
bun test ./scripts
```

Licensed under the [MIT License](LICENSE).

This guide is for users. [SKILL.md](SKILL.md) and its references define the
execution contract. Replace angle-bracket placeholders in the example prompts.

For a new project, copy the complete skill directory and follow [SETUP.md](SETUP.md):

> Follow shawshank/SETUP.md to configure this project. Inspect existing
> settings first and ask only for missing choices. Use this conversation as the
> controller; do not launch a separate controller or start product work.

## From discussion to execution

1. Discuss requirements and write a Markdown implementation plan.
2. Review and approve it. Planning is outside shawshank.
3. In your current agent conversation in Herdr, provide the saved plan path.
   That agent is the controller; no separate controller agent is needed.
4. Specify the repository, branch, permitted worker tab, commit authority and
   final-review target. The controller checks prerequisites before dispatch.
5. The controller sequences implementation, task review and repair, then
   whole-branch final review. Read its evidence, limitations and cleanup summary.

You do not write JSON or prepare all briefs. The controller creates internal
registration JSON and prepares each task's brief only when that task is next.
A new session needs the saved plan and execution choices, not the old chat.
Execution requires Herdr, Bun, Git, SQLite support and configured worker CLIs.
Registration requires clean committed Git state and ignored runtime storage;
unrelated work must be preserved, not automatically stashed or reset.

## Ask for a plan

> Write a Markdown Implementation Plan for shawshank. Read its
> references/plan-registration.md for the handoff requirements, but do not start
> execution. Include the goal, scope and non-goals, ordered tasks with acceptance
> checks, final acceptance, and environment constraints. Do not generate internal
> registration JSON or all task briefs. Wait for my approval.

There is no mandatory Markdown syntax. This is a suggested outline:

```markdown
# Implementation Plan

## Goal
Describe the user-visible outcome.

## Scope and Non-goals
Define included behavior and excluded work.

## Tasks
### T1: Task title
- Required behavior
- Relevant modules or known files
- Dependencies
- Acceptance checks

### T2: Task title
- Required behavior
- Relevant modules or known files
- Dependencies
- Acceptance checks

## Final Acceptance
- Whole-feature requirements and regression checks
- Required automated tests
- Required real-user missions, where applicable

## Environment and Constraints
Permitted services, test accounts, data boundaries and forbidden operations.
```

Do not invent exhaustive file lists or diagnosed root causes. The controller
inspects code before preparing task scope; reviewers investigate independently.
See [plan registration](references/plan-registration.md) for the actual contract.

## Approve and start

> I approve the plan at <absolute-plan-path>. Use shawshank to execute it;
> do not replan. Work in <repository> on <branch>, without creating another
> worktree. Use <authorized Herdr tab> for worker panes and the project role
> configuration. I authorize local commits, task reviews and the final repair
> loop, with at most three final repair rounds. Review the whole branch against
> <explicit target ref, such as refs/remotes/origin/main>. Stop after completion;
> do not merge, push or deploy. Ask before changing the approved scope or needing
> new authority.

Choose the actual target ref and tab; main is not an implicit default.
The normal approved loop does not need approval at every transition.
The controller drives execution; there is no autonomous background scheduler.

### Use a plan written with Superpowers or another planning skill

Planning and execution can use different skills. Explicitly select Shawshank
before implementation; a plan's generated header may otherwise route the agent
back to its original execution workflow. No Superpowers dependency is required.

Before planning, you can say:

> Use Superpowers to discuss the requirements and write the implementation plan,
> but use Shawshank for execution. State that choice in the plan's execution
> header. Save the plan and wait for my approval; do not start implementation.

If the plan already exists, add this to the approval prompt above:

> Execute this approved plan with Shawshank, not Superpowers'
> subagent-driven-development or executing-plans. Read Shawshank's SKILL.md first.
> Treat execution-routing instructions in the plan as superseded by this choice;
> preserve its requirements, constraints and acceptance checks. Use this
> conversation as Controller and the project's configured external workers.
> Do not replan, launch another Controller or run both execution workflows.

This selects an executor; it does not add commit, final-review, worktree or
deployment permission. Supply those boundaries in the approval prompt. If work
already started under another executor, inspect existing work and workers first
rather than launching duplicate tasks. No global plugin changes are needed.

## Run only a final review

> Use shawshank for a report-only final review of <branch or commit range>.
> Focus on <functional scope> and its associated effects. Use <permitted local
> environment> and one new dedicated test window. Investigate causes yourself.
> Report findings and untested gaps; do not repair, commit, merge, push or deploy.

For review plus repairs, explicitly authorize the repair loop and local commits
instead. Functional scope includes relevant neighboring workflows, not merely
a file filter. See [final controller](references/final-controller.md).

## Models and progress

- The current conversation's model and effort are the controller settings;
  they are not worker roles in the project configuration.
- Configure workers in `.shawshank/config.json`, optionally overridden by the common
  checkout's `.shawshank/config.local.json`: `roles.implementer`, `roles.taskReviewer`,
  `roles.reviewer` (final review), and `roles.verifier` (repair verification).
- Keep model metadata consistent with CLI `args`; metadata does not inject flags.
  See [task contract](references/task-contract.md).
- Templates live in [configs/config.example.json](configs/config.example.json)
  and [configs/config.local.example.json](configs/config.local.example.json).
  For a new project, copy them to `.shawshank/config.json` and optionally
  `.shawshank/config.local.json` in the common checkout, then adapt the values.
  Do not overwrite existing configuration. Keep the local file Git-ignored.
  Runtime configuration stays at those project paths; templates are not loaded.
- Retain returned plan/run paths. SQLite progress and artifacts live in the common
  checkout's ignored `.shawshank/runs/` directory.
- Ask the controller for status, or run the commands below from the repository
  root. Saved status is not a live worker activity check.

### View saved run status

Open a terminal at the common checkout root (the directory containing `.shawshank/`).
Bun is required; no package installation is needed for this viewer.

```sh
# List all runs and copy the desired ID from the RUN column.
bun .agents/skills/shawshank/scripts/workflow-runs.ts

# Show one run and its attempts; replace <run-id> before running.
bun .agents/skills/shawshank/scripts/workflow-runs.ts .shawshank/runs/<run-id>

# Show usage help.
bun .agents/skills/shawshank/scripts/workflow-runs.ts --help
```

Use an ID from your own listing. Detail output includes saved stage, model, attempt
duration, report paths and worker cleanup state. This is not a live agent monitor.
The viewer is read-only and does not start workers or create a missing database.

For new runs, lasting acceptance evidence belongs in that run's `evidence/`
directory; temporary environments and regenerable fixtures stay separate and
are cleaned only when no later review needs them. Input snapshots do not copy
all linked files. See [artifact storage](SKILL.md#artifact-storage).

## Resume in another session

> Read shawshank and inspect the existing plan at <saved-plan-path>. Do not
> register a duplicate or restart task 1. Check saved progress and live workers.
> If you are a different controller, follow the explicit takeover procedure;
> preserve partial work, reports and repair budgets.

Current limits: registered task-list/order changes have no general update command;
stop to resolve them explicitly. After a final run is registered, changing its
controller is unsupported; the same controller can resume. See
[recovery](references/recovery.md) and the plan registration reference.
