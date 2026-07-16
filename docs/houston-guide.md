# Houston: product guide

This is Houston's own reference for how Houston works. When the user asks how to
do something *in Houston itself* (its slash commands, skills, subagents, hooks,
plugins, MCP servers, approval modes, permission rules, plan mode, sandboxing,
GitHub tools, settings, or keyboard shortcuts), answer from this guide rather
than describing a generic assistant. Relay the relevant part concisely and point
at the exact setting or file. If a detail is not covered here, say so instead of
guessing, and offer to look it up in the project.

## What Houston is

Houston is a coding agent that runs on the user's own machine and works inside a
single project directory. It brings its own model connections (the user supplies
API keys, or runs a local model), a set of file, shell, search, web, and GitHub
tools, and a permission system that decides how much runs without asking. It
ships as a desktop app and as terminal clients.

## Clients (where Houston runs)

- **Desktop app.** The full GUI: chat sidebar, diffs, preview panel, settings.
- **Interactive terminal (`houston -i`).** A stay-resident REPL in the terminal.
  Conversation streams live, approvals and questions are answered inline, and
  slash commands switch settings mid-session.
- **Headless (`houston -p "<prompt>"`).** Runs one prompt and streams the result
  to stdout, then exits. Read-only by default; add `--full-auto` to let it edit
  and run commands, `--json` for machine-readable events. Good for scripts and CI.
  With no human to answer approval prompts, `--on-approval <allow|deny|fail>`
  decides what a gated tool call gets: denied by default (allowed under
  `--full-auto`), with `fail` also exiting non-zero so a script can tell the run
  hit a permission wall.
- **Standalone CLI.** The same `-p` and `-i` clients as a single self-contained
  Node script, with no desktop app and no browser engine. Runs on headless Linux
  servers; API keys come from environment variables.

All clients share one agent core, so tools, permissions, and skills behave the
same across them. Some surfaces are desktop-only (the preview panel, spawning
separate sidebar sessions, viewing localhost screenshots).

## Models

Bring any model with your own key: Anthropic, OpenAI, Google, any
OpenAI-compatible endpoint, or a local model runtime. Add a provider and key in
Settings, fetch its live model list, and pick a model. The picker shows each
model's context window and capability badges (tool calling, vision, reasoning)
and warns before you pick one that cannot call tools. Keys are stored encrypted
by the OS keychain and never touch the renderer. The selection is shared across
clients: picking a model in the desktop app or switching with `/model` in the
terminal saves it as the default for future sessions.

## Slash commands

Type `/` in the composer for the command menu. The exact set depends on the
client, but the common built-ins are:

- `/new` (alias `/clear`): start a fresh conversation.
- `/compact`: summarize older turns now to free up context.
- `/plan`: switch to plan mode (read-only). In the desktop app `/ask`, `/auto`,
  and `/full` switch the other approval modes; the terminal uses `/approval <policy>`.
- `/review`: run an adversarial review of your uncommitted changes and fix what
  it confirms.
- `/skills`, `/agents`: list the workspace's skills and custom agents.
- `/help`: list the available commands.

The interactive terminal adds terminal-specific commands such as `/model` (list
or switch model), `/login` (set an API key, also `/providers`), `/approval`,
`/settings`, `/resume`, `/fork`, `/cost`, `/mcp`, `/hooks`, `/theme`, `/image`,
`/cwd`, and `/exit`.

**Custom commands.** Any Markdown file in `.houston/commands/<name>.md` becomes a
`/name` command. The file body is a prompt template: `$ARGUMENTS` is replaced
with whatever the user types after the command name (if there is no placeholder,
the args are appended). The first line is used as the command's description.

## Approval modes and permissions

Approval is layered. From most to least restrictive:

- **Plan mode:** read-only. The agent researches and proposes a plan; writes and
  shell commands are blocked. It presents the plan for the user to accept,
  request changes, or reject.
- **Ask every time:** every edit and command needs a click.
- **Auto-approve edits:** file edits go through automatically; shell commands
  still ask.
- **Full auto:** edits and (sandboxed) commands run without asking. Two egress
  controls still hold even here, because the sandbox can read your whole
  filesystem: network egress is granted **per destination** (approving a fetch to
  one host does not open egress to another), and the first shell command pauses
  once for a **shell-network consent** so blanket outbound access is never
  automatic (declining runs commands offline).

On any single tool call the user can approve once, deny, **allow for the run**
(auto-approve that kind of tool for the rest of the conversation, or, for a
network call, just that one destination), or **always allow / always deny**
(saves a permission rule so the choice persists). File edits show an inline
red/green diff before approval.

**Permission rules** (Settings) are finer-grained than the mode: `allow`,
`deny`, or `ask`, matched on the tool plus a glob over its target, e.g. allow
`run_shell` matching `git *`, deny anything matching `*rm -rf*`, always ask
before `write_file` under `src/secret/**`. Rules are checked before the mode and
the first match wins.

**Project guardrails.** A repo can ship a `.houston/settings.json` with its own
`deny` / `ask` rules, checked before the user's global rules. Those guardrails
always apply and can only *tighten*, so cloning an untrusted repo can never
auto-approve actions.

**Trusted folders.** The same project file may also define `allow` rules,
`hooks`, and `mcpServers`. Those ELEVATE (they auto-approve matching actions or
run processes as you), so Houston ignores them until you explicitly trust the
folder: the desktop app shows a banner above the composer, and the interactive
terminal asks at session start (Trust / Not now / Never). Your decision is bound
to a fingerprint of that elevating config; if it later changes (say a pull adds
a hook), the folder drops back to untrusted and Houston asks again. Headless
runs never prompt and simply note when an untrusted folder's extra config is
being ignored. Trusted project `allow` rules sit BELOW your own rules (they fill
gaps, never override you), project hooks run after yours, and project MCP
servers appear namespaced as `mcp__proj-<id>__<tool>`.

**Managed policy.** On a managed device an administrator can ship a machine-wide
`managed-settings.json` with `deny` / `ask` rules that outrank both project
guardrails and every user's own rules. It too can only tighten, and lives in a
root-owned location the user cannot edit.

## Skills

A skill is a reusable instruction bundle at `.houston/skills/<name>/SKILL.md`,
with front-matter `name` and `description` and a body of instructions. Only the
name and description are shown to the agent up front (cheap); the agent loads the
full body on demand by calling the `skill` tool when a task matches. This is
progressive disclosure: skills stay out of the way until they are needed. Houston
also ships this guide as a built-in `houston-guide` skill.

## Custom subagents

Drop a Markdown file in `.houston/agents/<name>.md` to define a specialized
subagent: front-matter `description` plus a system-prompt body. The main agent
dispatches it by name with `dispatch_agent`, and it works in its own fresh
context and reports back, keeping the main thread clean. An optional front-matter
`tools:` list narrows which tools it may use, and an optional `model:` pins the
agent to a (usually cheaper) sibling model from the current provider — unknown
ids fall back to the chat's model. By default a subagent is read-only (it cannot
edit files or run commands); a subagent marked `write: true` gets a writable tier
and is dispatched with `dispatch_writable_agent`, which is approval-gated because
it grants write access: one approval covers the whole delegated task's local
actions, confined to the project. Either tier can also reach the web with
`web_fetch` and `web_search`, and every network request first asks you for
approval, per destination, exactly like the main agent's own network calls (a
denial comes back to the subagent as its tool result). A subagent's shell
commands never get network access. On a host without an OS-enforced sandbox
(e.g. Windows), each shell command a writable subagent runs would run unconfined,
so it asks for its own approval first too. Tokens a subagent spends roll into the
conversation's usage meter, priced at the model the subagent actually ran on.

While a subagent works, its dispatch row shows live progress (turn counter plus
what it is doing), in every client. Each report ends with an id like `ag1`: the
main agent can pass it back as `resume` to send a follow-up into that subagent's
context instead of re-dispatching from scratch (ids last for the app session). A
dispatch can also pass `model` to run one-off legwork on a cheaper sibling model.
Subagents can fan out one level themselves: a dispatched agent may dispatch its
own nested read-only researchers (never writable, and no deeper).

## Spawn separate sessions

Where a subagent reports back into the current turn, `spawn_session` spins off a
*separate* chat: the agent hands it a task, optionally on its own git branch and
worktree, and sets it running in the background. It appears in the sidebar with a
live indicator, seeded with the handed-off context. A spawned session inherits
the current approval policy, so it is never more permissive than the chat that
spawned it. In the TUI and headless CLI, spawned sessions run too — they execute
non-interactively (anything needing an approval is declined automatically) and
persist as ordinary conversations you can open later with `/resume` or
`--resume <id>`; a one-shot headless run waits for its spawned sessions before
exiting.

## Scheduled runs

The agent can schedule recurring (or one-time) background runs with
`schedule_run` — say "every morning at 9, run the tests and summarize failures"
and it stores a schedule; at each occurrence a fresh session starts with the
stored prompt, under the approval policy of the chat that created it. Specs:
`every <N>m|h|d` (minimum 5 minutes), `daily at HH:MM`, `weekdays at HH:MM`,
`weekly on <day> at HH:MM`, or `once at YYYY-MM-DD HH:MM` (local time).
`list_scheduled_runs` shows what's configured (with next/last fire times);
`cancel_scheduled_run` removes one. Creating or cancelling a schedule is
approval-gated. Schedules persist across restarts and fire while Houston (the
desktop app or the TUI) is running — this is an in-app scheduler, not OS cron;
an occurrence missed while Houston was closed fires once at the next launch.

## Review and multi-step tools

- **`review_changes` (or `/review`)** reviews uncommitted changes for
  correctness, security, and quality. It runs an independent read-only reviewer
  per dimension, each in a fresh context, then a skeptical verifier that
  re-checks every candidate against the real code and drops false positives, and
  reports the confirmed findings. Scope it to a `base` branch or specific
  `paths`, raise `effort` to `high` to verify each finding with several
  independent skeptics, or pass `model` to run the reviewers and verifiers on a
  cheaper sibling model.
- **`todo_write`** keeps a task list for multi-step work, rendered live in the
  transcript.
- **`pr_sweep`** tracks batch pull-request work (author new PRs from a task list,
  or process a batch of existing open PRs).

## Hooks

Hooks (Settings, *Hooks*) run your own shell commands at set points in the
agent loop. Each hook names an event and, for the tool events, a matcher glob
on the tool name (the other events match only an empty or `*` matcher):

- **PreToolUse**: before a tool call runs. Can block the call, approve it
  (skipping the approval prompt), or rewrite its arguments.
- **PostToolUse**: after a tool call. The hook's output is appended to the
  tool result so the agent sees it (e.g. auto-format after every edit, or run
  tests after a write).
- **UserPromptSubmit**: when you submit a message, before the turn runs. Can
  block the prompt or inject extra context.
- **SessionStart**: once when a run begins. Injected context is appended to
  the system prompt.
- **Stop**: when the agent would end its turn. Blocking forces another turn
  with the reason fed back (e.g. "run the tests before you stop"), bounded so
  a hook cannot keep the agent alive forever.
- **PreCompact**: before the conversation is compacted. Injected context is
  folded into the material being summarized, so it survives compaction.

The simplest contract is the exit code: a non-zero exit blocks the blocking
events (PreToolUse, UserPromptSubmit, Stop), and plain stdout/stderr is fed
back to the agent as feedback. For finer control, a hook can print a single
JSON object on stdout:

- `decision`: `"block"` vetoes the action even on a zero exit; `"approve"`
  (PreToolUse only) skips the approval prompt. A block always wins over an
  approve.
- `reason`: a human-readable explanation, fed back to the agent (and shown
  with a block).
- `additionalContext`: extra context injected where the event fires: the tool
  result (PreToolUse), your message (UserPromptSubmit), the system prompt
  (SessionStart), or the material being summarized (PreCompact).
- `updatedInput` (PreToolUse only): replacement arguments the tool runs with.
  A rewrite that fails the tool's schema fails the call rather than falling
  back to the original arguments. Rewritten arguments are re-matched against
  your permission rules, so the approval decision is made on what will
  actually run: a rewrite that lands on a deny rule is refused outright, even
  if the hook also approved. A hook can tighten policy, but it can never
  loosen a managed or project deny.
- `systemMessage`: a note for you rather than the agent; it is never added to
  the model's context.

When several hooks match, they run in order; any block wins, and the last
rewrite wins. Hooks run in the same project sandbox as `run_shell` (no
network). Context arrives in environment variables: `$HOUSTON_HOOK_EVENT`,
`$HOUSTON_TOOL_NAME`, and `$HOUSTON_TOOL_INPUT`, plus `$HOUSTON_TOOL_RESULT`
(PostToolUse) and `$HOUSTON_USER_PROMPT` (UserPromptSubmit).

## Plugins

Drop a JS file in `.houston/plugins/` to register *observational* lifecycle
hooks: `houston.on('onToolStart' | 'onToolResult' | 'onUserMessage', fn)`, for
logging, metrics, or notifications. Plugins are local trusted files (the same
trust model as hooks, agents, and skills) and only run when the user has opted
into project plugins for that project. Each runs in an isolated context with no
`require`, `process`, or network; a plugin cannot block or alter a call (use a
PreToolUse shell hook for that), and a throwing or slow plugin is caught and
ignored.

## MCP servers

Connect Model Context Protocol servers in Settings: a local **stdio** process or
a remote **HTTP** (streamable) or **SSE** endpoint. Their tools are offered to
the agent namespaced as `mcp__<id>__<tool>` and always require approval. When
many MCP tools are connected, Houston loads their schemas lazily: above a
threshold the agent gets a compact catalog plus a `find_tools` meta-tool and
pulls in only the tool definitions it needs, instead of sending every schema on
every request.

**Authentication.** Remote servers take custom headers (e.g. a static
`Authorization: Bearer` token), or **OAuth** for servers that require a sign-in:
click *Sign in (OAuth)* on the server in Settings (desktop) or run
`/mcp login <n>` (terminal). Houston discovers the server's authorization
server, registers itself as an OAuth client automatically, and opens the browser
to authorize; tokens are stored encrypted, sent as the bearer on every
connection, and refreshed automatically when they expire. *Sign out* (or
`/mcp logout <n>`) forgets them. An explicit Authorization header, when set,
takes precedence over OAuth tokens.

**Local (stdio) servers** can be given a working directory and environment
variables (Settings, or the `/mcp add` prompts). The spawned process gets a
credential-stripped base environment, so a token the server needs must be listed
explicitly; env values are secrets and are stored encrypted, like header values.

**Resources and prompts.** When a server exposes MCP resources or prompt
templates, the agent gets `mcp_list_resources`/`mcp_read_resource` and
`mcp_list_prompts`/`mcp_get_prompt` meta-tools to discover and fetch them.
Houston also honors server `list_changed` notifications (tools, resources, and
prompts refresh live), keeps long tool calls alive while the server reports
progress, and caps any single MCP result so a runaway server cannot flood the
context window. `/mcp` in the terminal and the Settings panel show each server's
live connection status: connected with a tool count, needs sign-in, or the
connect error.

**Server questions (elicitation).** A server can ask for input in the middle of
a tool call (for example a region, a project name, or a confirmation). Houston
shows the request as a small form naming the server, with typed fields and
Submit / Decline: your answer goes to that MCP server, not to the model. In the
terminal the same request becomes an inline prompt (decline with `n`); in a
headless or background run it is declined automatically so nothing ever hangs
waiting for a user who is not there, and the server proceeds along its
no-answer path. Stopping the run cancels any open request.

## Shell sandbox and network

Shell commands run under the host OS sandbox where one exists, confined to the
project directory: writes outside the project are blocked, and network access is
off by default.

- **macOS:** Seatbelt (`sandbox-exec`).
- **Linux:** bubblewrap (an unprivileged user namespace), when available.
- **Windows:** no broadly-available equivalent, so shell commands run unconfined;
  Houston reports them as not sandboxed and never silently auto-approves one.

The structured file tools stay confined to the project on every platform.
Network from `run_shell` is *gated*, not permanently off, and it is no longer
implied by full auto: the sandbox can read your whole filesystem, so blanket
outbound access plus full auto would be a one-command read-and-exfiltrate. Shell
reaches the network only after a conscious per-run grant, either the one-time
**shell-network consent** (full auto) or "Allow for run" on a shell command
(ask / auto-edit). A command that needs the network (cloning, installing
dependencies, `gh`, `curl`) is not impossible, it just needs that grant;
declining runs the command offline instead of blocking it. Package-manager caches
(npm, pip, yarn) are auto-redirected to a writable temp dir, so dependency
installs need no cache workaround once network is on. **Additional folders**
(Settings) can be added to the file tools' allowed roots and the shell sandbox to
work across more than one repo.

**Egress allowlist.** Granted shell network is not unrestricted: on macOS and
Linux it is routed through a local proxy Houston controls, and the OS sandbox
blocks any direct connection, so the proxy is the only road out. The proxy
allows a destination only if its domain is on the egress allowlist: a built-in
set of development infrastructure (package registries such as npm, PyPI,
crates.io, RubyGems, Maven, Go; VCS hosts such as GitHub, GitLab, Bitbucket)
plus any domains added in Settings under **Sandbox egress**. Each entry also
covers its subdomains, a deny list wins over every allow, and edits apply
immediately, mid run. A refused destination fails with an `EGRESS_BLOCKED`
message naming the domain: that is policy, not an outage. Only HTTP(S) flows
through the proxy, so other protocols (for example SSH) are blocked under the
allowlist; use HTTPS remotes inside the sandbox, or switch the egress mode to
"All domains" (Settings) to restore unrestricted granted network. On Windows,
where no OS sandbox exists, the allowlist cannot be enforced. One Linux note:
under the allowlist each command runs in its own network namespace, so a dev
server started inside the sandbox is reachable only from that same command, not
from the Preview panel or later commands; "All domains" restores the shared
network there.

**Credential masking on egress.** Houston's own network tools refuse to *send* a
credential: before a `web_fetch` or `web_search` leaves the machine, its URL or
query is scanned for a well-known token format or one of this install's stored
secret values, and the call is refused if one is present. This is the outbound
counterpart to the tool-result redactor (which scrubs secrets on the way back
in), so a prompt-injected agent cannot exfiltrate a key by pasting it into a
request. Note this covers Houston-mediated egress; a raw `curl` inside
`run_shell` is bounded by the shell-network consent above, not by masking.

## GitHub tools

When the `gh` CLI is installed and authenticated, Houston offers dedicated tools
for the GitHub loop: pull requests (`gh_pr_create`, `gh_pr_list`, `gh_pr_view`,
`gh_pr_comment`, `gh_pr_checkout`, `gh_pr_checks`), issues (`gh_issue_list`,
`gh_issue_view`, `gh_issue_create`, `gh_issue_comment`), CI runs (`gh_run_list`,
`gh_run_view`), and repositories (`gh_repo_create`). They drive the user's local
`gh`, so no token is stored in the app. Each call is network-gated (always
prompts for approval) and the mutating ones are refused in plan mode. Because
these run `gh` outside the shell sandbox, they reach the network on approval,
unlike a raw `gh` in `run_shell`. If `gh` is not installed, these tools simply
are not offered and everything else still works.

## Project rules

Houston folds a small rules hierarchy into the system prompt each run: the global
`~/.claude/CLAUDE.md` first, then the project's own `AGENTS.md` / `CLAUDE.md` at
its root, then any `AGENTS.md` / `CLAUDE.md` in subdirectories (shallowest
first). Any rules file can pull in others with `@path` imports. These set coding
conventions, build/test commands, and house style; Houston treats them as
conventions, not as authority to change tool or permission behavior.

## Context, worktrees, and history

- **Compaction.** When a conversation grows too large, Houston summarizes the
  older turns so it never overflows the context window. The threshold is sized
  automatically from the selected model's context window (a large-window model
  compacts later, a small local model sooner), and the summary is saved with the
  conversation so later turns extend it instead of re-summarizing from scratch.
  The full transcript stays on screen; only what is sent to the model is
  compacted. Set a fixed token threshold or disable it in Settings, *Context
  window*.
- **Worktrees.** In a git repo, a new chat defaults to running in a fresh,
  isolated worktree on its own branch under `.houston/worktrees/`, so the agent's
  edits never touch the current checkout. Untick *New worktree* to work in the
  repo directly.
- **Conversations** are saved per project folder. Chats can be exported/imported
  as JSON, exported as self-contained HTML, searched, and forked.
- **Undo a turn's file changes.** Before the agent edits a file, Houston
  snapshots it, so the latest turn's changes can be reverted with one click (and
  re-applied after a revert). This covers every file-editing tool, including
  multi-file patches (adds, updates, deletes, and moves) and edits made by a
  writable subagent the turn dispatched. Checkpoints persist on disk in your
  Houston profile, so the revert/redo affordance survives an app restart; the
  most recent 50 turns' checkpoints are kept. Shell-command side effects are not
  checkpointed: revert only restores files the editing tools touched.

## Settings and keys

Settings covers providers and keys, web search, approval mode and permission
rules, hooks, MCP servers, additional folders, context threshold, appearance
(theme, notifications), and optional integrations (`gh`, formatters). API keys
are encrypted with the OS keychain and stay in the main process.
