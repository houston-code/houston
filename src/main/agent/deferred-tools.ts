/**
 * Built-in tools that are offered but not preloaded.
 *
 * Every advertised tool schema rides along on every request, and Houston's full
 * built-in set is most of a request's fixed overhead. The tools here are each
 * available to the run (when its backends allow) but only their one-line catalog
 * entry is sent up front, inside the `find_tools` description (lazy-mcp.ts); the
 * model loads a schema there when it needs it, and a loaded tool stays advertised
 * for the rest of the conversation (see `loadedDeferredTools`).
 *
 * Deferral changes only what is advertised. A deferred tool is looked up, gated
 * (plan mode, permission rules, approval, hooks) and executed by exactly the same
 * path as an eager one, whether or not it has been loaded.
 *
 * What stays eager is the core loop of a coding task: reading, searching, editing,
 * the shell and its companions, the todo list, asking the user, plan mode's
 * present_plan, read-only delegation, skills, the web, and git status/diff (small,
 * and the prompt's git snapshot points at git_status). A tool belongs here when it
 * serves a specific situation the catalog line can name, so the model knows to
 * load it when that situation comes up.
 *
 * Each entry is the catalog line: it must say when to load the tool, not only what
 * it does, because it is all the model sees of the tool until then.
 */
export const DEFERRED_TOOL_CATALOG: Readonly<Record<string, string>> = {
  // Specialist search and editing: search_files and edit_file cover the common case.
  ast_grep:
    'Structural code search by syntax-tree pattern with meta-variables ("console.log($A)"), for code shapes (calls, declarations, JSX) without regex false positives.',
  notebook_edit: 'Edit one cell of a Jupyter notebook (.ipynb) by cell number; use it instead of edit_file for notebooks.',
  // Only useful after compaction or elided output, which most turns never reach.
  recall_history:
    'Read back earlier messages of this conversation after compaction or elided tool output, to recover a path, value, or decision you no longer see.',
  // Expensive, once-per-change verification.
  review_changes:
    'Independent multi-agent review of the uncommitted changes (correctness, security, quality); run once after a large or security-sensitive change.',
  // Delegation beyond read-only research, and parallel sessions: used deliberately, not every turn.
  dispatch_writable_agent:
    'Delegate a self-contained implementation task to a subagent that can edit files and run sandboxed commands, and get its report back.',
  spawn_session:
    'Start a separate, persistent background session for work the user asked to run in parallel.',
  propose_session:
    "Offer the user a card to start a separate session for parallel work you noticed but weren't asked to do (a follow-up, a fix spotted in passing).",
  // UI verification and presentation: only when a task has a web UI or the user asks to see something.
  view_localhost:
    'Load a localhost URL (a dev server you started) in a headless browser: screenshot, page text, console output, and scripted steps to exercise a flow.',
  show_images: 'Show image files (screenshots, renders) to the user as a gallery or file links.',
  render_mockup:
    "Render a self-contained HTML mockup from the project into screenshots, to show a UI that doesn't exist yet.",
  // Memory writes: the prompt says when to save; the schemas load on first use.
  memory_save: 'Save or update a memory: a fact a later session should know (see the memory guidance).',
  memory_delete: 'Delete a saved memory that proved wrong or no longer applies.',
  // Scheduling: only when the user asks for something later or on a schedule.
  schedule_run:
    'Schedule a recurring or one-time background agent run ("every morning...", "tomorrow at 9...") with a self-contained prompt.',
  list_scheduled_runs: 'List the scheduled background runs.',
  cancel_scheduled_run: 'Cancel a scheduled background run by id.',
  // GitHub: only when the task touches pull requests, issues, or CI.
  pr_sweep: 'Board for planning and tracking a batch of pull requests (one PR per task, or working through open PRs).',
  gh_pr_create: 'Open a GitHub pull request for the current branch (push the branch first).',
  gh_pr_list: 'List the repository\'s pull requests.',
  gh_pr_view: 'View a pull request (details, body, optionally its diff).',
  gh_pr_comment: 'Comment on a pull request.',
  gh_pr_checkout: 'Check out a pull request\'s branch locally.',
  gh_pr_checks: 'Show the CI check results for a pull request.',
  gh_pr_review: 'Approve, request changes on, or comment-review a pull request.',
  gh_pr_merge: 'Merge a pull request.',
  gh_pr_set_state: 'Close, reopen, mark ready, or convert a pull request to draft.',
  gh_repo_create: 'Create a GitHub repository for the project and push it.',
  gh_issue_list: 'List the repository\'s issues.',
  gh_issue_view: 'View an issue, optionally with its comments.',
  gh_issue_create: 'Open a GitHub issue.',
  gh_issue_comment: 'Comment on an issue.',
  gh_issue_set_state: 'Close or reopen an issue.',
  gh_run_list: 'List recent GitHub Actions workflow runs.',
  gh_run_view: 'View a GitHub Actions run, or the logs of its failed steps (log_failed:true) to diagnose a CI failure.'
}

/** Whether a built-in tool is deferred (offered through the find_tools catalog). */
export function isDeferredBuiltin(name: string): boolean {
  return Object.hasOwn(DEFERRED_TOOL_CATALOG, name)
}
