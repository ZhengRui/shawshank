# One feature, one tab

Keep the user's controller conversation in its existing pane. Use a separate
authorized feature tab for workers; do not create one tab per worker.

If the feature tab does not exist, create it with the installed Herdr CLI's
`tab create --workspace <verified-workspace> --cwd <worktree> --label <feature>
--no-focus`. Save the creation receipt and whether the tab was created or borrowed
in a feature-layout note under the plan directory (or standalone run directory).
Carry that note across tasks, final review and controller handoff. A label alone
is not identity or ownership. Do not repeat an uncertain creation request.

For an existing tab, reuse only an explicitly assigned shell pane. Inspect its
prompt and process state first; no detected agent is not proof of an idle shell.
Never use the controller pane or a pane running a command, editor or background
writer. Do not take over an unrelated user's shell merely because it looks idle.

For the initial implementation or standalone final review, append `--reuse-pane`
to the normal `dispatch-implementation` or `dispatch-final-review` command's
`--pane <assigned-shell> --tab <feature-tab>` arguments. The command records the
mode, actual controller pane and worker tab. It checks the shell, switches its
directory to the exact worktree when necessary, verifies the actual directory,
then starts the worker there. Missing shell evidence stops without launching.
HERDR_PANE_ID must identify the actual invoking controller, not the reusable pane.

Without that flag the existing split-only mode is unchanged. Resuming a saved
dispatch uses its existing mode and identities; do not create another attempt.
Other workers split within the feature tab while the first worker is retained.
Normal repair and re-review keep their original sessions. Escalation/replacement
of the worker in the reusable pane ends that agent before reusing the shell.

When cleaning the reusable pane, exit the settled owned agent and verify the
shell returned; do not close that pane. Other owned worker panes close normally.
Thus the tab has one shell between tasks, not an empty shell beside a worker.
Use that shell and --reuse-pane again for the next task and initial final review.
Cleanup `closed` means the worker has ended; in this mode its shell pane remains.
An uncertain exit stays pending. Retry cleanup only after the prior cleanup
command has stopped: a verified shell needs no input; the same settled named
worker may receive another exit request through the agent API. A working or
changed worker stops cleanup. Never send raw exit input, force-kill or close the
user's shell. This retry does not authorize resubmitting task prompts.

Keep this tab throughout the complete feature, including final review and repairs.
At completed acceptance and worker cleanup, close a tab only if the saved creation
receipt proves this feature created it, its only remaining pane is the verified
idle reusable shell, and the controller is not in it. Otherwise preserve the tab
and report cleanup pending. A borrowed tab stays open. Do not close unrelated
panes or create a new tab simply because a saved pane is missing; inspect first.

This note records feature-level layout ownership, not another task state machine.
Task/run acceptance, ownership transfer, recovery evidence and budgets are unchanged.
