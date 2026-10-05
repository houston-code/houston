/**
 * Which "ship these changes" action the Changes surfaces offer, chosen from the
 * repository's real state instead of always offering "Create PR".
 *
 * A pull request needs history to diff against and a GitHub remote to open it on.
 * Offering "Create PR" in a fresh `git init` with no commits and no remote sends
 * the agent on a turn that can only end in "I can't do that yet", so:
 *
 *  - no remote (or no commits yet) → "Publish to GitHub": make the first commit,
 *    create the repository, push. Future changes then get "Create PR".
 *  - a GitHub remote with history → "Create PR" (the stacked-PR-aware flow).
 *  - a non-GitHub remote → "Commit & push": gh can't open a PR there, so commit to
 *    a feature branch, push, and surface the merge-request link the host prints.
 *
 * Pure and string-only so the renderer, tests, and any other client agree. The
 * renderer never drives git itself: every action hands a prompt to the agent, so
 * the work runs through its tools and the normal approval gate.
 */

/** Where the chosen remote is hosted, as far as shipping is concerned. */
export type RemoteHost = 'github' | 'other'

/** The git facts the ship action is chosen from (computed in the main process). */
export interface RepoShipState {
  /** False on an unborn HEAD (a fresh `git init` with no commits). */
  hasCommits: boolean
  /**
   * The remote changes would ship to (`origin` when present, else the first
   * remote), or null when none is configured. Only the name and a host class
   * cross IPC: never the URL, which can embed a credential.
   */
  remote: { name: string; host: RemoteHost } | null
}

export type ShipActionKind = 'create-pr' | 'publish' | 'push'

export interface ShipAction {
  kind: ShipActionKind
  /** Button label. */
  label: string
  /** Button tooltip. */
  title: string
  /** One-line explanation shown next to the button in the Changes panel. */
  hint: string
  /** The message handed to the agent when the button is clicked. */
  prompt: string
}

/**
 * Host class of a git remote URL. Handles URL forms (`https://`, `ssh://`,
 * `git://`, with optional `user@` and port) and scp-like `[user@]host:path`.
 * Anything unparseable is `other`, which only costs the PR shortcut.
 */
export function classifyRemoteUrl(url: string): RemoteHost {
  const host = remoteHostname(url.trim())
  if (!host) return 'other'
  return host === 'github.com' || host.endsWith('.github.com') ? 'github' : 'other'
}

function remoteHostname(url: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      return new URL(url).hostname.toLowerCase() || null
    } catch {
      return null
    }
  }
  // scp-like syntax: [user@]host:path (git treats it so only when no slash
  // precedes the first colon).
  const m = /^(?:[^@/\s]+@)?([^:/\s]+):/.exec(url)
  return m ? m[1].toLowerCase() : null
}

/**
 * A remote name safe to interpolate into the agent prompt. git permits names a
 * prompt shouldn't carry verbatim, so anything outside the conventional charset
 * falls back to describing it generically.
 */
function remoteRef(name: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : null
}

const GITIGNORE_STEP =
  'Check that `.gitignore` covers dependencies, build output, local databases, uploads, and secrets such as `.env` files, and add whatever is missing. Never commit a secret; if one is already tracked, stop and tell me.'

function createPrPrompt(remote: string): string {
  return `Create a GitHub pull request for my current changes, using git and the gh_pr_create tool. Never check out or commit to the default branch directly, since it may be checked out in another worktree.

1. Run \`git fetch ${remote}\` and identify the repository's default branch (e.g. main).
2. Choose the PR's head branch:
   - If I'm currently on the default branch, OR the current branch already has an open PR (check with \`gh pr list --head <current-branch>\`): create a new branch off the current tip and use that as the head.
   - Otherwise: use the current branch as the head.
3. Stage and commit the changes on that head branch with a clear, conventional commit message, then push it to ${remote}.
4. Open the PR with gh_pr_create, choosing the base branch:
   - If the current branch already had an open PR, this change is stacked on it, so set base to that PR's branch, so the new PR's diff shows only these changes and not the earlier PR's.
   - Otherwise set base to the default branch.
5. Reply with the PR link and a short summary, and say whether you opened an independent PR or stacked it on top of which PR/branch.`
}

const PUBLISH_PROMPT = `Publish this project to a new GitHub repository. It has no git remote yet, so a pull request isn't possible until the project is on GitHub.

1. ${GITIGNORE_STEP}
2. Stage and commit the current changes with a clear, conventional commit message. If the repository has no commits yet, make this the initial commit and name the branch \`main\` (\`git branch -M main\`).
3. Ask me (ask_user) for the repository name, suggesting this folder's name, and whether it should be private (recommended) or public.
4. Create it with gh_repo_create from this directory and push. If gh reports I'm not signed in, stop and tell me to run \`gh auth login\`.
5. Reply with the repository URL, and tell me that from now on the Create PR button opens pull requests for new changes.`

function firstPushPrompt(remote: string | null): string {
  const r = remote ?? 'the configured remote'
  const cmd = remote ?? '<remote>'
  return `Push this project's first commit to ${r}. The repository has no commits yet, so there is nothing for a pull request to compare against.

1. ${GITIGNORE_STEP}
2. Stage and commit the current changes as the initial commit with a clear, conventional message, and name the branch \`main\` (\`git branch -M main\`).
3. Run \`git fetch ${cmd}\`. If the remote already has a default branch with commits, stop and tell me rather than overwriting it; never force-push. Otherwise run \`git push -u ${cmd} main\`.
4. Reply with what was pushed and where, and tell me that from now on new changes can go up as pull requests.`
}

function pushPrompt(remote: string | null): string {
  const r = remote ?? 'the configured remote'
  const cmd = remote ?? '<remote>'
  return `Commit and push my current changes to ${r}. It isn't a GitHub remote, so gh_pr_create can't open a pull request there. Never check out or commit to the default branch directly, since it may be checked out in another worktree.

1. Run \`git fetch ${cmd}\` and identify the repository's default branch.
2. If I'm currently on the default branch, create a new branch off the current tip with a short descriptive name; otherwise use the current branch.
3. Stage and commit the changes with a clear, conventional commit message, then \`git push -u ${cmd} <branch>\`.
4. Reply with the branch name, and include the merge-request or pull-request link the push output printed, if any (GitLab, Bitbucket, and Gitea print one).`
}

/**
 * The action to offer for a repository in `state`. An unknown state (an older
 * main process, or a read that failed) keeps the historical "Create PR".
 */
export function chooseShipAction(state: RepoShipState | undefined): ShipAction {
  if (!state) return createPr('origin')
  const { hasCommits, remote } = state
  if (!remote) {
    return {
      kind: 'publish',
      label: 'Publish to GitHub',
      title: 'Ask the agent to commit this project, create a GitHub repository, and push it',
      hint: 'No remote yet. Hands off to the agent to commit, create a GitHub repository, and push.',
      prompt: PUBLISH_PROMPT
    }
  }
  const ref = remoteRef(remote.name)
  if (!hasCommits) {
    return {
      kind: 'publish',
      label: 'Push first commit',
      title: `Ask the agent to make the initial commit and push it to ${remote.name}`,
      hint: 'No commits yet. Hands off to the agent to make the first commit and push it.',
      prompt: firstPushPrompt(ref)
    }
  }
  if (remote.host === 'github') return createPr(ref ?? 'origin')
  return {
    kind: 'push',
    label: 'Commit & push',
    title: `Ask the agent to commit these changes to a branch and push it to ${remote.name}`,
    hint: 'Not a GitHub remote. Hands off to the agent to commit to a branch and push.',
    prompt: pushPrompt(ref)
  }
}

function createPr(remote: string): ShipAction {
  return {
    kind: 'create-pr',
    label: 'Create PR',
    title: 'Ask the agent to create a pull request from these changes',
    hint: 'Hands off to the agent to commit, push, and open a PR.',
    prompt: createPrPrompt(remote)
  }
}
