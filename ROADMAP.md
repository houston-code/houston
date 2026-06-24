# Roadmap

Houston has closed the bulk of the Claude Code feature-parity gap (see the
**Features** list in the [README](./README.md)). This file tracks the items that
are intentionally **not done yet** — either out of scope for a local-first macOS
desktop app, or a larger effort than the current sweep covered. Each notes *why*
it's deferred and roughly *what* it would take, so nothing is silently dropped.

## Deferred — larger effort

- **Trusted folders (project-config elevation).** A repo's `.houston/settings.json`
  may currently only *tighten* (add deny/ask rules) — `allow` rules, hooks, and
  MCP servers are ignored from project files because opening an untrusted repo
  would otherwise let it auto-approve actions or spawn processes. A "trust this
  folder" prompt (persisted per workspace) would let users opt into honoring a
  trusted project's hooks / MCP servers / allow-rules. *Why deferred:* needs a
  trust store + a clear consent UX to avoid becoming an RCE foot-gun.

- **Programmatic SDK.** A stable, importable API for embedding the agent in other
  Node programs (beyond the one-shot CLI below). *Why deferred:* needs a versioned
  public surface and packaging separate from the Electron app. One-shot headless
  runs (`Houston -p "<prompt>"`, see the README) already cover scripting/CI.

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

- **Code index / semantic (embeddings) search.** Houston searches the project
  *live* — a bundled **ripgrep** (`search_files`) plus `glob` and the model's own
  reasoning over what it reads — rather than building and maintaining a persistent
  code index, a symbol/dependency repo-map, a tree-sitter parse tree, or an
  embeddings/vector store for semantic retrieval. *Why this is deliberate, not
  missing:* (1) a background index is a correctness liability in an agent that is
  itself editing the tree mid-turn — it goes stale against the agent's own writes
  and needs constant re-sync; (2) it's a heavyweight, always-on subsystem for a
  single-user desktop app; (3) semantic search needs an embeddings provider + API
  key, which cuts against bring-your-own-model and the local-first/privacy stance
  (keys stay in the Keychain; nothing is shipped off-machine to be indexed). Modern
  long-context models navigate unfamiliar code well from exact search +
  `read_file` + `run_shell`, so an index mostly buys latency, not capability.
  *If revisited:* prefer an opt-in, on-demand structural layer over a persistent
  index — e.g. ast-grep (which [`binaries.ts`](src/main/binaries.ts) is already
  set up to vendor) for structural/symbol queries, or a semantic-search **MCP
  server** — both plug into the agent without baking an indexer into the core.
  LSP-backed go-to-definition / find-references is the other large lever, tracked
  under IDE integration below.

## Deferred — polish

- **Clickable file paths in the transcript.** Linkify `path:line` references in the
  agent's replies so a click opens the file. *Why deferred:* doing it well needs
  reliable path-detection in prose (to avoid false positives), an open-in-editor
  IPC with an editor preference, and changes to the actively-evolving Markdown /
  tool-row renderers — more than a polish pass.

- **`.gitignore`-aware `glob`.** `search_files` already respects `.gitignore` (it
  uses ripgrep); the `glob` tool doesn't (it skips node_modules / dotfiles / build
  dirs but not project-specific ignores). *Why deferred:* ripgrep's glob semantics
  differ from `glob`'s current `minimatch` (recursive vs. shallow `*.json`), so
  delegating would change the tool's contract, and a partial hand-rolled
  `.gitignore` parser would only *half*-respect it. Low marginal value given the
  existing dir/​dotfile skips and that search is already ignore-aware.

- **Edit & resend a message.** Edit an earlier user message and re-run from that
  point (truncating the later turns). *Why deferred:* needs conversation-history
  rewind + a branching/transcript-truncation model — a real feature, not a tweak.
  (Retry-the-last-failed-turn already ships; see the README.)

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
