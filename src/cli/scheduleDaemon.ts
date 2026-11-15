import type { DaemonCommand, LoginAgentResult, ScheduleDaemonState } from '../main/loginAgent'

/**
 * `houston schedule-daemon [run|install|uninstall|status]`: scheduled runs without a
 * Houston window or terminal session open.
 *
 * - `run` (the default) keeps the daemon in the foreground until Ctrl-C or a signal.
 * - `install` sets up a per-user login agent that starts `houston schedule-daemon run`
 *   at login and now; `uninstall` stops and removes it; `status` says what is set up.
 *
 * The terminal daemon reads keys like any CLI session (environment variables, then
 * cli-credentials.json). Keys saved in the desktop app are locked to it, so desktop
 * users turn the same thing on from Settings > Scheduled runs instead, where the
 * daemon runs as the app.
 */
export const SCHEDULE_DAEMON_USAGE = `Usage: houston schedule-daemon [run|install|uninstall|status]
  run         fire scheduled runs until stopped (the default)
  install     start it at login, and now (per user; no admin rights needed)
  uninstall   stop it and remove it from login
  status      whether it is installed and running
`

export interface ScheduleDaemonCliDeps {
  run: () => Promise<number>
  install: (cmd: DaemonCommand) => Promise<LoginAgentResult>
  uninstall: () => Promise<LoginAgentResult>
  state: () => Promise<ScheduleDaemonState>
  /** What the login agent starts: this CLI, in `run` mode. */
  command: () => DaemonCommand
  out: (s: string) => void
  err: (s: string) => void
}

export async function runScheduleDaemonCommand(args: string[], deps: ScheduleDaemonCliDeps): Promise<number> {
  const sub = args.find((a) => !a.startsWith('-')) ?? 'run'
  if (args.includes('-h') || args.includes('--help')) {
    deps.out(SCHEDULE_DAEMON_USAGE)
    return 0
  }
  switch (sub) {
    case 'run':
      return deps.run()
    case 'install': {
      const state = await deps.state()
      if (!state.supported) {
        deps.err('houston: a login agent is not supported on this platform. Run `houston schedule-daemon run` from your own service manager instead.\n')
        return 1
      }
      // The desktop app's daemon uses the same login entry; replacing it would switch
      // scheduled runs to this CLI's keys and profile behind the app's back.
      if (state.installed && state.byApp) {
        deps.err(
          "houston: the desktop app's schedule daemon is already installed (Settings > Scheduled runs). Turn it off there, or run `houston schedule-daemon uninstall`, then install again.\n"
        )
        return 1
      }
      const r = await deps.install(deps.command())
      if (!r.ok) {
        deps.err(`houston: couldn't install the schedule daemon: ${r.error}\n`)
        return 1
      }
      deps.out('Installed: scheduled runs now fire while Houston is closed. It starts at login; `houston schedule-daemon uninstall` removes it.\n')
      return 0
    }
    case 'uninstall': {
      const r = await deps.uninstall()
      if (!r.ok) {
        deps.err(`houston: couldn't remove the schedule daemon: ${r.error}\n`)
        return 1
      }
      deps.out('Removed: scheduled runs fire only while Houston is open.\n')
      return 0
    }
    case 'status': {
      const s = await deps.state()
      if (!s.supported) deps.out('Login agent: not supported on this platform.\n')
      else deps.out(`Login agent: ${s.installed ? (s.byApp ? 'installed by the desktop app' : 'installed') : 'not installed'}.\n`)
      deps.out(s.pid !== null ? `Daemon: running (pid ${s.pid}).\n` : 'Daemon: not running.\n')
      return 0
    }
    default:
      deps.err(`houston: unknown schedule-daemon command "${sub}".\n\n${SCHEDULE_DAEMON_USAGE}`)
      return 2
  }
}
