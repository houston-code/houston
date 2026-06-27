# Houston

A **cross-platform coding agent** — **bring your own model**. Point it at Claude, GPT,
Gemini, any OpenAI-compatible API, or a local model (Ollama / LM Studio), give it
a project folder, and let it read, edit, search, and run code — every action gated
by an approval flow and, where the OS supports it, confined to a sandbox.

Built with Electron + React + TypeScript. Runs on macOS 12 Monterey or newer
(Apple Silicon and Intel), Windows 10 or newer (x64), and Linux (x64, glibc-based distros).

![Houston icon](build/icon.png)

## Features

- **Any model, your keys.** Anthropic (Claude), OpenAI (GPT), Google (Gemini),
  any OpenAI-compatible endpoint, and local models via Ollama or LM Studio. Add
  custom endpoints and fetch live model lists in Settings.
- **Image attachments.** Drag-drop or paste images (PNG/JPEG/GIF/WebP) into the
  composer to send them to a vision-capable model — screenshots, diagrams,
  mockups. The affordance is offered only when the selected model supports
  vision. Thumbnails show inline and the images persist with the conversation.
  The agent can also `read_file` an image or PDF in the project and view it
  directly (full vision on Anthropic; other providers get a text placeholder).
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
- **Web search.** With a Tavily API key (set in Settings → *Web search*), the
  agent can `web_search` the web for current information. Like `web_fetch`, it
  requires approval since it leaves the machine.
- **See its own localhost.** After starting a dev server (a background
  `run_shell`), the agent can `view_localhost` to load the page in an offscreen
  Electron window, screenshot it, and read back the browser console — closing the
  build → look → fix loop without a human eyeballing the page. The screenshot
  comes back through the same vision pipeline as pasted images, so a
  vision-capable model views it directly, and it shows inline in the transcript.
  Only loopback hosts (`localhost`, `127.0.0.1`, `::1`) are allowed — public URLs
  go through `web_fetch` — and, being local network egress, it always prompts for
  approval like `web_fetch`. Pass a `selector` to capture just one element.
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
- **Research subagents.** The agent can `dispatch_agent` to hand a focused,
  read-only question to a subagent with its own fresh context. The subagent
  reads, globs, and searches the project and reports back — keeping the main
  agent's context clean. Subagents can't edit, run commands, or use the network.
- **Adversarial review.** `review_changes` (or `/review`) reviews your uncommitted
  changes for correctness, security, and quality. It runs an independent read-only
  reviewer per dimension — each in its own fresh context, so they don't inherit the
  author's blind spots — then a skeptical verifier that re-checks every candidate
  finding against the real code and drops the false positives, and reports the
  confirmed ones. The agent can self-review after a substantial change before
  telling you it's done.
- **Custom agents & skills.** Drop a Markdown file in `.houston/agents/` to define
  a specialized read-only subagent (front-matter `description` + a system-prompt
  body) — the main agent can dispatch it by name. An optional front-matter `tools:`
  list narrows which read-only tools that agent may use (it can only restrict the
  default set, never grant write/shell/network). Add a `.houston/skills/<name>/SKILL.md`
  to register a skill: its description is surfaced to the agent, which reads the
  full instructions on demand.
- **MCP servers.** Connect Model Context Protocol servers in Settings — a local
  **stdio** process or a remote **HTTP** (streamable) or **SSE** endpoint (with
  optional static bearer-token / custom auth headers). Their tools are offered to the agent namespaced as
  `mcp__<id>__<tool>` and always require approval. Point Houston at the
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
  structured file tools stay confined to the project on every platform.
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
- **Approval flow.** Choose how much autonomy to grant: *plan mode* (read-only —
  the agent researches and proposes a plan, with writes and shell commands
  blocked), *ask every time*, *auto-approve edits*, or *full auto*. Approve, deny,
  or allow-for-the-run on each tool call. File edits show an inline red/green
  **diff** so you can review exactly what changes before approving.
- **Project guardrails.** A repo can ship a `.houston/settings.json` with its own
  *deny* / *ask* permission rules (checked before your global ones) — e.g. always
  ask before touching `infra/**`. For safety a project file can only *tighten*:
  `allow` rules, hooks, and MCP servers stay in your own global Settings, so
  cloning an untrusted repo can't auto-approve actions or run commands.
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
- **Format on save.** Turn on *Format on save* (Settings → *Tools & Permissions*)
  and Houston runs the matching formatter on each file the agent writes — Prettier
  for JS/TS/JSON/CSS/Markdown, `gofmt`, `rustfmt`, and `ruff`/`black` for Python.
  It only fires when the formatter is installed, runs in the same sandbox as
  `run_shell` (no network), and is off by default.
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
  its diff shows only the new changes.
- **Start a chat in its own worktree.** Every new chat in a git repo defaults to
  running in a fresh, isolated worktree on its own branch — so the agent's edits
  never touch your current checkout. Right after the folder picker in the control
  bar you choose the base branch to fork from and name the new branch (or untick
  *New worktree* to work in the repo directly); the worktree is created on your
  first message, under `.houston/worktrees/` and kept out of the parent repo's
  `git status` via `.git/info/exclude`. Deleting the chat offers to remove the
  worktree too (uncommitted or unmerged work is always kept).
- **GitHub repos, PRs, issues & CI (first-class).** When the [`gh` CLI](https://cli.github.com)
  is installed and authenticated (`gh auth login`), Houston gets dedicated tools
  for the whole GitHub loop:
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
  shell `gh`.
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

| Platform | Minimum OS | Download | Auto-updates? |
|----------|------------|----------|---------------|
| macOS (Apple Silicon) | macOS 12 Monterey | `Houston-<version>-arm64.dmg` — open it, drag **Houston** to Applications | Yes (via the `.zip` feed) |
| macOS (Intel) | macOS 12 Monterey | `Houston-<version>-x64.dmg` — open it, drag **Houston** to Applications | **No** — re-download to update |
| Windows (x64) | Windows 10 | `Houston-<version>-x64-setup.exe` — run the installer (per-user, no admin) | Yes |
| Linux (x64) | glibc-based distro (Ubuntu 20.04+ / Debian 11+ / Fedora) | `Houston-<version>-x64.AppImage` — `chmod +x` and run | Yes (AppImage only) |
| Linux (x64) | glibc-based distro (Ubuntu 20.04+ / Debian 11+ / Fedora) | `Houston-<version>-x64.deb` — `sudo apt install ./…deb` | **No** — update via your package manager or re-download |

> **The builds are unsigned.** First-run warnings to expect:
> - **macOS** — Gatekeeper warns. Right-click the app → **Open** → **Open**, or remove
>   quarantine: `xattr -dr com.apple.quarantine "/Applications/Houston.app"`.
> - **Windows** — SmartScreen warns until the installer is signed with an Authenticode
>   cert. Click **More info** → **Run anyway**.
> - **Linux** — AppImage/deb are unsigned (conventional).
>
> The bundled `ast-grep` is glibc-only, so the Linux build needs a glibc distro
> (Debian/Ubuntu/Fedora/etc.); musl distros (Alpine) aren't supported.
>
> **Intel macs don't auto-update.** arm64 and Intel build on separate runners, and
> electron-builder emits one `latest-mac.yml` per build — letting both publish it would
> clobber the arm64 feed and break the updater ([electron-builder#5592](https://github.com/electron-userland/electron-builder/issues/5592)).
> So arm64 owns auto-update; the Intel build ships its `.dmg`/`.zip` for manual
> re-download (like the Linux `.deb`). Intel auto-update is a planned follow-up.
>
> To ship a signed + notarized macOS build, see [Signing & notarization](#signing--notarization).

## First run

1. Open **Settings** (sidebar) and set an API key for at least one provider
   (or point a local endpoint at Ollama/LM Studio — no key needed).
2. Pick a **project folder** (control bar, above the composer).
3. Choose a **model** and an **approval policy** (same control bar).
4. Ask it to build or change something.

## Headless / scripting

Run a single prompt without opening the window — useful for scripts, pipelines,
and CI. Pass `-p`/`--prompt` to the app binary:

```bash
# read-only by default (plan mode): analysis / Q&A, no edits or commands
/Applications/Houston.app/Contents/MacOS/Houston -p "Summarize the architecture" --cwd ~/code/myproj

# let it edit files and run commands (still sandboxed to the project)
Houston -p "Add a unit test for utils/date.ts and run the suite" --cwd . --full-auto

# machine-readable: one JSON object per agent event
Houston -p "List the TODOs" --json
```

Flags: `--cwd <dir>` (project folder, default the current directory),
`--provider <id>` / `--model <id>` (default your selected model), `--approval
<plan|ask|auto-edit|full-auto>` (default `plan`), `--json`. Assistant text streams
to stdout, tool activity to stderr, and the process exits non-zero on error. It
reuses your saved settings and Keychain-stored API keys.

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
npm run dist:linux    # Linux x64   → .AppImage + .deb (+ latest-linux.yml) — run on Linux
```

The human download is the `.dmg` / `-setup.exe` / `.AppImage`; the `.zip` / nsis /
AppImage feeds (+ `latest-*.yml`) are what `electron-updater` uses to auto-update an
installed app (see [Updates](#updates)). A `verify:resources` gate runs first and hard-
fails if a vendored binary is missing, so a build can't silently ship without search.

Every PR set to auto-merge builds macOS arm64, Windows x64, and Linux x64 in CI (each on
its own runner, against the merged state), smoke-tests the packaged macOS app with
Playwright, and uploads the artifacts (`houston-mac-arm64` / `houston-win-x64` /
`houston-linux-x64`) on the workflow run — grab a build from the **Actions** tab without
building locally. The macOS **x64 (Intel)** build runs only in the release pipeline (the
prepare gate and the publish job), keeping its 10×-billed macOS minutes off the per-PR path.

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

It does **not** auto-download or silently install: this build is unsigned, so
there's no Developer ID signature for `electron-updater` to verify against, and
silently installing remote packages would make the release pipeline an RCE
boundary. The banner therefore links to **Releases** to download manually. Once
the app is [signed + notarized](#signing--notarization), enable `autoDownload` /
`autoInstallOnAppQuit` in [`src/main/updater.ts`](src/main/updater.ts) so the
signature check is meaningful and the banner can install in place.

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
│   ├── sandbox.ts     macOS Seatbelt profile + sandboxed command runner
│   ├── secrets.ts     Keychain-encrypted credential storage (API-key + OAuth)
│   ├── oauth.ts       OAuth device-code/PKCE flow (stub — awaits client IDs)
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
  content in a sandboxed, isolated, no-Node window.
- **Keys at rest** are encrypted via the OS Keychain; only ciphertext is written
  to disk (`0600`), and the renderer only ever sees a `hasKey` flag.

Coding agents run model-authored commands. Treat *full auto* + network with the
same caution you'd treat running untrusted code, and prefer the default
*ask*/*auto-edit* policies.

## Signing & notarization

The build is ad-hoc signed because there's no Developer ID configured. To sign
and notarize, set `mac.identity` in [`electron-builder.yml`](electron-builder.yml)
to your Developer ID and add a notarization step (e.g. `@electron/notarize` via
an `afterSign` hook), then `npm run dist`.

## Roadmap

What's intentionally not done yet — out of scope for a macOS desktop app, or a
larger effort — is tracked in [ROADMAP.md](./ROADMAP.md) with the
rationale for each.
