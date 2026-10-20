import { existsSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import type { PlanPayload } from '@shared/agent'
import { planVerifySteps, type PlanReadiness, type ReadinessItem } from '@shared/planReadiness'
import { resolveBinaryPath } from './format'

/**
 * Work out whether a presented plan's checks can run on this machine (see
 * @shared/planReadiness). Everything here is a PATH lookup, a file-existence check,
 * or a fact the run already holds: it never runs a command, so it needs no approval
 * and costs nothing.
 */

export type Ecosystem = 'node' | 'python' | 'go' | 'rust'

/** Whether shell commands can reach the network this run, and if not, why. */
export type ShellNetworkState =
  /** Granted for the run. */
  | 'granted'
  /** No sandbox gates the network on this host: commands have it. */
  | 'ungated'
  /** Not granted yet: the first command that needs it can be allowed for the run. */
  | 'ask'
  /** The user declined it for this run. */
  | 'declined'
  /** A headless run with no one to grant it (and no --allow-shell-network). */
  | 'unattended'

/** Whether view_localhost can check a web UI in this client on this host. */
export type BrowserState = 'ok' | 'unavailable' | 'isolated'

/** The machine facts a plan's readiness depends on, gathered by {@link gatherReadinessFacts}. */
export interface ReadinessFacts {
  /** Each ecosystem the plan touches, with the manifests (dependency lists) it involves. */
  ecosystems: Map<Ecosystem, { manifests: { path: string; installed: boolean; planned: boolean }[] }>
  /** Whether each touched ecosystem's runtime is on PATH. */
  runtimes: Map<Ecosystem, boolean>
  network: ShellNetworkState
  /** Set when a verification step looks like a browser check. */
  browser?: BrowserState
}

const MANIFESTS: Record<string, Ecosystem> = {
  'package.json': 'node',
  'requirements.txt': 'python',
  'requirements-dev.txt': 'python',
  'pyproject.toml': 'python',
  Pipfile: 'python',
  'setup.py': 'python',
  'go.mod': 'go',
  'Cargo.toml': 'rust'
}

const RUNTIME_BINS: Record<Ecosystem, string[]> = {
  node: ['node'],
  python: ['python3', 'python'],
  go: ['go'],
  rust: ['cargo']
}

const RUNTIME_LABEL: Record<Ecosystem, string> = { node: 'Node.js', python: 'Python', go: 'Go', rust: 'Rust' }

const PACKAGES_LABEL: Record<Ecosystem, string> = {
  node: 'npm packages',
  python: 'Python packages',
  go: 'Go modules',
  rust: 'Rust crates'
}

/** Ecosystems a verification step names by its tools ("pytest", "npm test", "cargo test"). */
const STEP_ECOSYSTEM: Array<[RegExp, Ecosystem]> = [
  [/\b(pytest|python3?|pip3?|django|flask|uvicorn|unittest)\b/i, 'python'],
  [/\b(npm|npx|node|yarn|pnpm|vitest|jest|mocha|vite|next|tsc)\b/i, 'node'],
  [/\bgo (test|build|vet|run)\b/i, 'go'],
  [/\bcargo\b/i, 'rust']
]

/** A step that checks a web UI in a browser. */
const BROWSER_STEP = /\b(view_localhost|browser|in the ui|on the page|screenshot|click|playwright)\b/i

/** Whether a manifest's dependencies look installed, by the directory its tool installs into. */
function depsInstalled(workspace: string, manifest: string, eco: Ecosystem): boolean {
  const dir = join(workspace, dirname(manifest))
  switch (eco) {
    case 'node':
      return existsSync(join(dir, 'node_modules'))
    case 'python':
      // Packages may also live in the user's site-packages; a project venv is the
      // signal that can be seen without running Python.
      return ['.venv', 'venv', 'env'].some((v) => existsSync(join(dir, v)) || existsSync(join(workspace, v)))
    case 'go':
    case 'rust':
      // Their toolchains fetch into a shared cache on first build; whether it is
      // warm can't be told from the project, so assume a fetch is needed.
      return false
  }
}

/** Gather the facts for {@link planReadiness}. Reads only PATH and the file system. */
export function gatherReadinessFacts(
  workspace: string,
  plan: Pick<PlanPayload, 'files' | 'verify' | 'body'>,
  opts: { network: ShellNetworkState; browser: BrowserState; hasBinary?: (bin: string) => boolean }
): ReadinessFacts {
  const hasBinary = opts.hasBinary ?? ((bin: string) => resolveBinaryPath(bin) !== null)
  const ecosystems: ReadinessFacts['ecosystems'] = new Map()
  const addManifest = (path: string, planned: boolean): void => {
    const eco = MANIFESTS[posix.basename(path.replace(/\\/g, '/'))]
    if (!eco) return
    const entry = ecosystems.get(eco) ?? { manifests: [] }
    if (!entry.manifests.some((m) => m.path === path)) {
      entry.manifests.push({ path, planned, installed: !planned && depsInstalled(workspace, path, eco) })
    }
    ecosystems.set(eco, entry)
  }
  // Manifests the plan will write, then existing ones beside the files it touches
  // and at the root: those are the dependency lists its checks would run against.
  const files = (plan.files ?? []).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''))
  for (const f of files) if (MANIFESTS[posix.basename(f)]) addManifest(f, !existsSync(join(workspace, f)))
  const dirs = new Set(['.', ...files.map((f) => f.split('/')[0]).filter((d) => d && !d.includes('.'))])
  for (const dir of dirs) {
    for (const name of Object.keys(MANIFESTS)) {
      const path = dir === '.' ? name : `${dir}/${name}`
      if (existsSync(join(workspace, path))) addManifest(path, false)
    }
  }
  const steps = planVerifySteps(plan)
  for (const step of steps) {
    for (const [re, eco] of STEP_ECOSYSTEM) {
      if (re.test(step) && !ecosystems.has(eco)) ecosystems.set(eco, { manifests: [] })
    }
  }
  const runtimes = new Map<Ecosystem, boolean>()
  for (const eco of ecosystems.keys()) runtimes.set(eco, RUNTIME_BINS[eco].some(hasBinary))
  const browser = steps.some((s) => BROWSER_STEP.test(s)) ? opts.browser : undefined
  return { ecosystems, runtimes, network: opts.network, ...(browser ? { browser } : {}) }
}

const NETWORK_BLOCKER: Record<Exclude<ShellNetworkState, 'granted' | 'ungated'>, string> = {
  ask: 'Shell commands run offline until you choose "Allow for run" on one, so choose it on the install command.',
  declined: 'Network for shell commands was declined for this run.',
  unattended: 'This headless run has no network for shell commands; run it with --allow-shell-network.'
}

/** What the plan's checks need and whether this machine has it. Pure. */
export function planReadiness(facts: ReadinessFacts): PlanReadiness {
  const items: ReadinessItem[] = []
  const online = facts.network === 'granted' || facts.network === 'ungated'
  for (const [eco, { manifests }] of facts.ecosystems) {
    const label = RUNTIME_LABEL[eco]
    items.push(
      facts.runtimes.get(eco)
        ? { need: label, status: 'ok', detail: 'installed.' }
        : {
            need: label,
            status: 'missing',
            detail: `not installed, or not on the PATH Houston sees. Install it before the plan's checks can run.`
          }
    )
    for (const m of manifests) {
      if (m.installed) continue
      const need = `${PACKAGES_LABEL[eco]} (${m.path})`
      const what = m.planned ? 'The plan creates this list' : 'Not installed yet'
      items.push(
        online
          ? { need, status: 'ok', detail: `${what}; shell commands can reach the package registries this run.` }
          : {
              need,
              status: 'needs-network',
              detail: `${what}. Installing needs network. ${NETWORK_BLOCKER[facts.network as keyof typeof NETWORK_BLOCKER]}`
            }
      )
    }
  }
  if (facts.browser === 'unavailable') {
    items.push({
      need: 'Browser check',
      status: 'unavailable',
      detail: "view_localhost isn't available in this client, so a check in the browser can't run here."
    })
  } else if (facts.browser === 'isolated') {
    items.push({
      need: 'Browser check',
      status: 'unavailable',
      detail:
        'On this Linux sandbox view_localhost cannot reach a dev server started from the shell unless Sandbox egress is set to "All domains" in Settings.'
    })
  } else if (facts.browser === 'ok') {
    items.push({ need: 'Browser check', status: 'ok', detail: 'view_localhost can load the app here.' })
  }
  return { items }
}

/**
 * The note appended to an accepted plan's result for the agent: the problems only,
 * so it knows before writing code which checks can't run as things stand. Empty when
 * there are none.
 */
export function readinessNote(r: PlanReadiness | undefined): string {
  const problems = (r?.items ?? []).filter((i) => i.status !== 'ok')
  if (!problems.length) return ''
  return (
    '\n\nHouston checked whether this plan\'s checks can run on this machine, and some cannot as things stand:\n' +
    problems.map((p) => `- ${p.need}: ${p.detail}`).join('\n') +
    '\nThe user saw this with the plan. If one of these checks still cannot run when you get to it, say so in your report instead of describing it as done.'
  )
}
