# Roadmap

Houston covers a broad span of coding-agent features (see the **Features** list in
the [README](./README.md)). This file tracks the items that are intentionally
**not done yet** — either out of scope for a macOS desktop app, or a larger effort
than the current sweep covered. Each notes *why*
it's deferred and roughly *what* it would take, so nothing is silently dropped.

## Deferred — larger effort

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
  GUI), plus Tab completion of slash commands and `@`-file mentions. Themes, vim
  keybindings, and a persistent status line have since shipped in the REPL too.
  *Still deferred:* a **full-screen** TUI (alternate-buffer rendering). *Why
  deferred:* the full-screen layer means a terminal UI framework (e.g. Ink), which
  is ESM-only against a CJS main bundle, an integration that needs verifying before
  it's shipped; the current REPL covers the interactive workflow without it.

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

- **SSRF hardening: pin resolved IPs on the Electron surfaces (DNS-rebinding).**
  `web_fetch` is done: it resolves the host up front, vets every answer, and connects
  to exactly those addresses (`resolveAndPin` + `pinnedTransport` in
  `src/main/agent/webfetch.ts`), re-vetting and re-pinning on each redirect hop, so
  the address that was checked is the address that's connected to and there's no
  second resolution to poison. `view_localhost` and the live Preview panel still
  validate the URL's *host literal* only: they allow loopback, pin the top frame to
  loopback across redirects, and block subresource requests to private/LAN/metadata
  hosts (they share one guard), but a name that re-resolves between the check and the
  connect isn't caught. *Why deferred:* they run on Electron's network stack rather
  than Node's, so the pin needs different plumbing than `web_fetch`'s custom `lookup`,
  and it wants real manual testing against a live dev server. The exposure is also
  much smaller: both accept loopback only, so there's no attacker-supplied public host
  to rebind in the first place.

- **Extend untrusted-content handling past `web_fetch`.** Fetched pages are fenced,
  scored for injection signals, and isolated when they look like an attempt (see
  `src/main/agent/untrusted.ts`). The system prompt says the same rule covers file
  contents, MCP results, and other tool output, but those still arrive unfenced and
  unscored — so for them the posture remains advisory. MCP results are the sharpest
  gap: a third-party server is as attacker-controlled as a web page, and its output
  crosses the same trust boundary. *Why deferred:* the fence is cheap to apply
  anywhere, but the quarantine path needs a per-source judgment about what a "report"
  even means (a fenced JSON tool result is not prose to summarize), and blanket
  fencing of every file read would add noise to the common path for little gain,
  since the file contents mostly come from the user's own repo. Wants a per-source
  trust model rather than one flag. Two known limits of what shipped: the classifier
  is a heuristic that anyone who reads this repo can word around, and the isolated
  reader can still be induced to write a misleading report (it just has no tools to
  act with).

- **Egress-allowlist follow-ups.** The per-domain forward proxy for shell egress has
  shipped (macOS + Linux: direct sockets denied in the sandbox profile, granted network
  routed through a loopback proxy that enforces the Settings allowlist — see
  docs/sandboxing.md). What remains, deliberately deferred: **interactive per-host
  grants** (a denied destination could offer a one-click "allow this domain for the
  run" prompt instead of requiring a Settings edit — needs a mid-command consent UX
  that doesn't hang the running process); **Linux shared-loopback proxied mode**
  (proxied commands run in per-command network namespaces, so a sandboxed dev server
  isn't reachable from the Preview panel or later commands; bridging inbound loopback
  across namespaces wants a port-forwarding companion to the existing outbound
  forwarder); and **body-level masking for shell egress** (HTTPS bodies stay opaque to
  the proxy by design — only the CONNECT hostname is visible — so credential masking
  covers Houston's own network tools, not raw shell traffic).

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

- **Multi-agent orchestration beyond delegation.** Delegation itself has shipped
  in stages. Subagents come in two tiers: `dispatch_agent` (and custom
  `.houston/agents`) is read-only, while the opt-in `dispatch_writable_agent` (and
  custom agents marked `write: true`) delegates a whole task to a nested agent
  loop that can also edit files and run shell commands, all confined to the
  project. The dispatch call itself is approval-gated (a write-kind tool, blocked
  in plan mode): one consent covers the delegated task's local actions (see
  [`subagent.ts`](src/main/agent/subagent.ts)). Calls that leave that envelope
  propagate back to the user as their own approval prompts, each shown live in
  the transcript: every network request (either tier may `web_fetch`/`web_search`,
  gated per destination, mirroring the main loop's egress consent — a subagent's
  shell commands stay offline), and, on a host with no OS sandbox, each shell
  command, matching the main loop's invariant that an unconfined command never
  runs without per-command consent. On top of that, dispatches stream live
  turn-by-turn progress in every client; each subagent is resumable by id
  (`resume` sends a follow-up into its retained context); a dispatch or review can
  run on a cheaper sibling `model` (or a custom agent can pin one via
  front-matter); subagents can fan out one level of nested read-only researchers;
  `spawn_session` works on all three clients; and `schedule_run` gives
  recurring/one-time background runs. *Still deferred:* a full **orchestration
  runtime** — scripted multi-agent workflows (deterministic fan-out/join
  pipelines), named agent teams with roles, and a manager view that supervises
  many concurrent agents across sessions. *Why deferred:* those need a
  first-class run-graph model, cross-session messaging, and their own
  supervision/consent UX — a product-scale design, not an increment on the
  dispatch tools.

- **Interactive MCP elicitation, and server prompts as slash commands.** Remote
  MCP support now covers OAuth sign-in, server-initiated notifications
  (`list_changed` refreshes tools/resources/prompts live, progress keeps long
  calls alive), and prompt discovery via the `mcp_list_prompts` /
  `mcp_get_prompt` meta-tools. Two follow-ups remain. (1) *Elicitation:* when a
  server asks the user a question mid-call (`elicitation/create`), Houston
  currently declines it cleanly at the protocol level (JSON-RPC method-not-found,
  so the server never hangs and can take its no-answer path) instead of showing
  the user a prompt. Full support means declaring the capability and wiring a new
  blocking agent event through all three clients (GUI dialog, TUI prompt,
  headless auto-decline), per the client-parity rule. (2) *Prompts as commands:*
  surfacing each server prompt as a first-class `/` slash command needs menu +
  completion plumbing in both interactive clients; the meta-tools already give
  the agent the same data. *Why deferred:* both are cross-client interaction
  surfaces, not protocol work; shipping them half-wired would hang runs or drift
  the clients apart.

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

- **Landlock fallback for the Linux sandbox.** On Linux, `run_shell` is confined by
  bubblewrap; when bubblewrap is unusable (not installed, or unprivileged user
  namespaces disabled by the kernel or AppArmor) Houston falls back to running the
  command unconfined, and every such command then prompts for approval even in full
  auto. A Landlock (or seccomp) fallback would restore filesystem confinement without
  bubblewrap. *Why deferred:* Landlock is a kernel LSM reached through raw syscalls
  that Node does not expose, so it needs a small native helper and real testing across
  kernel versions; the approval prompt is a working stopgap in the meantime.

- **Cross-session memory the agent maintains itself.** The agent's durable knowledge
  of a project today is what the user writes in `AGENTS.md` / `CLAUDE.md`; within a run
  it also keeps a working-memory block, but nothing it learns in one session is carried,
  on its own, into the next. A self-maintained memory (a per-project store the agent
  writes to and that is recalled automatically) would close that. *Why deferred:* it
  needs a stable per-repo identity key (the groundwork exists in
  [`repoIdentity.ts`](src/main/agent/repoIdentity.ts) but is unused), a storage format,
  a review surface so the user can see and prune what was remembered, and a stance on
  what is allowed to persist. A real feature with a UX, not a flag.

- **More lifecycle hook events.** Hooks fire at six points today (`PreToolUse`,
  `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, `PreCompact`). Natural
  additions include `SubagentStop` (when a dispatched subagent finishes), `PostCompact`
  (after a compaction lands), and a `Notification` event (when a run is waiting on the
  user). *Why deferred:* each needs its firing point and its blocking/context-injection
  semantics pinned down (a subagent has several exit paths and no hook wiring yet; a
  post-compaction hook has no obvious place to splice returned context back in), so they
  are better designed deliberately than bolted onto the highest-churn part of the loop.

- **Permission rules that match a tool's arguments.** A rule matches a tool name plus a
  glob over one subject string (the command, path, URL, or query). For a namespaced MCP
  tool the subject is the tool name itself, so a rule can gate a whole server or tool but
  cannot say "allow this MCP tool only when a given argument has a given value".
  Argument-level matching would let a rule (or a project guardrail) target, say, one
  repository or one destination. *Why deferred:* it adds a structured matcher to the rule
  schema and the Settings editor, beyond the current single-glob model.

- **Canonicalized path and URL matching in permission rules.** Rule subjects are matched
  as raw strings with a single `*` wildcard: a path rule does not normalize `.`/`..` or
  resolve symlinks before matching, and a URL rule compares the raw URL rather than its
  parsed host, scheme, and port. So `src/*` does not cover `./src/x` or an absolute path
  to the same file, and a host rule is case- and port-sensitive. *Why deferred:*
  canonicalizing broadens what a rule matches, which is safe to widen for a `deny` rule
  but risky for an `allow` rule (it could auto-approve more than intended), so it wants a
  careful, direction-aware design rather than a blanket normalize.

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
