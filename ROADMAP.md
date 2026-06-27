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

- **Mid-run resume after a crash/restart.** Re-enter an interrupted tool loop
  exactly where it stopped. *Why deferred:* conversations already persist
  incrementally and you can continue by sending a new message; true auto-resume
  of an in-flight run needs persisted run state and a reconnect state machine.

- **Parallel execution for write/shell tools.** Today only all-read turns run
  concurrently. *Why deferred:* concurrent writes/commands need conflict handling
  and a concurrent (rather than sequential) approval UI.

- **Windows / Linux support.** The execution sandbox is macOS Seatbelt only.
  *Why deferred:* other platforms need their own confinement (Linux namespaces /
  `bwrap`, a container, or Windows job objects) before shell execution is safe —
  and shipping an unverified sandbox on a platform we can't test would be a
  security regression, not a feature.

- **Write-capable / multi-agent delegation.** Today `dispatch_agent` (and custom
  `.houston/agents`) are deliberately **read-only** — a subagent can read/search
  and report back, but can't edit, run commands, or use the network. Letting a
  subagent act would need a nested agent loop with its own tool budget, approval
  propagation back to the UI, and streamed sub-events. *Why deferred:* it's a
  larger architecture change *and* a safety-surface expansion (an autonomous
  sub-loop taking write/shell actions) that deserves its own design + consent UX
  rather than being bolted on. Read-only delegation already covers the common
  "investigate without polluting my context" case.

- **Persistent code index / semantic (embeddings) search.** Houston searches the
  project *live* — a bundled **ripgrep** (`search_files`), a bundled **ast-grep**
  (`ast_grep`) for structural/AST queries, plus `glob` and the model's own
  reasoning over what it reads — rather than building and maintaining a persistent
  code index, a symbol/dependency repo-map, a cached tree-sitter parse tree, or an
  embeddings/vector store for semantic retrieval. *Why this is deliberate, not
  missing:* (1) a background index is a correctness liability in an agent that is
  itself editing the tree mid-turn — it goes stale against the agent's own writes
  and needs constant re-sync; (2) it's a heavyweight, always-on subsystem for a
  single-user desktop app; (3) semantic search needs an embeddings provider + API
  key, which cuts against bring-your-own-model and the local-first/privacy stance
  (keys stay in the Keychain; nothing is shipped off-machine to be indexed). Modern
  long-context models navigate unfamiliar code well from exact search +
  `read_file` + `run_shell`, so an index mostly buys latency, not capability.
  *What's shipped vs still deferred:* the opt-in, on-demand **structural** layer is
  done — `ast_grep` vendors ast-grep (via [`binaries.ts`](src/main/binaries.ts))
  for structural/symbol queries. What remains deferred is the persistent index
  itself: a symbol/dependency repo-map, a cached tree-sitter parse tree, or an
  embeddings/vector store for semantic retrieval (a semantic-search **MCP server**
  is the natural way to add that without baking an indexer into the core).
  LSP-backed go-to-definition / find-references is the other large lever, tracked
  under IDE integration below.

## Deferred — polish

- **Clickable file paths in the transcript.** Linkify `path:line` references in the
  agent's replies so a click opens the file. *Why deferred:* doing it well needs
  reliable path-detection in prose (to avoid false positives), an open-in-editor
  IPC with an editor preference, and changes to the actively-evolving Markdown /
  tool-row renderers — more than a polish pass.

- **`.gitignore`-aware search & `glob`.** Neither `search_files` nor `glob` honors
  a project's `.gitignore`: both skip a fixed set (`node_modules`, `.git`,
  `dist`/`out`/`build`, dotfiles, …) but not project-specific ignore rules.
  `search_files` deliberately runs ripgrep with `--no-ignore` so its results match
  the pure-JS fallback walk, rather than diverging depending on whether the
  bundled ripgrep is in play. *Why deferred:* honoring `.gitignore` only on the
  ripgrep path would make results depend on the runtime environment, and a
  hand-rolled parser for the JS path would only *half*-respect it (nested
  `.gitignore` files, negations, etc.). Low marginal value given the existing
  dir/dotfile skips.

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

## Out of scope — non-goals

These are Codex/Claude-Code capabilities that conflict with Houston's
**local-first, bring-your-own-model** stance or require a hosted backend. They're
deliberately **not** on the roadmap (recorded here so the gap analysis is honest
and nothing is silently dropped):

- **Subscription / OAuth sign-in (ChatGPT, Claude Pro/Max, GitHub Copilot).**
  Houston is **bring-your-own-API-key** by design — keys are stored in the macOS
  Keychain and used directly. Codex's `codex login` (ChatGPT OAuth, included
  usage, workspace RBAC) and similar subscription auth are a different account /
  billing model that doesn't fit a BYO-key local app.

- **Cloud task delegation** (Codex `codex cloud`, parallel/best-of-N attempts,
  isolated cloud sandboxes, `codex apply` of cloud diffs). Requires a hosted
  execution backend and account; Houston runs entirely on the user's machine.

- **Hosted GitHub bot / "install GitHub app".** A *server-side* PR-creating bot,
  hosted code review that runs on GitHub's infrastructure, or an "install GitHub
  app" OAuth flow. *What ships instead:* first-class pull-request tools
  (`gh_pr_create` / `gh_pr_list` / `gh_pr_view` / `gh_pr_comment` /
  `gh_pr_checkout`), `gh_repo_create` for new repositories, and the `pr_sweep`
  board (batch-author PRs from tasks, or
  process a batch of existing PRs), all driving the user's local `gh` CLI — no
  hosted backend, no app-level token storage (`gh` owns auth), which keeps
  Houston local-first. The remaining non-goal is specifically the
  *hosted* bot/app side, which needs a multi-tenant backend and an OAuth app
  registration that don't fit a single-user desktop app.

- **Cross-platform execution sandbox (Linux/Windows/WSL2).** See *Windows / Linux
  support* under *Deferred — larger effort* — shipping an unverified confinement
  off-macOS would be a security regression.

- **IDE / editor embedding and a terminal TUI** (VS Code/JetBrains extensions,
  remote TUI, ~32 bundled terminal themes, vim keybindings, status line, terminal
  title). Houston is a standalone GUI desktop app — it has its own themes, status
  bar, and shortcuts; a terminal UX is a different product surface. (IDE extension
  also listed under *Deferred — polish*.)

- **Record & Replay / Computer-Use skill capture.** Turning a demonstrated
  desktop workflow into a reusable skill needs OS-level computer-use automation,
  outside a coding agent's remit.

- **Enterprise / admin governance.** Org-managed controls such as forced login
  method, allowed-web-search-mode policy, server-side feature-flag toggles, and
  retention/residency enforcement assume a managed multi-tenant backend; Houston
  is single-user and local.
