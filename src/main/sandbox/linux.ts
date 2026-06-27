import type { SandboxBackend, ShellLaunch } from './contract'

/**
 * Linux bubblewrap backend — STUB.
 *
 * The real bubblewrap (`bwrap`) implementation lands in the next phase of the
 * cross-platform sandbox work: it mirrors the Seatbelt contract with `--ro-bind`
 * for read-everywhere, per-root `--bind` for the writable set, a network namespace
 * gated on `allowNetwork`, and `--die-with-parent` so the tree dies with the parent.
 *
 * Until then `selectBackend` never picks this backend (`sandboxAvailable` returns
 * false on Linux), and `buildLaunch` throws so accidental use is loud rather than
 * silently unconfined.
 */
export const BubblewrapBackend: SandboxBackend = {
  id: 'bubblewrap',
  sandboxed: true,
  confinesNetwork: true,
  buildLaunch(): ShellLaunch {
    throw new Error('bubblewrap backend not implemented yet')
  }
}
