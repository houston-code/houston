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
