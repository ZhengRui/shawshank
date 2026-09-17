# Interaction checklist: conditional depth

Apply only relevant checks; record meaningful exclusions, not boilerplate rows.

| Area | Questions to investigate |
| --- | --- |
| Hidden prerequisites | Does an action appear only after unrelated selection, navigation or mode changes? Could a new user discover the prerequisite? |
| State separation | Are selection, navigation, active operation, panels, preview and save/error state unnecessarily coupled? |
| Consistency | Do click/tap, Enter, Back/Esc, Delete and Undo change meaning because of invisible state? |
| Operation lifecycle | Are start, active state, finish and cancel clear? Is pending work and its target visible? |
| Cross-context effects | What happens after switching objects/contexts, returning, undoing, saving, previewing or recovering from an error? |
| Destructive consequences | Are affected references and downstream effects apparent before a consequential action where practical? |
| Preview versus runtime | Does preview use the intended context? Does the actual end-user experience agree with it? |
| Desktop and touch | Where supported, are discovery, input, cancellation and recovery usable on each, without hover-only essentials? |
| Efficiency and terminology | Do common tasks require unnecessary setup, confirmations or context switches? Do labels describe user goals rather than internal states? |
| Failure and recovery | Are success, failure and recovery actions clear? Is work/context preserved as promised? |

Use concrete end-to-end missions such as edit → save → validation failure →
recover, or context A → context B → undo, when those transitions exist in scope.
Do not turn this checklist into an obligation to audit unrelated product areas.
