# Set up Shawshank in a project

Use this guide for first-time setup or missing configuration. Inspect existing
settings first; preserve unrelated configuration and user changes. Ask only for
choices that project files and the current conversation do not already settle.
Setup prepares configuration; it does not start an implementation or review run.

The agent in the user's current conversation is the controller. Its model and
reasoning settings belong to that session. Do not launch another controller or
add a controller role to the worker configuration. Execution needs a verified
Herdr launch context; configuration can be prepared before that context exists.

## 1. Check the project and tools

- Keep the complete skill directory, including scripts, references and configs,
  at `.agents/skills/shawshank/`. Follow the host's existing skill discovery
  convention; if it is not discovered automatically, provide its SKILL.md path.
- Inspect the Git root, branch, working tree and common checkout. Configuration
  and runtime storage belong to the common checkout, including when executing
  in a linked worktree. Setup does not require discarding or committing changes;
  run registration later requires a clean committed worktree.
- Check Git, Bun (including `bun:sqlite`), Herdr, and the selected worker CLIs.
  Use installed help/version commands to check availability and supported flags.
  Bun supplies SQLite access; no separate database server or root package.json
  is required. Report missing dependencies or account access without exposing
  credentials or changing global installations as a side effect of setup.
- Before live pane operations, verify the actual Herdr session and authorized
  parent pane/tab. Missing variables in a tool shell do not alone prove Herdr is
  unavailable; follow [launcher context](references/recovery.md#launcher-context).

## 2. Choose external workers

Reuse existing choices, otherwise agree on the following with the user:

| Configuration | Purpose |
| --- | --- |
| `roles.implementer.cheap/standard/capable` | Implementation and repairs, by task difficulty |
| `roles.taskReviewer` | Review of one task and its repairs |
| `roles.reviewer` | Whole-feature or whole-branch final review |
| `roles.verifier.default/hard` | Verification after final-review repairs |

Each selected entry needs `kind`, `model` and an explicit `args` array. Supported
kinds are `codex`, `claude` and `opencode`; all run as external Herdr workers.
Specify provider and known effort, keeping metadata consistent with actual CLI
flags. Model/effort fields alone do not select CLI settings. Use locally supported
model selectors; template models are examples, not verified account availability.
Do not infer effort from a previous session or permission bypass from worker kind.

One choice per implementer tier is sufficient, and all tiers may use the same
model. Do not configure fallback models the user does not intend to use. Configure
the roles needed for the intended workflow; report-only final review only needs
its reviewer. See [task contract](references/task-contract.md) and
[final controller](references/final-controller.md) for execution requirements.

### OpenCode prerequisites

Use the version-specific [launch contract](references/task-contract.md#opencode-launch-contract),
not V1 flags copied directly into a V2 terminal command.
The controller and assigned shell must resolve the same local OpenCode executable
and version and share its local background service. Both V1 and V2 require
zsh/bash/sh/fish for the executable probe; unsupported shells fail before launch.
V2 requires Herdr's full-TUI lifecycle integration (tested with Herdr 0.9.1 and
OpenCode 2.0.11); Mini is not a substitute. Install or upgrade only with authorization.
Fix reported prerequisite mismatches explicitly; do not fall back to another transport.
Always include `--auto` in every OpenCode role's args, including test and
end-to-end fixture configurations; dispatch rejects OpenCode roles without it. See
[external-reference approval prompts](references/task-contract.md#external-reference-permissions)
for what happens without it.

## 3. Adapt project settings

Read the project's agent instructions, package/tool configuration and development
docs for test commands, service URLs and environment requirements. Ask about
missing account access, browser transport or permitted mutations only when needed.
Browser missions use one new dedicated test window; follow the review references
when preparing an actual run. Do not require a browser for projects without UI work.

Use [config.example.json](configs/config.example.json) as a starting point for
`.shawshank/config.json` only if absent; otherwise merge only the agreed settings.
Replace project placeholders and remove irrelevant examples. Keep
`project.commitProvenance: true` and the adaptable `project.commitTrailer` unless
the user explicitly chooses otherwise. Test commands and environment boundaries
must reach the task/final-review inputs. Whole-branch final review requires an
explicit target ref in the approved plan input.
Keep service URLs, test-account access instructions, forbidden targets and test
commands in approved task/review inputs, not inert configuration fields. Do not
copy credentials into retained inputs or reports.

Use [config.local.example.json](configs/config.local.example.json) for optional
machine/account overrides in `.shawshank/config.local.json`. Prefer account-access
references in briefs; never copy credentials into tracked settings or reports.
Ensure the common checkout ignores `.shawshank/config.local.json` and `.shawshank/runs/`.
Keep `.shawshank/config.json` trackable; do not ignore the entire directory.
Check whether either is already tracked: ignore rules do not untrack files. Report
that condition and agree on handling it rather than silently deleting their data.

## 4. Verify and hand off

Parse the resulting JSON, check the effective shared/local settings, and verify
each selected role's model, effort and permission arguments against installed CLI
help. Confirm ignore rules and that all referenced skill files exist. There is no
setup command that authenticates providers or proves worker readiness.

Summarize configured roles, configuration paths, checks performed and unresolved
prerequisites. Distinguish static validation from an actual worker launch. If a
live smoke test is authorized, use the agreed Herdr tab and a disposable repository
to verify launch, one bounded task and owned-pane cleanup; report exactly what ran.
Otherwise mark live validation as not run. Do not start product work during setup.

Return to [README.md](README.md) for approving a plan and starting execution.
