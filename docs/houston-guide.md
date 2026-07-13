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
by the OS keychain and never touch the renderer.

## Slash commands

Type `/` in the composer for the command menu. The exact set depends on the
client, but the common built-ins are:

- `/new` (alias `/clear`): start a fresh conversation.
- `/compact`: summarize older turns now to free up context (desktop).
- `/plan`, `/ask`, `/auto`, `/full`: switch the approval mode (desktop; the
  interactive terminal uses `/approval` to do the same).
- `/review`: run an adversarial review of your uncommitted changes and fix what
  it confirms.
- `/skills`, `/agents`: list the workspace's skills and custom agents.
- `/help`: list the available commands.

The interactive terminal adds terminal-specific commands such as `/model` (list
or switch model), `/approval`, `/resume`, `/fork`, `/cost`, `/mcp`, `/hooks`,
`/theme`, `/image`, `/cwd`, and `/exit`.

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
- **Full auto:** edits and (sandboxed) commands run without asking.

On any single tool call the user can approve once, deny, **allow for the run**
(auto-approve that kind of tool for the rest of the conversation), or **always
allow / always deny** (saves a permission rule so the choice persists). File
edits show an inline red/green diff before approval.

**Permission rules** (Settings) are finer-grained than the mode: `allow`,
`deny`, or `ask`, matched on the tool plus a glob over its target, e.g. allow
`run_shell` matching `git *`, deny anything matching `*rm -rf*`, always ask
before `write_file` under `src/secret/**`. Rules are checked before the mode and
the first match wins.

**Project guardrails.** A repo can ship a `.houston/settings.json` with its own
`deny` / `ask` rules, checked before the user's global rules. A project file can
only *tighten*: it cannot add `allow` rules, hooks, or MCP servers, so cloning an
untrusted repo can never auto-approve actions.

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
`tools:` list narrows which tools it may use. By default a subagent is read-only
(it cannot edit, run commands, or reach the network); a subagent marked
`write: true` gets a writable tier and is dispatched with `dispatch_writable_agent`,
which is approval-gated because it grants write access. Tokens a subagent spends
roll into the conversation's usage meter.

## Spawn separate sessions (desktop)

Where a subagent reports back into the current turn, `spawn_session` spins off a
*separate* chat: the agent hands it a task, optionally on its own git branch and
worktree, and sets it running in the background. It appears in the sidebar with a
live indicator, seeded with the handed-off context. A spawned session inherits
the current approval policy, so it is never more permissive than the chat that
spawned it.

## Review and multi-step tools

- **`review_changes` (or `/review`)** reviews uncommitted changes for
  correctness, security, and quality. It runs an independent read-only reviewer
  per dimension, each in a fresh context, then a skeptical verifier that
  re-checks every candidate against the real code and drops false positives, and
  reports the confirmed findings. Scope it to a `base` branch or specific
  `paths`, and raise `effort` to `high` to verify each finding with several
  independent skeptics.
- **`todo_write`** keeps a task list for multi-step work, rendered live in the
  transcript.
- **`pr_sweep`** tracks batch pull-request work (author new PRs from a task list,
  or process a batch of existing open PRs).

## Hooks

Hooks (Settings, *Hooks*) run your own shell commands around tool calls:

- A **PreToolUse** hook can *block* a call by exiting non-zero.
- A **PostToolUse** hook's output is fed back to the agent (e.g. auto-format
  after every edit, or run tests after a write).

Hooks run in the same project sandbox as `run_shell`. The call's context is
provided in `$HOUSTON_TOOL_NAME` and `$HOUSTON_TOOL_INPUT`.

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
a remote **HTTP** (streamable) or **SSE** endpoint, with optional bearer-token or
custom auth headers. Their tools are offered to the agent namespaced as
`mcp__<id>__<tool>` and always require approval. When many MCP tools are
connected, Houston loads their schemas lazily: above a threshold the agent gets a
compact catalog plus a `find_tools` meta-tool and pulls in only the tool
definitions it needs, instead of sending every schema on every request.

## Shell sandbox and network

Shell commands run under the host OS sandbox where one exists, confined to the
project directory: writes outside the project are blocked, and network access is
off by default.

- **macOS:** Seatbelt (`sandbox-exec`).
- **Linux:** bubblewrap (an unprivileged user namespace), when available.
- **Windows:** no broadly-available equivalent, so shell commands run unconfined;
  Houston reports them as not sandboxed and never silently auto-approves one.

The structured file tools stay confined to the project on every platform.
Network from `run_shell` is *gated*, not permanently off: it is enabled in full
auto, or when the user picks "Allow for run" on an approval. So a command that
needs the network (cloning, installing dependencies, `gh`, `curl`) is not
impossible, it just needs that grant. Package-manager caches (npm, pip, yarn) are
auto-redirected to a writable temp dir, so dependency installs need no cache
workaround once network is on. **Additional folders** (Settings) can be added to
the file tools' allowed roots and the shell sandbox to work across more than one
repo.

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

- **Compaction.** When a conversation grows past a configurable token threshold,
  Houston summarizes the older turns so it never overflows the context window.
  The full transcript stays on screen; only what is sent to the model is
  compacted. Tune or disable it in Settings, *Context window*.
- **Worktrees.** In a git repo, a new chat defaults to running in a fresh,
  isolated worktree on its own branch under `.houston/worktrees/`, so the agent's
  edits never touch the current checkout. Untick *New worktree* to work in the
  repo directly.
- **Conversations** are saved per project folder. Chats can be exported/imported
  as JSON, exported as self-contained HTML, searched, and forked.

## Settings and keys

Settings covers providers and keys, web search, approval mode and permission
rules, hooks, MCP servers, additional folders, context threshold, appearance
(theme, notifications), and optional integrations (`gh`, formatters). API keys
are encrypted with the OS keychain and stay in the main process.
