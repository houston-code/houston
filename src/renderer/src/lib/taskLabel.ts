/**
 * Readable labels for the agent's background shells in the Tasks panel.
 *
 * Agents prefix nearly every command with the same scaffolding: `cd /abs/path &&`,
 * a virtualenv `source …/activate`, the nvm bootstrap, a `sleep 2 && cat log` poll.
 * Shown raw, every row reads `cd /home/me/project/...` truncated, and the rows are
 * indistinguishable. This picks out the command that actually does the work, the
 * folder it ran in (relative to the workspace), and the ports it serves on. The full
 * command is still one click away in the expanded row.
 */

export interface ShellDisplay {
  /** The command that does the work, without setup steps or redirections. */
  label: string
  /** The folder it ran in, relative to the workspace (`backend/`), or '' for the root. */
  folder: string
  /** Ports its URLs are on, e.g. `[':5173']`, in the order printed. */
  ports: string[]
  /** It listens on every interface (0.0.0.0 / ::), so other machines can reach it. */
  exposed: boolean
}

/** Setup steps that never are the point of a command. */
const SETUP_STEP = [
  /^source\s/, // virtualenv / env files
  /^\.\s/, // `. "$NVM_DIR/nvm.sh"`
  /^export\s/,
  /^nvm\s/,
  /^sleep\s/,
  /^set\s/,
  /^conda\s+activate\b/,
  /^pyenv\s+(?:local|shell)\b/
]

/** A trailing poll of a log the command just wrote (`cat /tmp/x.log`, `tail -n 20 x.log`). */
const LOG_READ = /^(?:cat|tail|head)\b.*\.log\b/

/**
 * Split on the shell's control operators (&&, ||, ;, |, a lone &, newline), leaving
 * quoted spans and fd redirections like `2>&1` intact. A label heuristic, not a
 * parser: anything it can't place stays in the segment.
 */
function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    const prev = command[i - 1]
    const next = command[i + 1]
    const isFdAmp = c === '&' && (prev === '>' || prev === '<' || next === '>')
    if (c === '\n' || c === ';' || (c === '|' && !isFdAmp) || (c === '&' && !isFdAmp)) {
      // Swallow the second char of && / ||.
      if ((c === '&' || c === '|') && next === c) i++
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Drop output redirections (`> log`, `2>&1`, `&>/dev/null`) from a segment. */
function stripRedirections(seg: string): string {
  return seg
    .replace(/\s*(?:\d?>>?|&>>?)\s*&?\d+(?=\s|$)/g, '')
    .replace(/\s*(?:\d?>>?|&>>?)\s*(?:"[^"]*"|'[^']*'|\S+)/g, '')
    .trim()
}

function unquote(s: string): string {
  return s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s
}

/** Join a `cd` target onto the current folder (both relative to the workspace). */
function applyCd(current: string, target: string, workspace: string | undefined): string {
  let t = unquote(target.trim())
  if (t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t)) {
    const ws = workspace?.replace(/[\\/]+$/, '')
    if (ws && (t === ws || t.startsWith(`${ws}/`) || t.startsWith(`${ws}\\`))) {
      t = t.slice(ws.length).replace(/^[\\/]+/, '')
    } else {
      // Outside the workspace: name it by its last two parts rather than a home path.
      const parts = t.split(/[\\/]+/).filter(Boolean)
      return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : t
    }
    current = ''
  }
  const parts = current ? current.split('/') : []
  for (const p of t.split(/[\\/]+/)) {
    if (!p || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return parts.join('/')
}

function portOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.port ? `:${u.port}` : null
  } catch {
    return null
  }
}

/** Derive the row label, folder, ports and exposure for a background shell. */
export function describeShell(command: string, urls: readonly string[] = [], workspace?: string): ShellDisplay {
  let folder = ''
  let label = ''
  for (const raw of segments(command)) {
    const seg = stripRedirections(raw)
    if (!seg) continue
    const cd = /^(?:cd|pushd)\s+(.+)$/.exec(seg)
    if (cd) {
      if (!label) folder = applyCd(folder, cd[1]!, workspace)
      continue
    }
    if (SETUP_STEP.some((re) => re.test(seg))) continue
    if (label && LOG_READ.test(seg)) continue
    if (!label) label = seg
  }
  if (!label) label = command.split('\n')[0]!.trim()

  const ports: string[] = []
  for (const u of urls) {
    const p = portOf(u)
    if (p && !ports.includes(p)) ports.push(p)
  }
  const exposed =
    urls.some((u) => /^\w+:\/\/(?:0\.0\.0\.0|\[::\])(?::|\/|$)/.test(u)) ||
    /(?:^|[\s=])0\.0\.0\.0(?::\d+)?(?=\s|$)/.test(command) ||
    // A bare `--host` (Vite, Astro) or one given 0.0.0.0 / ::; `--host 127.0.0.1` stays local.
    /--host(?:[\s=]+(?:0\.0\.0\.0|::))?(?=\s+-|\s*$|\s*[;&|\n])/.test(command)

  return { label, folder: folder ? `${folder}/` : '', ports, exposed }
}
