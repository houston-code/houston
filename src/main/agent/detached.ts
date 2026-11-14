import { splitShellCommand } from './permissions'

/**
 * Spotting a foreground run_shell command that leaves something running after it
 * returns: a detached container, a process manager's daemon, a tmux/screen session, a
 * system service, or a process sent to the background with `&`. Houston's Stop and
 * quit clean up only the background shells it registered, so these keep running
 * (holding ports, using CPU) until someone stops them by hand. The tool result says
 * so, with the command that stops each one.
 *
 * Detection reads the sub-commands {@link splitShellCommand} yields and only names a
 * launcher whose flags say it detaches (`docker run -d`, not `docker run`), so a plain
 * foreground command never gets the note.
 */

/** One thing a command left running, and how to stop it. */
export interface DetachedLaunch {
  /** What was left running, e.g. "a detached Docker container". */
  what: string
  /** How to stop it, e.g. "`docker stop <container>`". */
  stop: string
}

/** Words of a simple command with quotes removed: enough to name the program and its flags. */
function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''))
}

/** Leading words that wrap the real program: env assignments, sudo, runners. */
function stripWrappers(w: string[]): string[] {
  let i = 0
  for (;;) {
    const word = (w[i] ?? '').toLowerCase()
    if (!word) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++
    else if (['(', '{', '!', 'time', 'command', 'exec', 'env', 'nice', 'sudo', 'do', 'then', 'else'].includes(word)) i++
    else if (['npx', 'bunx', 'pnpx'].includes(word)) {
      i++
      while ((w[i] ?? '').startsWith('-')) i++
    } else break
  }
  return w.slice(i)
}

/** The program's bare name: `/usr/local/bin/docker` is `docker`. */
function programName(word: string): string {
  return (word.replace(/\\/g, '/').split('/').pop() ?? word).toLowerCase().replace(/\.(exe|cmd)$/, '')
}

/** Whether any word is one of `long` or a short-flag cluster holding `short` (`-d`, `-itd`). */
function hasFlag(args: string[], short: string, long: string[]): boolean {
  return args.some((a) => long.includes(a) || (short !== '' && /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(short)))
}

/** The value of an option given as `--opt value`, `--opt=value`, or `-o value`. */
function optionValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    for (const n of names) {
      if (a === n && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1]
      if (n.startsWith('--') && a.startsWith(`${n}=`)) return a.slice(n.length + 1)
    }
  }
  return undefined
}

/** The first argument that isn't a flag, after `from`. */
function firstOperand(args: string[], from = 0): string | undefined {
  return args.slice(from).find((a) => !a.startsWith('-'))
}

/** Container engines whose CLI follows Docker's (`run -d`, `compose up -d`). */
const CONTAINER_CLIS = new Set(['docker', 'podman', 'nerdctl'])

function classify(segment: string): DetachedLaunch | null {
  const w = stripWrappers(words(segment))
  if (!w.length) return null
  const prog = programName(w[0])
  const args = w.slice(1)
  const sub = (args[0] ?? '').toLowerCase()

  if (CONTAINER_CLIS.has(prog) || prog === 'docker-compose' || prog === 'podman-compose') {
    const composeArgs =
      prog === 'docker-compose' || prog === 'podman-compose' ? args : sub === 'compose' ? args.slice(1) : null
    if (composeArgs) {
      // The verb is the first operand that isn't the value of a global option (`-f x.yml up`).
      const valued = /^(-f|-p|--file|--project-name|--profile|--env-file|--project-directory)$/
      const verb = composeArgs.find((a, i) => !a.startsWith('-') && !valued.test(composeArgs[i - 1] ?? ''))
      if ((verb === 'up' && hasFlag(composeArgs, 'd', ['--detach'])) || verb === 'start') {
        const base = prog === 'docker-compose' || prog === 'podman-compose' ? prog : `${prog} compose`
        return { what: 'Compose services in the background', stop: `\`${base} down\` (or \`${base} stop\`) from the same folder` }
      }
      return null
    }
    const runArgs = sub === 'container' ? args.slice(1) : args
    const verb = (runArgs[0] ?? '').toLowerCase()
    if (verb === 'run' && hasFlag(runArgs.slice(1), 'd', ['--detach'])) {
      const name = optionValue(runArgs, ['--name'])
      return { what: 'a detached container', stop: `\`${prog} stop ${name ?? '<container>'}\` (\`${prog} ps\` lists them)` }
    }
    if (verb === 'start' && runArgs.length > 1 && !hasFlag(runArgs.slice(1), 'a', ['--attach', '--interactive']) && !hasFlag(runArgs.slice(1), 'i', [])) {
      const name = firstOperand(runArgs, 1)
      return { what: 'a container', stop: `\`${prog} stop ${name ?? '<container>'}\`` }
    }
    return null
  }

  if (prog === 'pm2' && ['start', 'restart', 'reload', 'resurrect'].includes(sub) && !args.includes('--no-daemon')) {
    const name = optionValue(args, ['--name', '-n'])
    return { what: 'a pm2-managed process', stop: `\`pm2 delete ${name ?? '<name|id>'}\` (\`pm2 ls\` lists them)` }
  }

  if (prog === 'tmux' && ['new', 'new-session'].includes(sub) && hasFlag(args.slice(1), 'd', [])) {
    const name = optionValue(args, ['-s'])
    return { what: 'a detached tmux session', stop: `\`tmux kill-session -t ${name ?? '<session>'}\` (\`tmux ls\` lists them)` }
  }

  if (prog === 'screen') {
    // `-dm`, `-d -m`, `-dmS name`: start a session already detached.
    const clusters = args.filter((a) => /^-[A-Za-z]+$/.test(a)).map((a) => a.slice(1)).join('')
    if (!clusters.includes('d') || !clusters.includes('m')) return null
    const at = args.findIndex((a) => /^-[A-Za-z]*S$/.test(a))
    const name = at >= 0 ? args[at + 1] : undefined
    return { what: 'a detached screen session', stop: `\`screen -S ${name ?? '<session>'} -X quit\` (\`screen -ls\` lists them)` }
  }

  if (prog === 'brew' && sub === 'services' && ['start', 'restart', 'run'].includes((args[1] ?? '').toLowerCase())) {
    const name = firstOperand(args, 2)
    return { what: 'a Homebrew service', stop: `\`brew services stop ${name ?? '<formula>'}\`` }
  }

  if (prog === 'systemctl') {
    const verb = firstOperand(args)
    const enableNow = verb === 'enable' && args.includes('--now')
    if (verb === 'start' || verb === 'restart' || enableNow) {
      const unit = firstOperand(args, args.indexOf(verb) + 1)
      const user = args.includes('--user') ? ' --user' : ''
      return { what: 'a systemd service', stop: `\`systemctl${user} stop ${unit ?? '<unit>'}\`` }
    }
    return null
  }

  if (prog === 'launchctl' && ['load', 'bootstrap', 'kickstart', 'start'].includes(sub)) {
    return { what: 'a launchd job', stop: sub === 'load' ? '`launchctl unload <plist>`' : '`launchctl bootout <domain>/<label>`' }
  }

  if (prog === 'setsid' && hasFlag(args, 'f', ['--fork'])) {
    return { what: 'a process in its own session (setsid)', stop: '`kill <pid>` (find it with `pgrep -f <name>`)' }
  }

  if (prog === 'disown') {
    return { what: 'a disowned background process', stop: '`kill <pid>` (find it with `pgrep -f <name>`)' }
  }

  return null
}

/**
 * What a foreground command leaves running when it returns, one entry per kind (empty
 * when nothing). `backgrounded` is whether the command sends part of itself to the
 * background with a lone `&` (see backgroundsItself in tools.ts), which the split into
 * sub-commands can no longer show.
 */
export function detachedLaunches(command: string, backgrounded: boolean): DetachedLaunch[] {
  const found: DetachedLaunch[] = []
  const seen = new Set<string>()
  const add = (d: DetachedLaunch): void => {
    if (seen.has(d.what)) return
    seen.add(d.what)
    found.push(d)
  }
  for (const segment of splitShellCommand(command)) {
    const d = classify(segment)
    if (d) add(d)
  }
  // `disown` already names the `&` it follows.
  if (backgrounded && !seen.has('a disowned background process')) {
    add({ what: 'a process sent to the background with `&`', stop: '`kill <pid>` (find it with `pgrep -f <name>`)' })
  }
  return found
}

/** The note appended to a foreground run_shell result, or '' when nothing was left running. */
export function detachedLaunchNote(command: string, backgrounded: boolean): string {
  const found = detachedLaunches(command, backgrounded)
  if (!found.length) return ''
  const items = found.map((d) => `${d.what} (stop it with ${d.stop})`).join('; ')
  return (
    `[note: this command left something running outside Houston: ${items}. ` +
    'Stopping the turn or quitting Houston will not stop it. Stop it when you are done with it, ' +
    'or tell the user it is still running. For a dev server you want Houston to track, use run_shell with background:true instead.]'
  )
}
