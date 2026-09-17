# Chrome DevTools MCP: one test window

Use the run's specified connection, not claude-in-chrome or an unapproved fallback.
For a fresh automation-only browser launched by this run, identify and navigate
its initial blank page. That newly created window is the test window: do not
also call `new_page(isolatedContext=...)`, which creates a second window.
An existing blank page is not proof of ownership. When connecting to an existing
browser, the run instead needs a supported new-window creation method.

Use returned page IDs for actions. Establish window ownership from actual launch
and target evidence; do not demand a numeric window ID when the tool does not
expose one. A successful launch command or debug-port file alone is insufficient.

MCP 1.8.0 may refuse to close the last page. Closing an exclusively run-owned
browser/session is valid cleanup; a global Chrome kill is not. If no supported
owned-session shutdown is available, report cleanup pending. Navigating to
about:blank does not close the window or clear its session.

The workflow does not automate browser ownership or process cleanup. Verify the
selected worker's actual startup and shutdown capabilities before relying on them.
