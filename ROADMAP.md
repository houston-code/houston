# Roadmap

Houston covers a broad span of coding-agent features (see the **Features** list in
the [README](./README.md)). This file tracks the items that are intentionally
**not done yet** — either out of scope for a macOS desktop app, or a larger effort
than the current sweep covered. Each notes *why*
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

- **Terminal-first TUI (interactive).** A stay-resident, interactive terminal
  client you converse with directly — streaming output, in-terminal approvals /
  elicitation, keybindings (incl. vim), status line, and themes — as opposed to the
  existing *non-interactive* one-shot headless CLI (`Houston -p "<prompt>"`, see the
  README). *Why deferred:* it's a second client surface on top of the existing agent
  core — the agent engine and headless plumbing already exist to back it, but it
  needs a terminal renderer, an input/keybinding layer, and an in-terminal
  approval/elicitation UX. A terminal UX is a distinct product surface from the GUI.

- **SSRF hardening: pin resolved IPs (DNS-rebinding).** The network-egress tools
  (`web_fetch`, `view_localhost`) validate the URL's *host literal* — `web_fetch`
  blocks private/loopback/metadata IPs and re-checks on each redirect hop;
  `view_localhost` allows only loopback and additionally blocks subresource
  requests to private/LAN/metadata hosts. A hostname that *resolves* to a private
  or metadata IP (e.g. `169.254.169.254`), or one that re-resolves between the
  check and the connect (classic DNS-rebinding), is not yet caught. *Why deferred:*
  needs resolving the host up front and pinning the connection to the vetted IP
  across redirects — different plumbing for Node's `fetch` (`web_fetch`) vs
  Electron's network stack (`view_localhost`) — so it's a cross-cutting change
  worth doing for both at once rather than per-tool. In practice the host-literal
  checks already stop the common cases.

- **Mid-run resume after a crash/restart.** Re-enter an interrupted tool loop
  exactly where it stopped. *Why deferred:* conversations already persist
  incrementally and you can continue by sending a new message; true auto-resume
  of an in-flight run needs persisted run state and a reconnect state machine.

- **Parallel execution for write/shell tools.** Today only all-read turns run
  concurrently. *Why deferred:* concurrent writes/commands need conflict handling
  and a concurrent (rather than sequential) approval UI.

- **Additional build targets.** The cross-platform execution backends and builds have
  shipped (macOS Seatbelt, Linux bubblewrap, Windows — see the README). The remaining
  gap is *more arches/installers*, each of which just needs its own CI runner: x64
  (Intel) macOS, arm64 Windows (`windows-11-arm`), arm64 Linux, and an `.rpm` target.
  Code-signing (Windows Authenticode, macOS Developer ID + notarization) is the other
  follow-up so first-run SmartScreen/Gatekeeper warnings go away.

- **Write-capable / multi-agent delegation.** Today `dispatch_agent` (and custom
  `.houston/agents`) are deliberately **read-only** — a subagent can read/search
  and report back, but can't edit, run commands, or use the network. Letting a
  subagent *act* would still need a nested agent loop with its own tool budget and
  approval propagation back to the UI. (Streaming a nested subagent's live status
  is already in place: `review_changes` surfaces each per-dimension reviewer and
  the verification pass as their own live rows under the tool, via the `subagent`
  agent event.) *Why deferred:* write capability is a larger architecture change
  *and* a safety-surface expansion (an autonomous sub-loop taking write/shell
  actions) that deserves its own design + consent UX rather than being bolted on.
  Read-only delegation already covers the common "investigate without polluting my
  context" case.

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
  key, which cuts against bring-your-own-model and the privacy stance
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
  agent's replies so a click opens the file. The open-in-editor plumbing now exists
  (each chat's ⋯ menu has an "Open in" submenu that launches the chat's working
  directory in VS Code / Cursor / Windsurf / Zed / Xcode, or reveals it in the file
  manager), so the remaining work is per-file/line opens from the transcript. *Why
  still deferred:* doing it well needs reliable path-detection in prose (to avoid
  false positives) and changes to the actively-evolving Markdown / tool-row
  renderers — more than a polish pass.

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
  user-configured shell command, beyond the built-in
  live-activity status bar.

- **Tool-result image thumbnails.** When the agent `read_file`s an image, the
  model sees it but the transcript shows a text marker; render a thumbnail in the
  tool card too.

- **IDE integration.** VS Code / JetBrains extensions. Out of scope for a
  standalone desktop app, but listed for completeness.

- **More gh-backed GitHub tools (merge, review, lifecycle).** The shipped gh
  tools cover PRs (create/list/view/comment/checkout/checks), issues
  (list/view/create/comment), CI runs (list/view), and repo creation. Three
  deliberately-deferred additions remain — all *in scope* (gh-driven,
  `kind:'network'` behind the approval gate), just not built yet:
  - **`gh_pr_merge`.** Merge a pull request. *Why deferred:* it's the riskiest
    mutating GitHub op and clashes with a label-gated **auto-merge CI** workflow,
    where CI — not the agent — merges once checks pass (and a direct
    `gh pr merge` silently bypasses that gate on repos without enforced branch
    protection). Doing it safely wants an explicit confirm, a merge-method choice
    (merge/squash/rebase), and a required-checks guard — more than a thin wrapper.
  - **`gh_pr_review` (approve / request-changes / comment).** Submit a *formal*
    PR review verdict. *Why deferred:* an agent recording an `approve` is a
    trust-sensitive action distinct from a plain comment (which `gh_pr_comment`
    already covers), and it deserves a UX that makes the verdict explicit rather
    than being mistaken for a normal comment.
  - **PR / issue lifecycle (`close` / `reopen` / mark-ready).** *Why deferred:*
    low marginal value over the existing create/comment tools; each is a quick
    add when a real workflow needs it, so they're bundled here rather than shipped
    piecemeal.

## Out of scope — non-goals

These are capabilities that conflict with Houston's **bring-your-own-model**
stance or require a hosted backend. They're
deliberately **not** on the roadmap (recorded here so the gap analysis is honest
and nothing is silently dropped):

- **Subscription / OAuth sign-in (ChatGPT, Claude Pro/Max, GitHub Copilot).**
  Houston is **bring-your-own-API-key** by design — keys are stored in the macOS
  Keychain and used directly. Subscription sign-in (vendor OAuth, included usage,
  workspace RBAC) is a different account / billing model that doesn't fit a
  BYO-key local app.

- **Cloud task delegation** (parallel/best-of-N attempts, isolated cloud
  sandboxes, applying cloud-computed diffs). Requires a hosted execution backend
  and account; Houston runs entirely on the user's machine.

- **Hosted GitHub bot / "install GitHub app".** A *server-side* PR-creating bot,
  hosted code review that runs on GitHub's infrastructure, or an "install GitHub
  app" OAuth flow. *What ships instead:* first-class pull-request tools
  (`gh_pr_create` / `gh_pr_list` / `gh_pr_view` / `gh_pr_comment` /
  `gh_pr_checkout` / `gh_pr_checks`), issue tools (`gh_issue_list` /
  `gh_issue_view` / `gh_issue_create` / `gh_issue_comment`), CI-run tools
  (`gh_run_list` / `gh_run_view`), `gh_repo_create` for new repositories, and the
  `pr_sweep` board (batch-author PRs from tasks, or
  process a batch of existing PRs), all driving the user's local `gh` CLI — no
  hosted backend, no app-level token storage (`gh` owns auth), which keeps
  Houston entirely on the user's machine. The remaining non-goal is specifically the
  *hosted* bot/app side, which needs a multi-tenant backend and an OAuth app
  registration that don't fit a single-user desktop app.

- **IDE / editor embedding** (VS Code/JetBrains extensions). Houston is a
  standalone GUI desktop app — it has its own themes, status bar, and shortcuts; an
  editor-embedded surface is a different product. (IDE extension also listed under
  *Deferred — polish*.)

- **Record & Replay / Computer-Use skill capture.** Turning a demonstrated
  desktop workflow into a reusable skill needs OS-level computer-use automation,
  outside a coding agent's remit.

- **Enterprise / admin governance.** Org-managed controls such as forced login
  method, allowed-web-search-mode policy, server-side feature-flag toggles, and
  retention/residency enforcement assume a managed multi-tenant backend; Houston
  is single-user and local.
