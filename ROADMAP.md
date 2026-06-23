# Roadmap

Houston has closed the bulk of the Claude Code feature-parity gap (see the
**Features** list in the [README](./README.md)). This file tracks the items that
are intentionally **not done yet** — either out of scope for a local-first macOS
desktop app, or a larger effort than the current sweep covered. Each notes *why*
it's deferred and roughly *what* it would take, so nothing is silently dropped.

## Deferred — larger effort

- **Headless / SDK / CLI mode.** Run the agent without the GUI window — a one-shot
  `houston -p "<prompt>"` and a programmatic API for embedding/automation.
  *Why deferred:* Houston is a GUI Electron app; a headless entry point is a
  separate architecture (a non-window Electron or Node path plus a stdout
  streaming protocol and exit-code contract). The agent loop itself is already
  UI-agnostic, so this is mostly a new entry point + transport.

- **GitHub integration (first-class).** Built-in PR creation/review and a "install
  GitHub app" flow. *Why deferred:* the agent can already drive `git` and `gh`
  through `run_shell` (network-gated), which covers most needs. A first-class
  integration means OAuth/token handling and PR UI — its own feature.

- **Mid-run resume after a crash/restart.** Re-enter an interrupted tool loop
  exactly where it stopped. *Why deferred:* conversations already persist
  incrementally and you can continue by sending a new message; true auto-resume
  of an in-flight run needs persisted run state and a reconnect state machine.

- **Parallel execution for write/shell tools.** Today only all-read turns run
  concurrently. *Why deferred:* concurrent writes/commands need conflict handling
  and a concurrent (rather than sequential) approval UI.

- **Windows / Linux support.** The execution sandbox is macOS Seatbelt only.
  *Why deferred:* other platforms need their own confinement (Linux namespaces /
  `bwrap`, a container, or Windows job objects) before shell execution is safe.

## Deferred — polish

- **Customizable keybindings.** A user-editable key map beyond the built-in
  shortcuts (⌘N / ⌘, / Esc). Would add a keybindings file/UI and a resolver.

- **Custom-command status line.** A status line whose content comes from a
  user-configured shell command (Claude Code's `statusLine`), beyond the built-in
  live-activity status bar.

- **Tool-result image thumbnails.** When the agent `read_file`s an image, the
  model sees it but the transcript shows a text marker; render a thumbnail in the
  tool card too.

- **IDE integration.** VS Code / JetBrains extensions. Out of scope for a
  standalone desktop app, but listed for completeness.
