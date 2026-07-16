# Houston

A **cross-platform coding agent** — **bring your own model**. Point it at Claude, GPT,
Gemini, any OpenAI-compatible API, or a local model (Ollama / LM Studio), give it
a project folder, and let it read, edit, search, and run code — every action gated
by an approval flow and, where the OS supports it, confined to a sandbox.

Built with Electron + React + TypeScript. Runs on macOS 12 Monterey or newer
(Apple Silicon and Intel), Windows 10 or newer (x64), and Linux x64 (glibc 2.35+).

![Houston icon](build/icon.png)

## Features

- **Any model, your keys.** Anthropic (Claude), OpenAI (GPT), Google (Gemini),
  any OpenAI-compatible endpoint, and local models via Ollama or LM Studio. Add a
  known host (OpenRouter, Together, Fireworks, Groq, and more) in one click, point
  at any custom endpoint, and fetch live model lists in Settings. The model picker
  shows each model's context window and capability badges (tool calling, vision,
  reasoning) — read live from the host where it advertises them, so it warns before
  you pick a model that can't call tools.
- **Image attachments.** Drag-drop or paste images (PNG/JPEG/GIF/WebP) into the
  composer to send them to a vision-capable model — screenshots, diagrams,
  mockups. The affordance is offered only when the selected model supports
  vision. Thumbnails show inline and the images persist with the conversation.
  The agent can also `read_file` an image or PDF in the project and view it
  directly — and images a tool produces (a `read_file` image, a `view_localhost`
  screenshot) reach any vision-capable model, on Anthropic, OpenAI, and Gemini
  alike. (PDFs are Anthropic-only; elsewhere they fall back to a text placeholder.)
- **Agentic tool use.** The agent can `read_file`, `write_file`, `edit_file`,
  `multi_edit`, `apply_patch`, `list_dir`, `glob`, `search_files`, `ast_grep`,
  `run_shell`, `git_status`, `git_diff`, `web_fetch`, `web_search`,
  `gh_pr_*` (pull requests), `todo_write`, `pr_sweep`, and `ask_user` to actually
  do the work — not just describe it. When a turn is all
  reads (e.g. open five files at once), they run **concurrently**; anything that
  writes, runs a command, or needs approval stays sequential. Edits are matched
  **resiliently** — if the model's snippet drifts from the file by indentation or
  whitespace, Houston still locates and applies it instead of failing.
  `search_files` ships with a bundled **ripgrep**, so fast content search works
  out of the box without anything installed on your PATH (it falls back to a
  built-in scan if the binary is ever unavailable).
- **Structural code search.** `ast_grep` matches code by its **syntax tree**
  rather than text, using a bundled [ast-grep](https://ast-grep.github.io)
  binary. Meta-variables make it precise — `console.log($A)`,
  `function $F($$$) { $$$ }`, `useEffect($CB, [])` — so the agent can find
  calls, declarations, and JSX without the false positives of a regex. Pass the
  language (`ts`, `tsx`, `py`, `rust`, …).
- **Web search.** Pick a search provider and supply its API key (Settings →
  *Web search*) and the agent can `web_search` the web for current information.
  Like `web_fetch`, it requires approval since it leaves the machine.
- **See its own localhost.** After starting a dev server (a background
  `run_shell`), the agent can `view_localhost` to load the page in an offscreen
  Electron window, screenshot it, and read back the browser console — closing the
  build → look → fix loop without a human eyeballing the page. The screenshot
  comes back through the same vision pipeline as pasted images, so a
  vision-capable model views it directly, and it shows inline in the transcript.
  Only loopback hosts (`localhost`, `127.0.0.1`, `::1`) are allowed — public URLs
  go through `web_fetch` — and, being local network egress, it always prompts for
  approval like `web_fetch`. Pass a `selector` to capture just one element.
- **Live preview panel.** When the agent starts a dev server (a background
  `run_shell`), Houston detects the loopback URL it prints and offers a **Preview**
  panel — a resizable right-hand dock that renders the running page live and
  interactively, right beside the chat. Multiple servers stack top-to-bottom (up to
  three), each with reload and open-in-browser controls; you can also add a
  `localhost` URL or port by hand. The pages render in isolated, sandboxed,
  loopback-pinned views with the same network guards as `view_localhost`, so
  untrusted dev-server output can't reach your network.
- **@-mention files.** Type `@` in the composer to fuzzy-search project files and
  drop a path into your message — no need to paste or describe where things live.
- **Slash commands.** Type `/` for a command menu. Built-ins: `/new` (new chat),
  `/compact` (summarize older turns to free up context now), `/plan` `/ask`
  `/auto` `/full` (switch approval mode), `/review` (adversarial review), `/help`.
  Any Markdown file in `.houston/commands/` becomes a custom command — its
  contents are a prompt template (`$ARGUMENTS` is filled in with whatever you type
  after the command name).
- **Queue follow-ups while it works.** Keep typing while a run is in progress and
  your message is queued instead of interrupting it — the **Stop** button is joined
  by **Queue**. Line up as many as you like (a bar above the composer lists them,
  and you can drop any or clear them all); when the turn finishes they're combined
  into one next message and sent automatically. The queue is per-chat and lives in
  the background, so a follow-up still fires when its chat's run finishes even after
  you've switched to another conversation. If the turn fails or you stop it, the
  queue is held — retry (or send) it deliberately rather than firing onto a broken
  turn.
- **Subagent delegation.** The agent can `dispatch_agent` to hand a focused,
  read-only question to a subagent with its own fresh context: it reads, globs,
  and searches the project and reports back, keeping the main agent's context
  clean. `dispatch_writable_agent` delegates a whole implementation task to a
  subagent that can also edit files and run shell commands, confined to the
  project with no network access; that dispatch is approval-gated, so one consent
  covers the delegated task. On a host without an OS-enforced sandbox, each shell
  command the subagent runs would be unconfined, so it is routed back to you as
  its own approval prompt (and shown in the transcript), exactly like an
  unconfined command from the main agent. Tokens a subagent spends roll into the
  conversation's usage meter.
- **Spawn separate sessions.** Where a subagent reports back into the current turn,
  `spawn_session` spins off a *separate* chat: the agent hands it a task, optionally
  on its own git branch and worktree, and sets it running autonomously in the
  background. It appears in the sidebar with a live running indicator, seeded with
  the handed-off context as its first message — open it to watch, answer an
  approval, or take over. The spawned session inherits your current approval policy,
  so it is never more permissive than the chat that spawned it. Use it to run
  independent work in parallel without leaving your current chat.
- **Adversarial review.** `review_changes` (or `/review`) reviews your uncommitted
  changes for correctness, security, and quality. It runs an independent read-only
  reviewer per dimension — each in its own fresh context, so they don't inherit the
  author's blind spots — then a skeptical verifier that re-checks every candidate
  finding against the real code and drops the false positives, and reports the
  confirmed ones. The agent can self-review after a substantial change before
  telling you it's done. Review the whole diff, a different `base` (e.g. a branch),
  or scope it to specific `paths`; raise `effort` to `high` to verify each finding
  with several independent skeptics (majority-confirmed) for high-stakes changes.
  Large diffs are split by file across reviewers, so nothing is skipped. The
  review streams its progress live (which reviewer/verifier is running), and the
  tokens its nested reviewers spend roll into the conversation's usage meter, so a
  multi-agent review isn't a silent black box.
- **Custom agents & skills.** Drop a Markdown file in `.houston/agents/` to define
  a specialized subagent (front-matter `description` + a system-prompt body); the
  main agent can dispatch it by name. Agents are read-only by default; mark one
  `write: true` to make it dispatchable via the approval-gated
  `dispatch_writable_agent`. An optional front-matter `tools:` list narrows which
  tools that agent may use (it can only restrict its tier's set, never widen
  it, and never grants network access). Add a `.houston/skills/<name>/SKILL.md`
  to register a skill: its description is surfaced to the agent, which reads the
  full instructions on demand.
- **Explains itself.** Ask how Houston works (its slash commands, approval modes,
  hooks, MCP servers, skills, sandboxing, and more) and the agent answers from a
  built-in guide instead of guessing. The guide lives in
  [docs/houston-guide.md](docs/houston-guide.md) and ships as a built-in
  `houston-guide` skill, so Houston's self-knowledge stays accurate as features
  change.
- **MCP servers.** Connect Model Context Protocol servers in Settings — a local
  **stdio** process (with optional working directory and encrypted env vars) or a
  remote **HTTP** (streamable) or **SSE** endpoint. Remote servers authenticate
  with a static bearer-token / custom header, or with **OAuth** for hosted
  services that require a sign-in: Houston discovers the authorization server,
  registers itself as a client, opens the browser to authorize, and stores +
  auto-refreshes the tokens (Settings *Sign in*, or `/mcp login` in the
  terminal). Their tools are offered to the agent namespaced as
  `mcp__<id>__<tool>` and always require approval; servers exposing MCP
  resources or prompt templates get discovery meta-tools, list changes are
  picked up live, and oversized results are capped. Point Houston at the
  filesystem, git, a hosted MCP service, or any other server to extend what the
  agent can do. When a lot of MCP
  tools are connected, Houston **loads their schemas lazily**: above a threshold
  the agent gets a compact catalog plus a `find_tools` meta-tool and pulls in only
  the tool definitions it needs, instead of paying to send every schema on every
  request (which matters when you bring your own metered API key).
- **Task list.** For multi-step work the agent keeps a `todo_write` scratchpad,
  rendered live as a checklist in the transcript so you can see the plan and
  watch it tick off items.
- **Desktop notifications.** Wander off during a long turn — Houston fires a
  native notification when the agent finishes, needs approval, asks a question, or
  opens/merges a pull request while the window isn't focused, and clicking it
  brings the app back. PR events also show inline in the transcript: a notice
  banner when `gh_pr_create` opens a PR and when a `gh_pr_view` shows it merged.
  On by default; toggle it in Settings → *Appearance*.
- **Rich transcript.** Replies render as full **Markdown** — headings, lists,
  tables, blockquotes, and syntax-styled code blocks with one-click copy. Tool
  activity collapses into a compact, grouped list (one tidy row per call,
  expandable for output and diffs) instead of a wall of cards.
- **Sandboxed execution (per-platform, honest).** Shell commands run under the host's
  OS sandbox where one exists, confined to the project directory — writes outside the
  project and (by default) network access are blocked. On **macOS** that's **Seatbelt**
  (`sandbox-exec`); on **Linux** it's **bubblewrap** (an unprivileged user namespace),
  when available. **Windows** has no broadly-available equivalent, so shell commands run
  unconfined — and the app says so: the command is reported as not sandboxed and is never
  silently auto-approved (you must explicitly allow each one, even in full-auto). The
  structured file tools stay confined to the project on every platform. See
  [docs/sandboxing.md](docs/sandboxing.md) for the per-platform model and why
  AppContainer / Windows Sandbox aren't a fit for confining arbitrary build commands.
- **Background processes.** `run_shell` can start long-running commands (dev
  servers, watchers) in the background and return immediately; the agent polls
  them with `read_shell_output` and stops them with `kill_shell`. They're killed
  when the app quits.
- **Persistent shell session.** Foreground `run_shell` commands share a session
  within a turn: `cd` and exported environment variables carry over to later
  commands (e.g. `cd build` then `make`, or activate a virtualenv once and reuse
  it), so the agent gets "same terminal" behavior.
- **Headless mode.** Run one prompt without the GUI and stream the result to
  stdout — `Houston -p "<prompt>"` (read-only by default; add `--full-auto` to let
  it edit/run, `--json` for machine-readable events). Good for scripts and CI.
  See [Headless / scripting](#headless--scripting).
- **Interactive terminal.** A stay-resident REPL in your terminal — `Houston -i`.
  Conversation streams live, tool approvals and questions are answered inline, and
  slash commands (`/model`, `/approval`, `/clear`, …) switch settings mid-session.
  See [Interactive terminal](#interactive-terminal).
- **Standalone CLI.** The same `-p` and `-i` clients as a single-file Node script —
  no desktop app, no Chromium, no display server, ~60 MB of RAM instead of a
  desktop app's footprint. Runs on headless Linux servers and small VPSes; API
  keys come from environment variables. See [Standalone CLI](#standalone-cli-no-desktop-app).
- **Approval flow.** Choose how much autonomy to grant: *plan mode* (read-only —
  the agent researches and proposes a plan, with writes and shell commands
  blocked), *ask every time*, *auto-approve edits*, or *full auto*. On each tool
  call you can approve once, deny, *allow for the run* (auto-approves that kind of
  tool for the rest of the conversation), or *always allow* / *always deny* — which
  saves a permission rule so the choice sticks across future runs. File edits show
  an inline red/green **diff** so you can review exactly what changes before
  approving.
- **Project guardrails.** A repo can ship a `.houston/settings.json` with its own
  *deny* / *ask* permission rules (checked before your global ones) — e.g. always
  ask before touching `infra/**`. For safety a project file can only *tighten*:
  `allow` rules, hooks, and MCP servers stay in your own global Settings, so
  cloning an untrusted repo can't auto-approve actions or run commands.
- **Managed policy (admin-locked).** On a managed device an administrator can ship a
  machine-wide `managed-settings.json` (macOS `/Library/Application Support/Houston/`,
  Windows `%PROGRAMDATA%\Houston\`, Linux `/etc/houston/`) with *deny* / *ask*
  permission rules that outrank both project guardrails and every user's own rules.
  Like a project file it can only *tighten*, so a policy can enforce (for example)
  denying every `run_shell` that matches `*rm -rf*` for everyone on the machine,
  never auto-approve anything. It lives in a root-owned location a normal user cannot
  edit, and Houston reads that fixed path with no override, so the lock holds.
  Distribute it however you manage devices (MDM, a provisioning script, config
  management). A blocked call tells the user the reason was their organization's
  policy.
- **Permission rules.** Beyond the coarse policy, add fine-grained
  *allow* / *deny* / *ask* rules in Settings, matched on the tool and a glob over
  its target (e.g. allow `run_shell` matching `git *`, deny anything matching
  `*rm -rf*`, always ask before `write_file` under `src/secret/**`). Rules are
  checked before the policy; first match wins.
- **Hooks.** Run your own shell commands around tool calls (Settings → *Hooks*):
  a *PreToolUse* hook can block a call by exiting non-zero, and a *PostToolUse*
  hook's output is fed back to the agent — e.g. auto-format after every edit, or
  run tests after a write. Hooks run sandboxed to the project; the call's context
  is in `$HOUSTON_TOOL_NAME` / `$HOUSTON_TOOL_INPUT`.
- **Plugins.** Drop a JS file in `.houston/plugins/` to register *observational*
  lifecycle hooks — `houston.on('onToolStart' | 'onToolResult' | 'onUserMessage',
  fn)` — for logging, metrics, or notifications. Plugins are local trusted files
  (the same trust model as hooks/agents/skills): each runs in an isolated context
  with no `require`/`process`/network, hooks can't block or alter a call, and a
  throwing or slow plugin is caught and ignored. To *block* a tool, use a
  *PreToolUse* shell hook instead.
- **Format on save (optional).** Turn on *Format on save* (Settings → *Tools &
  Permissions*) and Houston runs the matching formatter on each file the agent writes —
  Prettier for JS/TS/JSON/CSS/Markdown, `gofmt`, `rustfmt`, and `ruff`/`black` for
  Python. The formatters are **optional, not bundled**: install the ones you want on
  your `PATH` and Houston uses them when present (it silently skips a file when its
  formatter is missing). Settings → *Tools & Permissions* → *Optional integrations*
  shows which it detects. Runs in the same sandbox as `run_shell` (no network); off by
  default.
- **Undo / redo a turn's file changes.** Houston snapshots each file before and
  after the agent writes it, so when a turn edits files a **Revert** button appears —
  one click restores everything that turn changed (and deletes files it created).
  Changed your mind? **Redo** puts the changes back.
- **Status bar.** A slim bar along the bottom shows what the agent is doing right
  now (Ready / Responding… / Running a tool / Awaiting approval) and the active
  model.
- **Keyboard shortcuts.** A ⌘K command palette, ⌘N new chat, ⌘1–9 / ⌃Tab to switch
  chats, Shift+Tab to cycle approval mode, ⌘F find-in-conversation, ⌘⇧M to switch
  model, ↑/↓ to recall earlier prompts, Esc Esc to edit your last message, and Esc
  to stop a running turn. Press ⌘/ (or ?) for the full list; rebind any of them
  under Settings → Keyboard.
- **Accessible.** The Settings dialog is a proper focus-trapped `dialog` (focus
  moves in on open and restores on close, Tab stays inside, Esc closes), and all
  animations honor the OS *reduce motion* setting.
- **Light & dark themes.** Pick *System*, *Dark*, or *Light* in Settings →
  *Appearance*; *System* follows your macOS appearance and switches live.
- **Resilient streaming.** Transient provider failures (rate limits, overloads,
  dropped connections) are retried with exponential backoff — shown inline as a
  "retrying…" notice — as long as nothing has streamed yet, so a blip mid-run no
  longer throws the whole turn away. If a turn still fails, a **Retry** button
  re-runs it without you re-typing.
- **Secure key storage.** API keys are encrypted with the macOS Keychain
  (Electron `safeStorage`) and never leave the main process or touch the renderer.
- **Persistent conversations**, scoped per project folder. Export any chat to a
  JSON file and import it back (or onto another machine) from the sidebar, or
  export it as a self-contained HTML file for sharing and reading offline.
  **Search** the sidebar to find a past chat by its title or anything said in it.
  **Fork** a chat from its ⋯ menu to branch off a copy and explore a different
  direction without disturbing the original.
- **Auto-named chats.** A new chat shows the first message as a placeholder, then —
  once the first turn finishes — the conversation's own model writes a short,
  specific title to replace it (the new title appears in the sidebar live). Renaming
  a chat yourself always wins; auto-titling never overwrites a title you set.
- **Organize the sidebar.** Pin important chats to a "Pinned" section, and file
  the rest into your own named, collapsible groups via each chat's ⋯ menu. Pins
  and groups persist across restarts. **Resize** the sidebar by dragging its right
  edge (double-click to reset), or **collapse** it to a thin rail with the ⌘B
  shortcut or the « toggle — the chosen width and collapsed state are remembered.
- **Long sessions stay in budget.** When a conversation grows past a configurable
  token threshold, Houston automatically summarizes the older turns so it never
  overflows the model's context window. The full transcript stays on screen —
  only what's sent to the model is compacted. Tune or disable the threshold in
  Settings → *Context window*.
- **Multiple folders.** Beyond the project folder, add extra directories in
  Settings → *Additional folders* that the agent may read and write; they're
  added to the file tools' allowed roots and the shell sandbox so it can work
  across more than one repo at once.
- **Git-aware.** If the project is a git repo, Houston folds the current branch
  and a short working-tree status into the agent's context each turn, so it knows
  what branch it's on and what's already modified without having to run git first.
- **Changes panel.** The **⤓ Changes** button in the title bar opens a slide-over
  diff of every uncommitted change in the working tree — the tracked diff vs HEAD
  (staged and unstaged) plus untracked files — each file expandable with a
  red/green line diff and a `+/−` stat. It's working-tree scoped (all uncommitted
  changes, not just the current chat's edits); read-only and hardened, the same
  way the agent's `git_diff` tool is. A **Create PR** action hands off to the
  agent — it commits, pushes, and opens the pull request through the same
  `gh_pr_*` tools and approval gate, so the panel never drives git itself. It
  opens an independent PR against the default branch, or — when the current branch
  already has an open PR — stacks the new one on top (based on that PR's branch) so
  its diff shows only the new changes. Whenever the working tree has changes, the
  same **Create PR** action (and a clickable `N changed files +/−` summary that
  opens the panel) also sits at the top of the composer, so it's one click away
  without opening the panel first.
- **Start a chat in its own worktree.** Every new chat in a git repo defaults to
  running in a fresh, isolated worktree on its own branch — so the agent's edits
  never touch your current checkout. Right after the folder picker in the control
  bar you choose the base branch to fork from and name the new branch (or untick
  *New worktree* to work in the repo directly); picking a subdirectory of a repo
  keeps the chat scoped to that folder instead (the toggle defaults off there).
  The worktree is created on your
  first message, under `.houston/worktrees/` and kept out of the parent repo's
  `git status` via `.git/info/exclude`. Deleting the chat offers to remove the
  worktree too (uncommitted or unmerged work is always kept).
- **GitHub repos, PRs, issues & CI (first-class).** The [`gh` CLI](https://cli.github.com)
  is an **optional, not-bundled** integration — without it these tools simply aren't
  offered and everything else works. When it's installed and authenticated
  (`gh auth login`), Houston gets dedicated tools for the whole GitHub loop:
  - **Pull requests** — `gh_pr_create`, `gh_pr_list`, `gh_pr_view` (with diff),
    `gh_pr_comment`, `gh_pr_checkout`, and `gh_pr_checks` (CI status rollup).
  - **Issues** — `gh_issue_list`, `gh_issue_view` (with comments),
    `gh_issue_create`, and `gh_issue_comment`.
  - **CI runs** — `gh_run_list` and `gh_run_view` (set `log_failed` to read just
    the failed steps' logs — the quickest way to diagnose a red build).
  - **Repositories** — `gh_repo_create` (private by default, made from the
    current project directory and pushed).

  It drives your local `gh`, so no token is stored
  in the app and `gh` owns the credentials. Each call is **network**-gated
  (always prompts for approval) and the mutating ones (PR/issue create & comment,
  PR checkout, repo create) are refused in plan mode. Because these tools run
  `gh` *outside* the shell sandbox, they reach the network on approval — unlike a
  raw `gh` in `run_shell`, which the sandbox blocks from the network unless the
  run is full-auto or you pick "Allow for run." Houston tells the agent in its
  system prompt when `gh` is available, so it reaches for these instead of raw
  shell `gh`. Settings → *Tools & Permissions* → *Optional integrations* shows whether
  `gh` is detected and signed in, with a one-line hint on how to enable it.
- **PR sweeps.** For batch pull-request work the agent keeps a `pr_sweep` board —
  the same scratchpad idea as the task list, specialized per PR — rendered live in
  the transcript with each item's status, branch, and PR link. Two modes:
  **author** (turn a list of tasks into PRs: branch → change → push → open) and
  **process** (work a batch of existing open PRs: check out → review/fix →
  update). It tracks the plan; the real work happens through the `gh_pr_*`,
  worktree, and file tools. Like the task list, the board lives in the
  conversation — it's recorded as tool use in the message log, so it persists with
  the chat and needs no separate store.
- **Project-aware.** Houston loads a small rules hierarchy into the system prompt —
  your global `~/.claude/CLAUDE.md` first, then the project's own `AGENTS.md` /
  `CLAUDE.md` at its root, then any `AGENTS.md` / `CLAUDE.md` found in
  subdirectories (so per-package conventions in a monorepo are picked up
  automatically, shallowest first) — so the agent follows your conventions,
  build/test commands, and house rules without you re-explaining them each time.
  Any rules file can also pull in others with `@path` imports (relative, `~/…`, or
  absolute), to split or share common rules across files.
- **Token usage & cost at a glance.** The control bar above the composer shows the
  current context size, the output tokens used this session, and an **estimated
  USD cost** (for models with known pricing — Claude/GPT/Gemini; local models show
  none), so you can see how big and how expensive a conversation is getting. The
  model, project folder, approval policy and thinking controls live there too —
  down by the composer, where you're typing.

## Install (prebuilt binaries)

Grab the artifact for your platform:

| Platform | Minimum OS | Download | Update notifications? |
|----------|------------|----------|-----------------------|
| macOS (Apple Silicon) | macOS 12 Monterey | `Houston-<version>-arm64.dmg` — open it, drag **Houston** to Applications | Yes (via the `.zip` feed) |
| macOS (Intel) | macOS 12 Monterey | `Houston-<version>-x64.dmg` — open it, drag **Houston** to Applications | Yes (via the `.zip` feed) |
| Windows (x64) | Windows 10 | `Houston-<version>-x64-setup.exe` — run the installer (per-user, no admin) | Yes |
| Linux (x64) | glibc 2.35+ (Ubuntu 22.04+ / Debian 12+ / Fedora 36+) | `Houston-<version>-x64.AppImage` — `chmod +x` and run | Yes (AppImage only) |
| Linux (x64) | glibc 2.35+ (Ubuntu 22.04+ / Debian 12+ / Fedora 36+) | `Houston-<version>-x64.deb` — `sudo apt install ./…deb` | **No** — update via your package manager or re-download |
| Any (terminal only) | Node ≥ 22 | `houston-cli.cjs` — the [standalone CLI](#standalone-cli-no-desktop-app): `node houston-cli.cjs -i`, or put it on your PATH as `houston` | **No** — re-download to update |

> **macOS builds are signed and notarized**, so they open with no Gatekeeper warning
> and update in place. **Windows and Linux builds are unsigned** for now:
> - **Windows**: SmartScreen warns until the installer is signed with an Authenticode
>   cert. Click **More info** → **Run anyway**.
> - **Linux**: AppImage/deb are unsigned (conventional).
>
> **Only macOS auto-downloads and installs updates** (its signature is verifiable). On
> Windows and Linux, "Yes" above means the app checks the update feed and shows a banner
> linking to **Releases** for a manual download, until those platforms are signed too.
> See [Updates](#updates).
>
> **Linux needs glibc 2.35 or newer** (Ubuntu 22.04+, Debian 12+, Fedora 36+) — **for the
> desktop app.** The floor is set by the build toolchain: the native `node-pty` addon is
> compiled on Ubuntu 22.04 (glibc 2.35), and the bundled `ast-grep`/`ripgrep` are glibc
> builds — so musl distros (Alpine) can't run the desktop packages. The runner is pinned so
> this floor stays put rather than creeping up with newer CI images. **The standalone CLI is
> exempt:** it's a pure-JS bundle with no native addon and no bundled binaries, so it runs
> on any platform with Node ≥ 22, Alpine/musl included.
>
> **Both mac arches update from one feed.** arm64 and Intel build on separate
> runners, and electron-builder emits one `latest-mac.yml` per build — naively publishing
> both would clobber one another ([electron-builder#5592](https://github.com/electron-userland/electron-builder/issues/5592)).
> So the release pipeline merges the x64 files into the arm64 feed
> ([`scripts/merge-mac-update-yml.mjs`](scripts/merge-mac-update-yml.mjs)) and publishes a
> single `latest-mac.yml`; the updater picks the entry matching each Mac's architecture.
>
> For how the macOS signing + notarization pipeline works, see [Signing & notarization](#signing--notarization).

## First run

1. On first launch Houston shows a one-time notice and asks you to accept the
   [Terms of Use](docs/TERMS.md), [Privacy Policy](docs/PRIVACY.md), and
   [License](LICENSE) before you can use it.
2. Open **Settings** (sidebar) and set an API key for at least one provider
   (or point a local endpoint at Ollama/LM Studio — no key needed).
3. Pick a **project folder** (control bar, above the composer).
4. Choose a **model** and an **approval policy** (same control bar).
5. Ask it to build or change something.

## Headless / scripting

Run a single prompt without opening the window — useful for scripts, pipelines,
and CI. Pass `-p`/`--prompt` to the app binary:

```bash
# first headless use on a profile: accept the terms once (recorded for later runs)
Houston -p "Summarize the architecture" --cwd ~/code/myproj --accept-terms

# read-only by default (plan mode): analysis / Q&A, no edits or commands
/Applications/Houston.app/Contents/MacOS/Houston -p "Summarize the architecture" --cwd ~/code/myproj

# let it edit files and run commands (still sandboxed to the project)
Houston -p "Add a unit test for utils/date.ts and run the suite" --cwd . --full-auto

# gate shell commands but approve them when the run asks (instead of denying)
Houston -p "Fix the lint errors" --approval auto-edit --on-approval allow

# CI guard: exit non-zero if the run needs anything the policy doesn't auto-approve
Houston -p "Summarize open TODOs" --on-approval fail

# machine-readable: one JSON object per agent event
Houston -p "List the TODOs" --json

# continue the last session in this folder — then take over interactively
Houston -p "Now add tests for it" --continue
Houston -i   # /resume picks up the same conversation
```

Flags: `--cwd <dir>` (project folder, default the current directory),
`--provider <id>` / `--model <id>` (default your selected model), `--approval
<plan|ask|auto-edit|full-auto>` (default `plan`), `--on-approval
<allow|deny|fail>` (below), `--json`, `--accept-terms`, `--continue` (resume the
most recent session in the folder), `--resume <id>` (resume a specific one).
Assistant text streams to stdout, tool activity (plus a one-line token/cost
total, failed tools, and an early-stop notice if the run hits a step/output
limit) to stderr, and the process exits non-zero on error. It
reuses your saved settings and Keychain-stored API keys. Each run is saved as a
conversation (shared with the app and the interactive `-i` session), so you can
script a prompt and then take over where it left off. The run prints its session
id (`· session <id>` on stderr, or a `{"type":"session","conversationId":…}` line
first in `--json`) so a script can capture it and `--resume <id>` that exact
session later.

**Approval prompts with no human.** Interactively, some tool calls pause for
your approval: whatever the chosen `--approval` policy gates (shell commands
under `auto-edit`, writes and shell under `ask`), plus the calls every policy
asks about (first network or MCP use, shell that escapes the project or runs
unsandboxed). A headless run has nobody to ask, so `--on-approval` decides:
`deny` refuses the call (the agent is told and works within what the policy
auto-approves), `allow` approves it, and `fail` refuses it and exits non-zero so
a script can tell the run needed more than it was granted. The default is
`deny`, except under `full-auto` (which already opts into everything) where it
is `allow`; an unrecognized value is treated as `deny`.

**First-run terms.** The GUI shows a one-time gate to accept the
[Terms of Use](docs/TERMS.md), [Privacy Policy](docs/PRIVACY.md), and
[License](LICENSE) before use. Headless mode has no UI, so the first time you run
it on a profile that hasn't accepted them you must pass `--accept-terms`;
acceptance is then persisted (shared with the GUI), so later runs don't need it.
Without it, the run prints the terms links and exits with code `2`.

## Interactive terminal

Prefer to stay in the terminal? Run a persistent, interactive session — a REPL you
converse with directly, with no window:

```bash
# start an interactive session in the current directory
Houston -i

# pick the folder, model, and starting approval policy up front
Houston -i --cwd ~/code/myproj --model claude --approval auto-edit
```

The `-i` flag is what tells the desktop binary to skip the window. With the
[standalone CLI](#standalone-cli-no-desktop-app) on your PATH there's no window to
skip, so a bare `houston` is enough: `houston` alone starts the same session.

The conversation streams live as the agent works: assistant replies are rendered
as markdown (headings, lists, tables, code blocks) right in the terminal, followed
by reasoning, tool activity with a snippet of each result (including live progress
and any nested subagents), and a per-turn plus running session token/cost meter. A status
line above the composer keeps the model, approval policy, working directory,
session cost, and context-window fill in view at all times. When a tool needs approval (under `ask` / `auto-edit`)
you answer with an **arrow-key picker** (or type `y`/`n`/`a`) — a file edit shows
its **diff** before you approve, and a shell command with no OS sandbox is flagged. When the agent asks a question (`ask_user`) the options are
listed and you pick a number or type your own answer. In **plan mode**, once the
agent presents a plan and stops, you're offered a one-key handoff — accept to
switch to `auto-edit` and carry it out, or keep planning. While the agent works, a
spinner with an elapsed timer shows it's alive (labelled with the current
activity). Press `Ctrl-C` to interrupt the current turn (the session stays open);
`Ctrl-D` to exit.

Press **Tab** to complete slash-command names and `@`-file mentions (fuzzy over the
workspace), and **Up/Down** to recall previous prompts — history persists per
project across restarts. A message can span multiple lines: end a line with `\` to
continue, or open a ``` code fence and it keeps reading until the fence closes.

Slash commands adjust the session without restarting:

| Command | Effect |
| --- | --- |
| `/model [id]` | list configured models, or switch (`providerId`, `providerId/model`, or a bare model id) |
| `/approval [policy]` | show or set the policy (`plan` \| `ask` \| `auto-edit` \| `full-auto`) |
| `/clear`, `/new` | start a fresh conversation |
| `/resume [query]` | list (or search by title) and reopen a saved session |
| `/fork` | branch the current session into a copy, leaving the original intact |
| `/cost` | show session token + cost totals |
| `/skills`, `/agents` | list the workspace's skills / custom agents |
| `/mcp`, `/hooks` | list configured MCP servers / hooks |
| `/theme [name]` | list or switch color theme (`default` / `bright` / `mono`) |
| `/image <path>` | attach an image (PNG/JPEG/GIF/WebP) to your next message |
| `/cwd` | show the working directory |
| `/help` | list commands |
| `/exit`, `/quit` | leave |

Each session is saved as an ordinary conversation, so it survives restarts and
shows up in the desktop app's sidebar — one history across both clients. `/resume`
lists recent sessions for the current folder and reopens one where you left off;
`/clear` starts a fresh one.

Flags mirror headless: `--cwd`, `--provider` / `--model`, `--approval`
(default `ask`), `--full-auto`, and `--accept-terms`. It reuses your saved settings
and Keychain-stored API keys, and the first-run terms gate applies the same way —
interactive mode asks you to accept once (or pass `--accept-terms`). Running in a
pipe (no TTY) isn't interactive; use headless `-p` there instead.

## Standalone CLI (no desktop app)

Both terminal clients above also ship as a **standalone CLI**: a single-file Node
script with no Electron inside — no Chromium is ever loaded, no display server is
needed, and a full run peaks around **60 MB of RAM**, so it works on headless
Linux servers and small VPSes where the desktop app cannot even start.

```bash
# grab houston-cli.cjs from the latest release (optionally verify it first;
# see "Verifying downloads", e.g. sha256sum -c houston-cli.cjs.sha256), then:
node houston-cli.cjs --help          # or: chmod +x houston-cli.cjs && ./houston-cli.cjs
ANTHROPIC_API_KEY=sk-... node houston-cli.cjs -p "Summarize the architecture" --cwd ~/code/myproj --accept-terms
ANTHROPIC_API_KEY=sk-... node houston-cli.cjs -i
```

Requires **Node ≥ 22** — that's the only dependency. All the flags, slash
commands, approvals, sandboxing, and session persistence described in
[Headless / scripting](#headless--scripting) and
[Interactive terminal](#interactive-terminal) work identically: it is the same
client code, built without the desktop shell. (From a source checkout:
`npm run build:cli` produces `out/cli/houston-cli.cjs`.)

**Run it as a bare `houston` command.** Once it's on your PATH, typing `houston`
by itself drops straight into the interactive terminal, with no flag and no
`node …/houston-cli.cjs` prefix:

```bash
# From a source checkout: build the bundle and symlink it onto your PATH.
npm run install:cli                  # → ~/.local/bin/houston (override with --dir)

# From a downloaded release asset: drop it on your PATH yourself.
chmod +x houston-cli.cjs && mv houston-cli.cjs ~/.local/bin/houston

houston                              # interactive session (same as `houston -i`)
houston -p "quick one-shot"          # or script a single run
```

A bare `houston` starts interactive only when it has a real terminal; in a pipe
or CI (no TTY) it prints usage instead of hanging, so use `-p "<prompt>"` there.
`npm run install:cli` symlinks the built bundle (a rebuild is picked up with no
reinstall) and, if the target dir isn't on your PATH yet, prints the line to add.
Prefer npm's own linking? The package exposes a `houston` `bin`, so
`npm run build:cli && npm link` works too. On Windows use `npm link` (npm writes
a `houston.cmd` shim) or invoke the bundle directly.

**API keys.** The desktop app's keys live in the OS keychain (Electron
`safeStorage`) and can't be read outside it, so the CLI resolves credentials in
this order:

1. Environment variables. The built-in providers use their conventional names
   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`),
   as do the catalog hosts you can add (`OPENROUTER_API_KEY`, `GROQ_API_KEY`,
   `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `DEEPINFRA_API_KEY`, and so on), plus
   the web-search keys (`TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`). Any
   provider id, including custom endpoints, also works via `HOUSTON_API_KEY_<ID>`
   (the id uppercased, non-alphanumerics as `_`).
2. `cli-credentials.json` in the profile dir: a flat
   `{"<provider-id>": "<key>"}` map for keys that should persist across shells.
   The `houston providers set-key` command writes it for you (`0600`), or create
   it by hand and `chmod 600` it. It is plaintext by design (a headless box has
   no OS keyring), and the CLI warns if it's readable by other users.

If a provider that needs a key doesn't have one, the CLI now says so up front
with the exact variable to set, instead of failing mid-run with a raw provider
error. Manage providers and keys from the terminal with the `houston providers`
command:

```bash
node houston-cli.cjs providers                       # list configured providers + hosts to add
node houston-cli.cjs providers add openrouter        # register a catalog host (OpenRouter, Groq, ...)
printf %s "sk-..." | node houston-cli.cjs providers set-key openrouter   # store its key (piped, not echoed)
```

Local providers (Ollama, LM Studio) need no key at all: point the CLI at the
same machine and it just works.

**Custom auth headers.** A provider or MCP server can carry custom HTTP headers
(a gateway bearer token, attribution headers), and a stdio MCP server can carry
env values. Like keys, their values are kept in the OS keychain by the desktop
app and can't be read outside it, so the CLI resolves them from
`cli-headers.json` in the profile dir, a
`{"provider:<id>"|"mcp:<id>"|"mcp-env:<id>": {"<Header-or-VAR>": "<value>"}}`
map. Create it yourself and `chmod 600` it; same plaintext-by-design tradeoff
and loose-permissions warning as the credentials file.

**MCP OAuth.** Remote MCP servers that require an OAuth sign-in work in the
terminal too: run `/mcp login <n>` in an interactive session to open the
browser flow. The CLI stores the minted tokens in `cli-mcp-oauth.json` in the
profile dir (written `0600`) and refreshes them automatically; `/mcp logout <n>`
forgets them.

**One profile, shared.** The CLI reads and writes the same per-user profile as
the desktop app (settings, conversations, terminal history), so on a machine
with both installed, `-i` sessions from the CLI appear in the app's sidebar and
vice versa. Set `HOUSTON_DATA_DIR` to use an isolated profile (useful for CI
and servers).

**What's desktop-only.** Capabilities that genuinely need the desktop shell are
absent: `view_localhost` (screenshots of a local dev server need Chromium) is not
offered to the model at all in the CLI; the live Preview dock, integrated
terminal, and auto-update are GUI features. Search tools degrade gracefully:
`search_files` uses `ripgrep` from your `PATH` when present and falls back to a
built-in search otherwise, while `ast_grep` (structural search) needs an
`ast-grep` binary on your `PATH` or via `HOUSTON_AST_GREP` — the desktop app
bundles one, the single-file CLI does not — and reports it is unavailable when
none is found.

## Develop

```bash
npm install
npm run dev      # hot-reloading dev build
```

Useful scripts:

```bash
npm run build    # typecheck + bundle to out/
npm test         # unit tests (vitest: node + jsdom projects)
npm run test:e2e # Electron smoke test (Playwright; builds first)
npm run icon     # regenerate the app icon (build/icon.png + icon.icns)
```

## Build a release

Each OS+arch builds its own artifacts — native modules (`node-pty`) and the per-platform
`rg`/`ast-grep` binaries can't be cross-compiled, so you build on the target OS (and, for
mac, on the target arch — arm64 on Apple Silicon, x64 on an Intel mac):

```bash
npm run dist:mac      # macOS arm64 → .dmg + .zip (+ latest-mac.yml) — run on Apple Silicon
npm run dist:mac:x64  # macOS x64   → .dmg + .zip                    — run on an Intel mac
npm run dist:win      # Windows x64 → -setup.exe + .zip (+ latest.yml) — run on Windows
npm run dist:linux    # Linux x64   → .AppImage + .deb (+ latest-linux.yml) — run on glibc 2.35+ (Ubuntu 22.04)
```

The human download is the `.dmg` / `-setup.exe` / `.AppImage`; the `.zip` / nsis /
AppImage feeds (+ `latest-*.yml`) are what `electron-updater` uses to auto-update an
installed app (see [Updates](#updates)). A `verify:resources` gate runs first and hard-
fails if a vendored binary is missing, so a build can't silently ship without search.

Per-PR CI runs on Linux only (×1 Actions-minute multiplier): a dependency license gate
(`npm run license-gate`, which fails the PR if any package in the installed tree carries
AGPL or another copyleft/source-available license, and holds everything that ships to a
permissive allowlist), the unit gate (lint + typecheck + vitest), the real bubblewrap
sandbox exercise, and a `dist:linux` packaging smoke that gates merge but uploads no
artifact. The full matrix — Linux x64, macOS arm64,
macOS x64 (Intel), and Windows x64, each packaging on its own runner — runs nightly in
[`nightly-build.yml`](.github/workflows/nightly-build.yml), which also smoke-tests the
packaged macOS app with Playwright and uploads inspection-only artifacts
(`nightly-linux-x64` / `nightly-mac-arm64` / `nightly-mac-x64` / `nightly-win-x64`,
3-day retention) — grab a build from that run in the **Actions** tab without building
locally. The same matrix gates a release in `release-prepare.yml`, and
`release-publish.yml` builds and publishes the Release artifacts — keeping macOS (×10)
and Windows (×2) billed minutes off the per-PR path.

## Updates

Packaged builds check for updates via `electron-updater`, against the GitHub
Releases feed configured in [`electron-builder.yml`](electron-builder.yml)
(`publish:`). The check runs on launch and on demand from **Settings → Appearance
→ Updates** ("Check for updates"); when a newer version exists, a persistent
banner appears at the top of the window until you dismiss it or update. (No-op in
dev; set `HOUSTON_DISABLE_UPDATER=1` to turn it off.)

After you install a newer build and relaunch, a small **What's new** popup shows a
1–2 line summary of that version's changes — sourced from the bundled
[`RELEASE_HIGHLIGHTS`](src/shared/update.ts) map, so add an entry there whenever
you bump the version in `package.json`.

**macOS** builds are [signed + notarized](#signing--notarization), so
`electron-updater` can verify a downloaded package's signature against the running
app. There the updater auto-downloads an update in the background — a banner shows
download progress and, once ready, a **Restart to install** button — and it installs
on the next quit if you don't (`autoDownload` / `autoInstallOnAppQuit` in
[`src/main/updater.ts`](src/main/updater.ts), gated per-platform by
`shouldAutoInstallUpdates`).

**Windows and Linux** builds are not OS-code-signed, so `electron-updater` has no
package signature it can verify and auto-installing a remote package would make the
release pipeline an RCE boundary. On those platforms the banner links to **Releases**
for a manual download, until they are signed too. (Linux downloads can still be verified
by hand, they're GPG-signed: see [Verifying downloads](#verifying-downloads).)

Update metadata is published by running `npm run dist` with a `GH_TOKEN` and
`--publish`, or by attaching the artifacts to a release manually. On macOS the
updater pulls the **`.zip`** (the `.dmg` is the human first-install), so a release
needs the `.zip`, its `.blockmap`, and the generated `latest-mac.yml` — all
produced by `npm run dist`.

## Architecture

```
src/
├── shared/        types + IPC channel names shared by all processes
│   ├── agent.ts       chat/tool/stream protocol + agent run + conversation types
│   ├── types.ts       settings, providers, approval policy
│   └── defaults.ts    built-in provider seeds
├── main/          Electron main process (Node)
│   ├── providers/     Anthropic / OpenAI / Gemini / OpenAI-compatible adapters
│   ├── agent/         tool definitions + the tool-calling loop + system prompt
│   │                  (incl. compaction.ts — summarize old turns to fit context;
│   │                   rules.ts — load project AGENTS.md / CLAUDE.md)
│   ├── mcp/           MCP transports (stdio / streamable HTTP / SSE) + the
│   │                  OAuth sign-in client for hosted servers (discovery,
│   │                  dynamic registration, PKCE, refresh)
│   ├── sandbox.ts     macOS Seatbelt profile + sandboxed command runner
│   ├── secrets.ts     Keychain-encrypted credential storage (API keys, OAuth
│   │                  token sets, custom header/env secrets)
│   ├── oauth.ts       provider-account OAuth (stub; MCP-server OAuth is real
│   │                  and lives in mcp/oauth.ts)
│   ├── store.ts       settings persistence
│   ├── conversations.ts  conversation persistence (one JSON per chat)
│   └── ipc.ts         all IPC handlers
├── preload/       contextBridge — the typed `window.api` surface
└── renderer/      React UI (transcript, model picker, settings, approvals)
```

The renderer talks to the main process only through the preload bridge. Provider
adapters translate a single internal chat/tool protocol to and from each SDK, so
the agent loop and UI never depend on a specific provider.

## Security model

- **Tool execution is sandboxed.** `run_shell` runs under `sandbox-exec` with a
  generated profile: deny-by-default, filesystem reads allowed, writes restricted
  to the project + temp dirs, network denied unless in *full auto*.
- **File tools are contained** to the workspace in code — any path that resolves
  outside the project root is rejected.
- **Human in the loop.** Writes and shell commands require approval unless you
  opt into a more autonomous policy. Network egress (`web_fetch`, `web_search`,
  `view_localhost`) always prompts on first use — even in *full auto* — since it
  leaves the machine; choose *allow-for-the-run* to stop further prompts that run.
  `view_localhost` is restricted to loopback addresses and loads untrusted page
  content in a sandboxed, isolated, no-Node window; its main frame can't be
  navigated or redirected off loopback, and its requests can't reach
  private/LAN/metadata hosts (public CDNs are still allowed so pages render).
- **Keys at rest** are encrypted via the OS Keychain; only ciphertext is written
  to disk (`0600`), and the renderer only ever sees a `hasKey` flag.

Coding agents run model-authored commands. Treat *full auto* + network with the
same caution you'd treat running untrusted code, and prefer the default
*ask*/*auto-edit* policies.

## Signing & notarization

macOS release builds are code-signed with a **Developer ID Application** certificate
and notarized by Apple. Windows and Linux installers are not OS-code-signed yet, though
Linux downloads are GPG-signed for verification (see
[Verifying downloads](#verifying-downloads)). Signing and
notarization are driven entirely by CI environment variables (see
[`release-publish.yml`](.github/workflows/release-publish.yml)), so no certificate or
credential is committed to the repo.

The macOS build reads five repo secrets, set under **Settings → Secrets and
variables → Actions** on the source repo:

| Secret | Purpose |
|--------|---------|
| `CSC_LINK` | base64 of the Developer ID Application `.p12` (certificate + private key) |
| `CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

With those present, [`electron-builder.yml`](electron-builder.yml) signs with the
imported identity (it leaves `mac.identity` unset so the cert is auto-selected) and
electron-builder v26 notarizes automatically. Builds without the secrets
(nightly-build, release-prepare, and a local `npm run dist`) skip signing and
produce an unsigned app. To sign a build locally, import the Developer ID cert into
your login keychain and export the same variables in your shell before
`npm run dist:mac`.

### Verifying downloads

Every published artifact can be verified before you run it. Three independent methods
are provided, and any one is enough.

**1. GPG (offline, no extra tooling).** The Linux artifacts (`*.AppImage`, `*.deb`)
ship with a detached `<file>.asc` signature, and every release carries a `SHA256SUMS`
manifest signed as `SHA256SUMS.asc`. Both are made with the project signing key,
published as `houston-signing-key.asc` on each release. Import the key once (pin the
fingerprint below), then verify:

```bash
gpg --import houston-signing-key.asc
# fingerprint: A11D D282 4C1E F838 D441  452F 5DD4 F607 9F8B A5DB

# verify the whole release in one step:
gpg --verify SHA256SUMS.asc SHA256SUMS   # trust the manifest,
sha256sum -c SHA256SUMS                   # then check your downloads against it

# or verify a single Linux artifact directly:
gpg --verify Houston-<version>-x64.AppImage.asc Houston-<version>-x64.AppImage
```

A `Good signature` line carrying the fingerprint above confirms authenticity. This is
for verifying a download by hand: the in-app updater does not use GPG (it verifies the
update feed over HTTPS), so a bad signature here means re-download, not a blocked update.

**2. cosign (keyless, transparency-logged).** Every artifact (the desktop installers,
the standalone `houston-cli.cjs`, and the CycloneDX + SPDX SBOMs, covering both the
JavaScript dependency closure and the native/runtime layer) also ships with a
`<file>.cosign.bundle` beside it. Each is keyless-signed in CI with
[cosign](https://docs.sigstore.dev/): the signature, its short-lived certificate, and a
[Rekor](https://docs.sigstore.dev/logging/overview/) transparency-log proof all live
inside the bundle, so anyone can verify with no account, key, or repo access:

```bash
cosign verify-blob houston-cli.cjs \
  --bundle houston-cli.cjs.cosign.bundle \
  --certificate-identity 'https://github.com/piyushvijay/houston/.github/workflows/release-publish.yml@refs/heads/main' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

`Verified OK` confirms the file came from this project's release workflow and has not been
altered. The same command verifies any released file: substitute its name and matching
`.cosign.bundle`.

**3. Checksums only.** For a plain integrity check without verifying who signed it,
`sha256sum -c SHA256SUMS` (or the standalone `houston-cli.cjs.sha256`) confirms a
download matches what was published.

## Roadmap

What's intentionally not done yet — out of scope for a macOS desktop app, or a
larger effort — is tracked in [ROADMAP.md](./ROADMAP.md) with the
rationale for each.

## Legal

Houston is proprietary software, provided **as is**, without warranty, and you
use it at your own risk. It can read, edit, delete, and run files and commands on
your device, and it sends your prompts, code, and files only to the model and
other providers **you** configure — under those providers' own terms, privacy,
and model-training policies. You are responsible for reviewing the agent's
actions, keeping backups, and meeting any data-residency or data-protection
obligations that apply to you.

- [License](LICENSE) — proprietary license, all rights reserved
- [Terms of Use](docs/TERMS.md)
- [Privacy Policy](docs/PRIVACY.md)

> These documents are templates and not legal advice. Replace the bracketed
> placeholders (licensor, contact, governing law) and have a lawyer review them
> before distributing.
