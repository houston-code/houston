# Sandboxing

Houston runs agent shell commands (`run_shell`) under the host OS's sandbox where a
suitable one exists, confined to the project directory: writes outside the project and
(by default) network access are blocked. The backend is chosen once at startup and
reports an **honest** `sandboxed` flag: the approval flow and the UI never claim
confinement that isn't there.

| Platform | Backend | Confined? | Mechanism |
|----------|---------|-----------|-----------|
| macOS | Seatbelt | Yes | `sandbox-exec` with a generated profile |
| Linux | bubblewrap | Yes (when `bwrap` is usable) | unprivileged user namespace |
| Windows | none | **No** | runs unconfined; consent-gated (see below) |

Code: [`src/main/sandbox/`](../src/main/sandbox/): `select.ts` (backend choice + honest
probe), `darwin.ts` (Seatbelt), `linux.ts` (bubblewrap), `windows.ts`, `unsandboxed.ts`.

## What we actually need

The macOS and Linux backends give us one specific primitive:

> Run an **arbitrary** child process; let it **read** essentially everything (so the
> toolchain, meaning compilers, `git`, package managers, and interpreters, works), but **deny
> writes** outside the project directory and **deny network** by default.

It is path-scoped, write-oriented, per-process, needs no admin, and is cheap to set up
per command. Seatbelt and bubblewrap both provide exactly that.

What it does not protect is the project itself: a confined command can still reset,
clean, or delete files inside it, and shell side effects aren't checkpointed. That gap
is closed at the approval layer instead. A command that can throw away work there
(`git reset --hard`, a forced `git clean`, `rm -r` of source, a forced or deleting
push; `shellDiscardsWork` in
[`src/main/agent/permissions.ts`](../src/main/agent/permissions.ts)) asks in every
mode, full auto included, which is what lets a new install start in full auto where
one of these backends is active.

A command may also signal the processes it started (children and grandchildren), because
build tools stop their own workers: Next.js, webpack, and jest-worker fail with
`kill EPERM` otherwise. It may not signal anything outside its own sandbox: not the
host's processes and not another `run_shell` command's. Seatbelt scopes this with
`(allow signal (target same-sandbox))`, where each `sandbox-exec` launch is its own
sandbox; bubblewrap gets it from `--unshare-pid`, which hides every other process.
Conformance tests C5b and C2b pin both halves.

The command's PATH is the inherited one plus, when they exist on disk, the bin dirs of
per-user runtime managers (nvm's default Node, fnm, Volta, mise, asdf, pyenv, rbenv,
rustup/cargo, Go, Bun, Deno) and Homebrew (`augmentPath` in `shared.ts`). A
GUI-launched app never sources shell startup files, so without them an installed
runtime looks missing. Windows has no
broadly-available primitive with the same shape, which is why its backend runs
unconfined. The rest of this document records *why* the obvious Windows candidates were
rejected, so the decision isn't re-litigated from scratch.

## Git hooks and settings (all backends)

Each workspace root is writable, `.git` included, and that is deliberate: `git commit`,
`git config`, `git push -u`, `git remote add`, husky's `prepare` script, `pre-commit
install`, and submodule setup all write there. But a few things in a repository's git
data are commands git runs on its own: hooks, `core.fsmonitor` (run by every
`git status`), filter, diff, and merge drivers, `core.sshCommand`, aliases, includes,
and the `commondir` file that points git at another directory's config. A confined
command can write those, and the user's own git, or a shell prompt that calls
`git status` on every `cd`, later runs them **outside** the sandbox. None of it shows in
`git status` or a diff, and none of it is checkpointed. (Houston's own host-side git is
hardened against every one of these; see `hardenedGitArgs` in
[`src/main/agent/gitRead.ts`](../src/main/agent/gitRead.ts).)

### What Houston does

**Detect after each command, ask, and undo on request**
([`src/main/agent/gitGuard.ts`](../src/main/agent/gitGuard.ts)). Before the run's first
shell command Houston snapshots, for each root: the hooks directory (by content hash
and mode, ignoring `*.sample`), the exec-capable keys in the repository's own config
files (`config`, every `config.worktree`, one level of `include.path`), every
`commondir`, the `.git` pointer file, and the same for each nested repository the index
records as a submodule, since the root's `git status` recurses into those and runs
their fsmonitor. For a linked worktree that covers the shared common dir, the other
worktrees' redirects, and the main checkout's index too, because the sandbox makes the
common dir writable (see `gitWritableRoots`). After each foreground `run_shell` (and
when a background shell's output is read or it is stopped), it compares again:

- Settings that run nothing (`user.*`, remotes, upstreams, `core.fsmonitor=true`, which
  selects git's built-in daemon) are never reported.
- `core.hooksPath` set to husky's folder is noted in the result, not asked about: those
  hooks are checked in and visible.
- Anything else exec-capable pauses the run with a question listing each change. Undo
  restores exactly those items (a key's previous values, a hook's previous bytes and
  mode, or no file at all) and leaves unrelated changes from the same command alone;
  Keep makes the new state the baseline and the result names the commands to remove it
  by hand. With nobody to ask (headless) it undoes.

Cost: a snapshot of an unchanged repository is a handful of `stat`s and small reads.
git runs only to parse a config file whose bytes changed (`git config --file`, outside
any repository, which runs nothing) or to list submodule entries when the index changed
(through the hardened runner).

Separately, the file tools treat `.git/hooks/…`, `.git/config`, `config.worktree`,
`commondir`, and a `.git` pointer file as sensitive writes (`isGitExecPath` in
[`src/main/agent/sensitive-paths.ts`](../src/main/agent/sensitive-paths.ts)), so they ask
even in full auto.

### Options weighed

| | Stops it beforehand | Breaks ordinary git | Covers |
|---|---|---|---|
| **A.** Sandbox deny on `.git/config`, `hooks/`, `commondir`, `.git` itself | Yes | Yes: `git config`, `remote add`, `branch --set-upstream-to`, husky `prepare`, `pre-commit install`, submodule init fail; `push -u` silently drops the upstream | Not a nested repository registered as a submodule (verified bypass); on Linux, bubblewrap can only make existing files read-only, so a new `commondir` can't be blocked |
| **B.** Detect after each command (chosen) | No: reports right after | No | Everything above, the same on every platform |
| **C.** File tools ask for git exec paths (chosen, alongside B) | Yes, for file tools only | No | Not shell commands |

A was measured on macOS (commit, checkout, push, fetch, tag, stash, gc, and
`worktree add` kept working; everything that writes config failed) and rejected for
breaking routine setup. It could come back as an opt-in strict mode.

### What remains

- **The window.** Detection happens when the command finishes. Something else that
  runs git in the repository in between (a shell prompt in another terminal) runs what
  was planted before the question appears.
- **Background shells** are checked when their output is read or they are stopped, so
  a change one makes after the run's last such call isn't reported.
- **Untracked nested repositories** aren't inspected: git doesn't enter them on its own,
  only when the user `cd`s into one, which is the same trust as running any other code
  the agent wrote.
- **Hooks outside `.git`** (a `core.hooksPath` folder in the project) are project
  files: they show up in `git status` unless ignored, and run only on commit or push.

## Language servers

Language servers (see the guide's *Code intelligence* section) are long-running
processes launched through the same backend as background shell commands, with the
network off and writes confined to the roots, the posture the post-edit checkers in
`diagnostics.ts` already had. A server can execute project code (TypeScript plugins
from `tsconfig.json`, Rust build scripts and proc macros), and unlike a shell command
it starts without an approval prompt, so on a host whose backend does not confine
(`isSandboxed()` false) servers do not start unless the user sets them to run
unconfined explicitly. Under the Windows `cmd.exe` fallback they never start, since a
path can't be quoted safely there. Two consequences of confinement: the client sends
`processId: null` in `initialize`, because servers poll the given pid with `kill(pid, 0)`
and the sandbox denies signals outside it (they would exit within seconds), and
Houston therefore stops servers itself (idle timeout, app quit, terminal-client exit).
A server's `workspace/applyEdit` request is always refused: edits reach disk only
through the agent's write tools and their approval gate.

A server only reads dependencies, and offline it can't fetch any, so the package-cache
redirects below would leave it Houston's cache, empty unless the agent downloaded into
it. Servers instead get the user's own Go module cache and Cargo home
([`depCaches.ts`](../src/main/agent/lsp/depCaches.ts)), which the sandbox lets them
read (reads are allowed everywhere) but not write (they're outside the roots), plus
`GOPROXY=off` and `CARGO_NET_OFFLINE=true` so a missing dependency fails at once.
Houston checks the project's `go.mod` or `Cargo.lock` against that cache to tell the
agent what's missing, since servers don't report it reliably.

## Environment sanitization (all backends)

The sandbox is a *filesystem/network* jail, not an environment one: a child can read
files essentially everywhere, and the process environment isn't a path it can be denied.
A GUI-launched Houston inherits the full environment of the shell that started it, which
routinely holds exported credentials (`AWS_*`, `GH_TOKEN`, assorted `*_API_KEY`s). So
before spawning any `run_shell` child (or an MCP stdio server, which is a third-party
process), Houston strips credential-bearing vars from the inherited environment
([`src/main/childEnv.ts`](../src/main/childEnv.ts), wired through
[`sandbox/shared.ts`](../src/main/sandbox/shared.ts) `sandboxEnv` and
[`mcp/client.ts`](../src/main/mcp/client.ts)). Without this, a prompt-injected command
with network could `env | curl` those secrets out, and a compromised MCP server would
receive them all on startup.

It's a **denylist** (drop names matching `/(_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL|_AUTH)/i`
plus the `AWS_` namespace and the GitHub tokens), not a strict allowlist, because the
sandbox runs an open-ended toolchain that reads an unpredictable tail of ordinary config
vars (`NODE_ENV`, `CI`, `DATABASE_URL`, proxies, …) that must survive. This is
defense-in-depth: Houston's own provider keys never travel through the environment (they
go via SDK constructor params), so it hardens the user's *ambient* shell secrets rather
than fixing an active leak. An MCP server that legitimately needs a token still receives
it: `McpServerConfig.env` is re-applied after the strip.

## Egress allowlisting (macOS + Linux)

Granting the sandbox "network" used to be all-or-nothing at the OS layer: once a run
had the shell-network grant, a prompt-injected `curl` could read any file the sandbox
can read (essentially everything) and POST it to any host. The egress allowlist closes
that per-domain, **without TLS interception**: granted network is routed through a
loopback HTTP proxy owned by the main process
([`src/main/sandbox/egress-proxy.ts`](../src/main/sandbox/egress-proxy.ts)), and the
OS sandbox denies every direct route out, so the proxy is the only egress path. HTTPS
arrives at the proxy as `CONNECT host:port` and plain HTTP as an absolute-form URI;
the hostname is visible either way, which is exactly the granularity a per-domain
allow/deny needs. Bodies stay opaque; no masking (MITM) proxy, no trust-store changes.

The policy ([`src/shared/egress.ts`](../src/shared/egress.ts), user-visible in
Settings → Permissions → Sandbox egress) is: deny entries win over every allow; user allow entries
extend a built-in allowlist of dev infrastructure (package registries, VCS hosts);
every entry covers its subdomains on label boundaries; anything else is refused with
an `EGRESS_BLOCKED` body that names the host. The proxy re-reads settings per request,
so adding a domain applies mid-run. Private/loopback/metadata IP *literals* are never
proxied: the proxy runs outside the sandbox and must not become an SSRF pivot with
more reach than the sandbox itself. Mode `all` (Settings) is the explicit escape hatch
back to unrestricted granted network.

Per-platform enforcement of "the proxy is the only road out":

- **macOS (Seatbelt):** the proxied profile allows outbound only to loopback
  (`(allow network-outbound (remote ip "localhost:*"))`), where the proxy listens;
  loopback bind/inbound stay allowed so dev servers keep working. DNS is cut
  explicitly: `getaddrinfo` resolves through the `com.apple.mDNSResponder` mach
  service (which lives outside the sandbox), so a socket-only restriction would
  leave a DNS-tunnel exfiltration channel open, so the profile *denies*
  the resolver mach services (`com.apple.mDNSResponder`, `com.apple.dnssd.service`)
  in the confined modes. `localhost` still resolves (via `/etc/hosts` / the numeric
  path, no daemon) and the proxy resolves public names for the toolchain, so
  nothing legitimate breaks. `HTTP(S)_PROXY` / `ALL_PROXY` in the command's env
  point the toolchain at the proxy; `NO_PROXY=localhost,…` keeps loopback traffic
  direct.
- **Linux (bubblewrap):** proxied mode KEEPS `--unshare-net` (the empty network
  namespace), so there is no route out at all, including to the host's loopback,
  where the proxy's TCP port lives. The bridge is a unix socket, which crosses the
  namespace via the temp-dir bind: a small forwarder (written by the proxy, run as
  the bwrap entrypoint under `ELECTRON_RUN_AS_NODE=1`) listens on a fixed inner
  loopback port, pipes each connection into the unix socket, and starts the real
  command only once the bridge is up. The `linux-sandbox` CI job exercises this chain
  for real (conformance tests C8a–C8d).
- **Windows / no-sandbox hosts:** cannot be enforced (no OS mechanism blocks direct
  sockets), so no proxy env is injected: advisory-only restriction would break
  commands without adding security. The existing posture holds: unconfined shell
  always requires explicit consent, even in full auto.

Failure is **closed**: if the proxy cannot start, the run's shell network stays off
rather than falling back to unrestricted egress.

Known residuals, accepted and documented: an allowlisted collaborative host (e.g.
github.com) still accepts authenticated writes, so exfiltration to *your own
reachable services* on allowed domains remains possible (authenticated, attributable,
and revocable, unlike arbitrary-domain egress); an allowlisted hostname that resolves
to a private IP is not re-checked at connect time (the proxy refuses private IP
*literals* only, unlike `web_fetch`, which vets and pins every address a name resolves
to); and SSH/raw-TCP protocols simply
don't traverse an HTTP proxy, so under the allowlist they are blocked, which is the
conservative direction (SSH is an uninspectable channel). On Linux, per-command
network namespaces mean a sandboxed dev server is only reachable within its own
command; users who need the old shared-namespace behavior can select mode `all`.

## Windows: why not AppContainer?

AppContainer is the closest Windows security primitive. A process runs under a token
carrying an AppContainer SID plus an explicit set of *capability* SIDs; it is
**deny-by-default**: it may touch a resource only if that resource's ACL grants the
AppContainer SID (or `ALL APPLICATION PACKAGES`) or a capability covers it.

That model is wrong for confining an arbitrary dev command:

- **The trust model is inverted.** We want "read-all, write-only-here." AppContainer is
  "touch-nothing, then grant." There is no native capability that expresses "writable
  project tree, read-only world." You would have to ACL-stamp the AppContainer SID onto
  every path and registry key the command needs, and for an *arbitrary* build command
  that set is effectively unbounded and changes per tool and per version (MSVC, Node,
  Git, Python, package caches, COM registrations, named pipes, `%TEMP%`,
  `%LOCALAPPDATA%`, …). Tools fail in non-obvious ways (broken named-object namespace,
  registry redirection) when a grant is missing. This is the "toolchain-hostile" point.
- **Making it work widens the writable set past the project.** Real toolchains write to
  temp/cache dirs outside the project, so to avoid breakage you would grant write access
  there too, at which point the "writes confined to the project" guarantee, the whole
  point, is gone.
- **It mutates persistent state.** Granting access means editing ACLs on the user's
  project tree (and creating an AppContainer profile), with no clean teardown: residue
  and surprising permission changes on their files.
- **It needs native code.** There is no `sandbox-exec`-style CLI; you drive it through
  Win32 (`CreateAppContainerProfile`, capability SID arrays, `STARTUPINFOEX` +
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`). From an Electron/Node app that means a
  native addon or helper executable, a real surface for a bring-your-own-model desktop
  app.
- **One genuine upside:** network is a capability, so "deny network by default" maps
  cleanly. That single axis is the only one AppContainer gets right for us.

AppContainer works well for **browser renderer sandboxes** because those sandbox a
*known, minimal* program and broker the few resources it needs through a broker process.
Our case is the opposite: we sandbox *whatever command the model decides to run*, which
needs a full, open-ended toolchain. AppContainer shines when you control and minimize
what the sandboxed code touches: the opposite of "run any build step."

## Windows: why not Windows Sandbox?

Windows Sandbox is a disposable Hyper-V-backed throwaway Windows desktop (`.wsb`
config). Wrong tool, for two independent reasons:

- **Availability.** Pro / Enterprise / Education only, **not on Windows Home**, so a
  broadly distributed app can't depend on it. It also needs hardware virtualization +
  Hyper-V enabled, and breaks under nested virtualization and in many CI/VM setups.
- **Granularity.** It is a *whole clean OS*, not a per-command jail. Each instance boots
  a fresh Windows with **no toolchain installed**, so you'd reprovision the entire dev
  environment on every run, with seconds of boot latency and hundreds of MB of RAM per
  invocation. It is desktop isolation, not a fast write-jail.

## Other Windows options (and why not)

- **Job Objects** scope process *lifecycle* and resource limits (kill-tree,
  memory/CPU caps), **not** filesystem paths. Useful for teardown; useless for write
  confinement.
- **Restricted tokens / Low Integrity Level** are coarse privilege-dropping. Low-IL blocks
  writes to medium-IL objects (most of the filesystem) but *also* blocks the project dir
  unless you re-ACL it, and breaks tools that expect a normal `%TEMP%`. Closer in spirit,
  still toolchain-hostile and not project-scoped.
- **A filesystem minifilter driver** (what dedicated third-party kernel-driver sandbox
  products do) could do true path-scoped redirect/deny, but requires a **signed kernel
  driver + admin install**, a large security and maintenance surface, out of scope for
  this app.
- **WSL2 / a Linux container** is a Linux VM with a translated filesystem; it edits
  Linux-side files, not the Windows project the user opened. The Windows backend
  deliberately avoids the WSL `bash.exe` shim for exactly this reason
  ([`windows.ts`](../src/main/sandbox/windows.ts), `resolveWindowsBash`).

## What Windows does instead: unconfined but honest

Because no low-friction, broadly-available, path-scoped write-confinement primitive
exists on Windows, `run_shell` there runs **unconfined**, and the design is honest about
it ([`src/main/sandbox/windows.ts`](../src/main/sandbox/windows.ts),
[`select.ts`](../src/main/sandbox/select.ts)):

- the backend reports `sandboxed: false`;
- the approval gate **never silently auto-approves** an unconfined shell command: each one
  asks **even in full-auto** until you grant per-run consent ("Allow for run" on such a
  prompt)
  ([`src/main/agent/approval.ts`](../src/main/agent/approval.ts));
- the structured file tools' JS-level path containment still holds on **every** OS, so
  `write_file` / `edit_file` / `apply_patch` stay confined to the project regardless of
  the shell backend.

So the behavior degrades to "you are told it isn't jailed, and you must consent,"
rather than pretending to confine.

## If real Windows confinement were ever wanted

The only *practical* path is an **opt-in, experimental AppContainer mode** with a
curated writable set (project + temp), explicitly accepting that some toolchains will
break inside it, a power-user tradeoff, not the default. The driver-based and VM-based
routes are not viable for a consumer-distributed app. This is a deliberate non-goal
today, not a pending TODO.
