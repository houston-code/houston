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
  public surface. The packaging groundwork now exists — the standalone CLI
  (`npm run build:cli`, see the README) already bundles the engine without
  Electron via the userData/credentials/agentHost seams — but an SDK is an API
  commitment, not just a bundle. One-shot headless runs (`Houston -p "<prompt>"`)
  already cover scripting/CI.

- **Terminal-first TUI (interactive) — foundation shipped, polish remaining.**
  A stay-resident, interactive terminal client you converse with directly
  (`Houston -i`, see the README) — also available Electron-free as the standalone
  CLI (single-file Node bundle; runs on headless servers, ~60 MB RSS). *Shipped:*
  a line-streaming REPL over the shared
  agent core — live output, inline approvals (with a diff preview on writes and an
  unsandboxed-shell warning), `ask_user` elicitation, slash commands, a session
  cost meter, and sessions persisted as conversations (resumable, shared with the
  GUI), plus Tab completion of slash commands and `@`-file mentions. *Still
  deferred:* a **full-screen** TUI (alternate-buffer rendering with themes, vim
  keybindings, and a status line). *Why deferred:* the full-screen layer means a
  terminal UI framework (e.g. Ink), which is ESM-only against a CJS main bundle —
  an integration that needs verifying before it's shipped; the current REPL covers
  the interactive workflow without it.

- **Composer screenshot capture.** The composer's `+` attachment menu attaches
  files, a folder, the working-tree diff, a clipboard payload, and a link (and
  reuses the existing `@`-mention and image-upload flows). A "take a screenshot"
  action — capture a screen or window and attach it as an image — is not yet
  wired. *Why deferred:* needs a capture subsystem (Electron `desktopCapturer`
  plus a source picker), and the per-OS paths differ enough to need real
  cross-platform testing: macOS requires the Screen-Recording permission (TCC),
  and Wayland on Linux routes capture through the `xdg-desktop-portal` screenshot
  portal rather than a direct grab. Should feature-detect and disable the action
  where capture isn't available rather than failing silently.

- **Attach terminal output to a message.** A `+`-menu action to capture the
  integrated terminal's recent buffer as message context. *Why deferred:* the
  buffer lives in the renderer's xterm instance(s), so surfacing it to the
  composer needs a shared most-recent-output store (and a choice of which terminal
  when several are open) — cross-component plumbing beyond the current attachment
  set.

- **SSRF hardening: pin resolved IPs (DNS-rebinding).** The network-egress
  surfaces (`web_fetch`, `view_localhost`, and the live Preview panel) validate the
  URL's *host literal* — `web_fetch` blocks private/loopback/metadata IPs and
  re-checks on each redirect hop; `view_localhost` and the Preview panel allow only
  loopback, pin the top frame to loopback across redirects, and additionally block
  subresource requests to private/LAN/metadata hosts (they share one guard). A
  hostname that *resolves* to a private or metadata IP (e.g. `169.254.169.254`), or
  one that re-resolves between the check and the connect (classic DNS-rebinding), is
  not yet caught. *Why deferred:* needs resolving the host up front and pinning the
  connection to the vetted IP across redirects — different plumbing for Node's
  `fetch` (`web_fetch`) vs Electron's network stack (`view_localhost` / Preview) —
  so it's a cross-cutting change worth doing for all at once rather than per-tool.
  In practice the host-literal checks already stop the common cases.

- **Per-destination forward proxy for shell egress.** Houston's own network tools
  (`web_fetch`, `web_search`, `gh_*`) are now consented per destination, and shell
  network is gated behind a one-time per-run consent so full-auto no longer implies
  blanket egress. But once shell network is granted, a raw `curl` in `run_shell` can
  still reach any host, because the sandbox's network switch is all-or-nothing at the
  OS layer. Closing that wants routing shell egress through a loopback proxy Houston
  controls (deny direct sockets in the sandbox profile, inject `HTTP(S)_PROXY`) so
  each destination is allowlisted the same way the built-in tools are. *Why deferred:*
  a real proxy with a per-platform sandbox-profile change is a large, cross-cutting
  build, and even then HTTPS bodies stay opaque (only the CONNECT host is visible), so
  it buys per-destination control but not body-level credential masking for shell. The
  per-destination consent + egress masking shipped here bound the surface in the
  meantime.

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
  macOS is now code-signed (Developer ID) and notarized; **Windows Authenticode signing**
  is the remaining code-signing follow-up so the first-run SmartScreen warning goes away.

- **Write-capable / multi-agent delegation (write tier shipped, gaps remain).**
  Subagents now come in two tiers. `dispatch_agent` (and custom `.houston/agents`)
  stays read-only: the subagent reads/searches and reports back. The opt-in
  `dispatch_writable_agent` (and custom agents marked `write: true`) delegates a
  whole task to a nested agent loop that can also edit files and run shell
  commands, all confined to the project with no network access. The dispatch call
  itself is approval-gated (a write-kind tool, blocked in plan mode): one consent
  covers the delegated task, which the subagent then carries out autonomously
  without per-action prompts (see [`subagent.ts`](src/main/agent/subagent.ts)).
  The one exception is unconfined shell: on a host with no OS sandbox, each shell
  command the subagent runs is propagated back to the user as its own approval
  prompt with the command's run and result shown live in the transcript, matching
  the main loop's invariant that an unconfined command never runs without
  per-command consent. Streaming a nested subagent's live status was already in
  place via the `subagent` agent event. *Still deferred:* network access for
  subagents; and nested delegation (a subagent dispatching its own subagents).

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

- **Open a specific file from the diff, changes list, and tool results.** The
  project-level opener already exists — each chat's ⋯ menu has an "Open in" submenu
  that launches the chat's working directory in VS Code / Cursor / Windsurf / Zed /
  Xcode, or reveals it in the file manager. The next step is opening a *single file*
  (and ideally a line) from the surfaces that already carry it as **structured** data:
  a diff hunk, the changed-files list, an edit/write tool-result card. The path is
  known exactly, so there's no prose parsing and no false-positive risk. *What's still
  needed:* (1) the backend opens a *directory* only
  ([`openInEditor.ts`](src/main/openInEditor.ts)); a file+line open needs each
  editor's goto syntax, which only the **CLI** carries (`code -g file:line`, `zed
  file:line:col`, Xcode `xed --line`). That's in tension with the current macOS launch
  strategy, which deliberately prefers `open -a <app>` (resolve by app name via
  LaunchServices) over a bare `code` on PATH — a VS Code fork's shim can shadow it —
  and `open -a` can't pass a line. So line-accurate opens want a careful per-editor
  path (the CLI when it's unambiguously the right editor, or a URL scheme), not the
  project opener reused as-is. (2) A single click needs a *default* editor to open
  into — there's no room to pick one per click, unlike the submenu — so a
  preferred-editor setting returns with it.

- **Linkify file paths in transcript prose.** Turn `path:line` references inside the
  agent's free-form replies into clickable links, reusing the file opener above.
  *Why still deferred:* it needs reliable path-detection in prose to avoid linkifying
  things that merely look like paths, plus changes to the actively-evolving Markdown
  renderer ([`Markdown.tsx`](src/renderer/src/components/Markdown.tsx)) — the
  genuinely hard part, and separable from the structured-surface opens above.

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

- **Integrated-terminal enhancements.** The in-app terminal ships today as a
  resizable, multi-tab panel of full PTY sessions (interactive programs, colours,
  resize), window-global with each tab's working directory captured at creation.
  Four follow-ups remain deferred:
  - **Per-conversation terminals.** Bind terminal tabs to the active conversation
    (and its worktree) instead of sharing one window-global set. *Why deferred:*
    needs a per-conversation session model and lifecycle (spawn/teardown on chat
    switch, or keep-alive policy) — more than a tweak to the current global registry.
  - **Scrollback persistence across restarts.** Today a tab's scrollback lives only
    in its xterm instance and is lost when the app quits. *Why deferred:* a PTY has
    no history of its own, so this needs a persisted per-tab output buffer with a
    size cap and a rehydration path on launch.
  - **Split panes.** More than one terminal visible at once within the panel. *Why
    deferred:* a real layout/focus model (split tree, resizers, active-pane routing)
    on top of the existing single-active-tab view.
  - **Shell-integration cwd tracking.** Follow the shell's working directory live
    (e.g. OSC 7 / prompt markers) so the tab label and new-tab cwd track where the
    user has `cd`'d. *Why deferred:* needs an escape-sequence handler and shell-side
    integration, and degrades unevenly across shells.

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
