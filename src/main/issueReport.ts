import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { app, shell } from 'electron'
import { issueReportBody, issueReportUrl } from '@shared/issueReport'
import { version as APP_VERSION } from '../../package.json'
import { gatherDoctorFacts } from './doctor'
import { log, logFilePath } from './logger'
import { recentCrashDumps } from './crashRecovery'
import { openExternalSafely } from './safeExternal'
import { getUserDataDir } from './userData'

/** Where Help → Report an Issue… sends the user. */
export const ISSUES_URL = 'https://github.com/houston-code/houston/issues/new'

/**
 * Help → Open Logs: show the log file selected in the OS file manager, or open its
 * folder when nothing has been logged yet. Opens a fixed location in the profile, so
 * nothing the renderer sends can point it elsewhere.
 */
export async function revealLogs(): Promise<void> {
  let file: string
  try {
    file = logFilePath()
  } catch (e) {
    log.warn(`could not find the log folder: ${(e as Error).message}`)
    return
  }
  if (existsSync(file)) shell.showItemInFolder(file)
  else {
    const err = await shell.openPath(dirname(file))
    if (err) log.warn(`could not open the log folder: ${err}`)
  }
}

/**
 * The text a new issue starts with (see @shared/issueReport for what it may carry).
 * The doctor probe runs against the profile folder rather than a project, so no
 * project's files are looked at and no project path can reach the report.
 */
export function issueReportText(): string {
  return issueReportBody(gatherDoctorFacts(getUserDataDir(), { version: APP_VERSION, update: null }), crashDumpNames())
}

/** Names of recent crash dumps (see crashRecovery.ts); none when the folder can't be found. */
function crashDumpNames(): string[] {
  try {
    return recentCrashDumps(app.getPath('crashDumps'))
  } catch {
    return []
  }
}

/**
 * Open the new-issue page in the browser with the report filled in, or blank when the
 * diagnostics can't be gathered (the dialog says so before the user opens it).
 */
export function openIssueReport(): boolean {
  let body: string | null = null
  try {
    body = issueReportText()
  } catch (e) {
    log.warn(`could not gather diagnostics for the issue report: ${(e as Error).message}`)
  }
  return openExternalSafely(body === null ? ISSUES_URL : issueReportUrl(ISSUES_URL, body))
}
