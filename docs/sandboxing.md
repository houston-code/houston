# Sandboxing

Houston runs agent shell commands (`run_shell`) under the host OS's sandbox where a
suitable one exists, confined to the project directory: writes outside the project and
(by default) network access are blocked. The backend is chosen once at startup and
reports an **honest** `sandboxed` flag — the approval flow and the UI never claim
confinement that isn't there.

| Platform | Backend | Confined? | Mechanism |
|----------|---------|-----------|-----------|
| macOS | Seatbelt | Yes | `sandbox-exec` with a generated profile |
| Linux | bubblewrap | Yes (when `bwrap` is usable) | unprivileged user namespace |
| Windows | — | **No** | runs unconfined; consent-gated (see below) |

Code: [`src/main/sandbox/`](../src/main/sandbox/) — `select.ts` (backend choice + honest
probe), `darwin.ts` (Seatbelt), `linux.ts` (bubblewrap), `windows.ts`, `unsandboxed.ts`.

## What we actually need

The macOS and Linux backends give us one specific primitive:

> Run an **arbitrary** child process; let it **read** essentially everything (so the
> toolchain — compilers, `git`, package managers, interpreters — works), but **deny
> writes** outside the project directory and **deny network** by default.

It is path-scoped, write-oriented, per-process, needs no admin, and is cheap to set up
per command. Seatbelt and bubblewrap both provide exactly that. Windows has no
broadly-available primitive with the same shape, which is why its backend runs
unconfined. The rest of this document records *why* the obvious Windows candidates were
rejected, so the decision isn't re-litigated from scratch.

## Environment sanitization (all backends)

The sandbox is a *filesystem/network* jail, not an environment one — a child can read
files essentially everywhere, and the process environment isn't a path it can be denied.
A GUI-launched Houston inherits the full environment of the shell that started it, which
routinely holds exported credentials (`AWS_*`, `GH_TOKEN`, assorted `*_API_KEY`s). So
before spawning any `run_shell` child — or an MCP stdio server, which is a third-party
process — Houston strips credential-bearing vars from the inherited environment
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
it — `McpServerConfig.env` is re-applied after the strip.

## Egress allowlisting (macOS + Linux)

Granting the sandbox "network" used to be all-or-nothing at the OS layer: once a run
had the shell-network grant, a prompt-injected `curl` could read any file the sandbox
can read (essentially everything) and POST it to any host. The egress allowlist closes
that per-domain, **without TLS interception**: granted network is routed through a
loopback HTTP proxy owned by the main process
([`src/main/sandbox/egress-proxy.ts`](../src/main/sandbox/egress-proxy.ts)), and the
OS sandbox denies every direct route out, so the proxy is the only egress path. HTTPS
arrives at the proxy as `CONNECT host:port` and plain HTTP as an absolute-form URI —
the hostname is visible either way, which is exactly the granularity a per-domain
allow/deny needs. Bodies stay opaque; no masking (MITM) proxy, no trust-store changes.

The policy ([`src/shared/egress.ts`](../src/shared/egress.ts), user-visible in
Settings → Sandbox egress) is: deny entries win over every allow; user allow entries
extend a built-in allowlist of dev infrastructure (package registries, VCS hosts);
every entry covers its subdomains on label boundaries; anything else is refused with
an `EGRESS_BLOCKED` body that names the host. The proxy re-reads settings per request,
so adding a domain applies mid-run. Private/loopback/metadata IP *literals* are never
proxied — the proxy runs outside the sandbox and must not become an SSRF pivot with
more reach than the sandbox itself. Mode `all` (Settings) is the explicit escape hatch
back to unrestricted granted network.

Per-platform enforcement of "the proxy is the only road out":

- **macOS (Seatbelt):** the proxied profile allows outbound only to loopback
  (`(allow network-outbound (remote ip "localhost:*"))`), where the proxy listens;
  loopback bind/inbound stay allowed so dev servers keep working. DNS is cut
  explicitly: `getaddrinfo` resolves through the `com.apple.mDNSResponder` mach
  service (which lives outside the sandbox), so a socket-only restriction would
  leave a DNS-tunnel exfiltration channel open — the profile therefore *denies*
  the resolver mach services (`com.apple.mDNSResponder`, `com.apple.dnssd.service`)
  in the confined modes. `localhost` still resolves (via `/etc/hosts` / the numeric
  path, no daemon) and the proxy resolves public names for the toolchain, so
  nothing legitimate breaks. `HTTP(S)_PROXY` / `ALL_PROXY` in the command's env
  point the toolchain at the proxy; `NO_PROXY=localhost,…` keeps loopback traffic
  direct.
- **Linux (bubblewrap):** proxied mode KEEPS `--unshare-net` (the empty network
  namespace), so there is no route out at all — including to the host's loopback,
  where the proxy's TCP port lives. The bridge is a unix socket, which crosses the
  namespace via the temp-dir bind: a small forwarder (written by the proxy, run as
  the bwrap entrypoint under `ELECTRON_RUN_AS_NODE=1`) listens on a fixed inner
  loopback port, pipes each connection into the unix socket, and starts the real
  command only once the bridge is up. The `linux-sandbox` CI job exercises this chain
  for real (conformance tests C8a–C8d).
- **Windows / no-sandbox hosts:** cannot be enforced (no OS mechanism blocks direct
  sockets), so no proxy env is injected — advisory-only restriction would break
  commands without adding security. The existing posture holds: unconfined shell
  always requires explicit consent, even in full auto.

Failure is **closed**: if the proxy cannot start, the run's shell network stays off
rather than falling back to unrestricted egress.

Known residuals, accepted and documented: an allowlisted collaborative host (e.g.
github.com) still accepts authenticated writes, so exfiltration to *your own
reachable services* on allowed domains remains possible — authenticated, attributable,
and revocable, unlike arbitrary-domain egress; an allowlisted hostname that resolves
to a private IP is not re-checked at connect time (same literal-only stance as
`web_fetch`, see the DNS-rebinding roadmap item); and SSH/raw-TCP protocols simply
don't traverse an HTTP proxy — under the allowlist they are blocked, which is the
conservative direction (SSH is an uninspectable channel). On Linux, per-command
network namespaces mean a sandboxed dev server is only reachable within its own
command; users who need the old shared-namespace behavior can select mode `all`.

## Windows: why not AppContainer?

AppContainer is the closest Windows security primitive. A process runs under a token
carrying an AppContainer SID plus an explicit set of *capability* SIDs; it is
**deny-by-default** — it may touch a resource only if that resource's ACL grants the
AppContainer SID (or `ALL APPLICATION PACKAGES`) or a capability covers it.

That model is wrong for confining an arbitrary dev command:

- **The trust model is inverted.** We want "read-all, write-only-here." AppContainer is
  "touch-nothing, then grant." There is no native capability that expresses "writable
  project tree, read-only world." You would have to ACL-stamp the AppContainer SID onto
  every path and registry key the command needs — and for an *arbitrary* build command
  that set is effectively unbounded and changes per tool and per version (MSVC, Node,
  Git, Python, package caches, COM registrations, named pipes, `%TEMP%`,
  `%LOCALAPPDATA%`, …). Tools fail in non-obvious ways (broken named-object namespace,
  registry redirection) when a grant is missing. This is the "toolchain-hostile" point.
- **Making it work widens the writable set past the project.** Real toolchains write to
  temp/cache dirs outside the project, so to avoid breakage you would grant write access
  there too — at which point the "writes confined to the project" guarantee, the whole
  point, is gone.
- **It mutates persistent state.** Granting access means editing ACLs on the user's
  project tree (and creating an AppContainer profile), with no clean teardown — residue
  and surprising permission changes on their files.
- **It needs native code.** There is no `sandbox-exec`-style CLI; you drive it through
  Win32 (`CreateAppContainerProfile`, capability SID arrays, `STARTUPINFOEX` +
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`). From an Electron/Node app that means a
  native addon or helper executable — a real surface for a bring-your-own-model desktop
  app.
- **One genuine upside:** network is a capability, so "deny network by default" maps
  cleanly. That single axis is the only one AppContainer gets right for us.

AppContainer works well for **browser renderer sandboxes** because those sandbox a
*known, minimal* program and broker the few resources it needs through a broker process.
Our case is the opposite: we sandbox *whatever command the model decides to run*, which
needs a full, open-ended toolchain. AppContainer shines when you control and minimize
what the sandboxed code touches — the opposite of "run any build step."

## Windows: why not Windows Sandbox?

Windows Sandbox is a disposable Hyper-V-backed throwaway Windows desktop (`.wsb`
config). Wrong tool, for two independent reasons:

- **Availability.** Pro / Enterprise / Education only — **not on Windows Home**, so a
  broadly distributed app can't depend on it. It also needs hardware virtualization +
  Hyper-V enabled, and breaks under nested virtualization and in many CI/VM setups.
- **Granularity.** It is a *whole clean OS*, not a per-command jail. Each instance boots
  a fresh Windows with **no toolchain installed**, so you'd reprovision the entire dev
  environment on every run, with seconds of boot latency and hundreds of MB of RAM per
  invocation. It is desktop isolation, not a fast write-jail.

## Other Windows options (and why not)

- **Job Objects** — scope process *lifecycle* and resource limits (kill-tree,
  memory/CPU caps), **not** filesystem paths. Useful for teardown; useless for write
  confinement.
- **Restricted tokens / Low Integrity Level** — coarse privilege-dropping. Low-IL blocks
  writes to medium-IL objects (most of the filesystem) but *also* blocks the project dir
  unless you re-ACL it, and breaks tools that expect a normal `%TEMP%`. Closer in spirit,
  still toolchain-hostile and not project-scoped.
- **A filesystem minifilter driver** (what dedicated third-party kernel-driver sandbox
  products do) could do true path-scoped redirect/deny, but requires a **signed kernel
  driver + admin install** — a large security and maintenance surface, out of scope for
  this app.
- **WSL2 / a Linux container** — a Linux VM with a translated filesystem; it edits
  Linux-side files, not the Windows project the user opened. The Windows backend
  deliberately avoids the WSL `bash.exe` shim for exactly this reason
  ([`windows.ts`](../src/main/sandbox/windows.ts), `resolveWindowsBash`).

## What Windows does instead — unconfined but honest

Because no low-friction, broadly-available, path-scoped write-confinement primitive
exists on Windows, `run_shell` there runs **unconfined**, and the design is honest about
it ([`src/main/sandbox/windows.ts`](../src/main/sandbox/windows.ts),
[`select.ts`](../src/main/sandbox/select.ts)):

- the backend reports `sandboxed: false`;
- the approval gate **never silently auto-approves** an unconfined shell command — it
  requires explicit per-run consent **even in full-auto**
  ([`src/main/agent/approval.ts`](../src/main/agent/approval.ts));
- the structured file tools' JS-level path containment still holds on **every** OS, so
  `write_file` / `edit_file` / `apply_patch` stay confined to the project regardless of
  the shell backend.

So the behavior degrades to "you are told it isn't jailed, and you must consent,"
rather than pretending to confine.

## If real Windows confinement were ever wanted

The only *practical* path is an **opt-in, experimental AppContainer mode** with a
curated writable set (project + temp), explicitly accepting that some toolchains will
break inside it — a power-user tradeoff, not the default. The driver-based and VM-based
routes are not viable for a consumer-distributed app. This is a deliberate non-goal
today, not a pending TODO.
