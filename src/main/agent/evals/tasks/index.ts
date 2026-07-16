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
import { task as fixNullDeref } from './fix-null-deref/task'
import { task as multiEditRename } from './multi-edit-rename/task'
import { task as newModuleWrite } from './new-module-write/task'
import { task as replaceAllConstant } from './replace-all-constant/task'
import { task as runTestsThenFix } from './run-tests-then-fix/task'
import { task as searchThenFix } from './search-then-fix/task'
import { task as todoDrivenRefactor } from './todo-driven-refactor/task'

export const TASKS: EvalTask[] = [
  fixNullDeref,
  runTestsThenFix,
  multiEditRename,
  newModuleWrite,
  searchThenFix,
  applyPatchMultiFile,
  replaceAllConstant,
  todoDrivenRefactor
]
