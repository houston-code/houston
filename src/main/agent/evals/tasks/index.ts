/**
 * The registered eval tasks.
 *
 * Adding a task: create `tasks/<id>/` with a `repo/` fixture and a `task.ts`
 * exporting an {@link EvalTask}, then register it here. The suite asserts that
 * the directory names and the registered ids agree in both directions, so a task
 * that is on disk but not in this list fails rather than silently never running.
 */
import type { EvalTask } from '../types'
import { task as applyPatchMultiFile } from './apply-patch-multi-file/task'
import { task as cacheStaleAfterOutage } from './cache-stale-after-outage/task'
import { task as callbacksToPromises } from './callbacks-to-promises/task'
import { task as ciFlakeOrBug } from './ci-flake-or-bug/task'
import { task as concurrentEditsDiverge } from './concurrent-edits-diverge/task'
import { task as crlfSalesReport } from './crlf-sales-report/task'
import { task as extractionJobStuck } from './extraction-job-stuck/task'
import { task as fileNamesWithSpaces } from './file-names-with-spaces/task'
import { task as fixNullDeref } from './fix-null-deref/task'
import { task as integrationNeedsDatabase } from './integration-needs-database/task'
import { task as invoiceRounding } from './invoice-rounding/task'
import { task as multiEditRename } from './multi-edit-rename/task'
import { task as newModuleWrite } from './new-module-write/task'
import { task as patchEnvelopeMarkers } from './patch-envelope-markers/task'
import { task as queuedSettingsRevert } from './queued-settings-revert/task'
import { task as replaceAllConstant } from './replace-all-constant/task'
import { task as reviewFailuresReportedClean } from './review-failures-reported-clean/task'
import { task as runTestsThenFix } from './run-tests-then-fix/task'
import { task as searchThenFix } from './search-then-fix/task'
import { task as semverRanges } from './semver-ranges/task'
import { task as settingsTwoProcesses } from './settings-two-processes/task'
import { task as shellAllowRuleBypass } from './shell-allow-rule-bypass/task'
import { task as terminalWrapWidth } from './terminal-wrap-width/task'
import { task as testProcessHangs } from './test-process-hangs/task'
import { task as todoDrivenRefactor } from './todo-driven-refactor/task'
import { task as unverifiableDependency } from './unverifiable-dependency/task'
import { task as utf8SplitChunks } from './utf8-split-chunks/task'
import { task as vendoredLibraryUpgrade } from './vendored-library-upgrade/task'
import { task as windowsFileUri } from './windows-file-uri/task'

export const TASKS: EvalTask[] = [
  fixNullDeref,
  runTestsThenFix,
  multiEditRename,
  newModuleWrite,
  searchThenFix,
  applyPatchMultiFile,
  replaceAllConstant,
  todoDrivenRefactor,
  unverifiableDependency,
  // Harder tasks: investigation across files, misleading first failures, long refactors.
  crlfSalesReport,
  utf8SplitChunks,
  extractionJobStuck,
  testProcessHangs,
  ciFlakeOrBug,
  fileNamesWithSpaces,
  queuedSettingsRevert,
  reviewFailuresReportedClean,
  windowsFileUri,
  semverRanges,
  invoiceRounding,
  callbacksToPromises,
  vendoredLibraryUpgrade,
  integrationNeedsDatabase,
  patchEnvelopeMarkers,
  settingsTwoProcesses,
  shellAllowRuleBypass,
  concurrentEditsDiverge,
  terminalWrapWidth,
  cacheStaleAfterOutage
]
