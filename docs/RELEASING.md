# Releasing Houston

Maintainer guide to cutting, fixing, patching and publishing a release. Two manually run
workflows do the work, **Release - prepare** and **Release - publish**, both always run from
`main`. The rules they enforce live in [`scripts/release-source.mjs`](../scripts/release-source.mjs).

## How it fits together

Every release ships from a **release line**, a long-lived branch named `release/X.Y`
(`release/0.9` carries 0.9.0, 0.9.1, 0.9.2 and so on).

- **Release - prepare** checks the commit a release is cut from the way Release - publish
  will, then opens a **release PR** from `release-pr/vX.Y.Z` into the line. That PR's commit
  is the cut plus the version bump and the generated `CHANGELOG.md` section, and records the
  cut in a `Release-Base:` trailer.
- You review the notes in the release PR and merge it with **Create a merge commit**.
- **Release - publish** finds that merge on the line and builds, signs, tags and publishes
  exactly the release PR's own commit. Anything merged to `main` or to the line afterwards
  never ships under that version, so the notes always describe what ships.

A version is **pending** from the moment its release PR is opened until Release - publish
tags it. Each line has at most one pending version.

## Running the workflows

Both workflows are run from the **Actions** tab, with **Use workflow from: Branch: main**.
Any other branch fails within seconds: the branch selector picks which copy of the workflow
runs, not what gets released.

### Release - prepare

| What do you want to release? | Version to type | What it does |
| --- | --- | --- |
| Next minor version | the highest version that exists (shipped or pending), plus one minor | Cuts `main` into a new line, `release/X.Y`, and opens its release PR |
| Next major version | the highest version that exists (shipped or pending), plus one major | The same, for a new major's line |
| Patch a release | the highest shipped version on that line, plus one patch | Cuts that line's tip and opens its release PR |
| Update pending release | the pending version itself | Re-cuts it from its line's tip, with regenerated notes |

The version always has to agree with the choice (a leading `v` is fine). When it doesn't,
the run fails with the version that would work. Because new versions count pending ones too,
several new lines can be in progress at once. **Patch a release** and **Update pending
release** often take the same number: the patch starts 0.9.2, and if a fix lands on
`release/0.9` before it ships, the update re-cuts 0.9.2.

For example, with v0.8.0 shipped (from before release lines), v0.9.0 and v0.9.1 shipped on
`release/0.9`, and 0.10.0 pending on `release/0.10`:

| Choice | Valid | Refused, with the message |
| --- | --- | --- |
| Next minor version | `0.11.0` (0.10.0 is pending, so it counts) | `0.10.0`: "The next minor version is 0.11.0." |
| Next major version | `1.0.0` | `2.0.0`: "The next major version is 1.0.0." |
| Patch a release | `0.9.2`, or `0.8.1` (see [Patch a shipped release](#patch-a-shipped-release)) | `0.9.3`: "The next patch of 0.9 is 0.9.2." `0.9.0`: "A patch version ends in a number above 0, like 0.9.1." `0.10.1`: "Nothing has shipped on 0.10 yet, so there's nothing to patch." |
| Update pending release | `0.10.0`, or `0.9.2` once its patch is prepared | `0.9.1`: "v0.9.1 already shipped. To fix it, choose "Patch a release" with 0.9.2." `0.12.0`: "v0.12.0 isn't pending. Prepare it first." |

Anything that isn't `X.Y.Z` (`0.9`, `1.0.0-rc.1`) is refused before anything runs.

The run checks the exact commit it cuts, in Release - publish's order, and only opens the
PR when everything passes:

1. **plan**: validates the request and pins the commit.
2. **The vulnerability and SBOM gates** ([`native-vuln-scan.yml`](../.github/workflows/native-vuln-scan.yml),
   [`sbom-conformance.yml`](../.github/workflows/sbom-conformance.yml)), the same called
   workflows Release - publish runs. CI's own gate ([`ci.yml`](../.github/workflows/ci.yml):
   lint, typecheck, the full test suite, the Linux sandbox, workflow lint) runs alongside.
3. **The four build legs** ([`release-build.yml`](../.github/workflows/release-build.yml)),
   the same steps Release - publish runs: notices, package, the packaged-app e2e on macOS,
   the standalone CLI, the SBOMs, and the binary SBOM's vulnerability policy. They're unsigned
   and upload nothing.
4. **The notes and the release PR**, last.

There is no approval, signing or notarization in Release - prepare, so Release - publish
should only ever find problems with signing.

A failed Release - prepare leaves nothing behind: if its last step fails after creating the
release line or the release branch, it deletes the ones that run created, so you can run it
again with the same inputs.

### Release - publish

Run it with the version whose release PR has merged. Leave **dry_run** off to publish; turn it
on to build and sign everything without publishing (it still asks for approval).

1. **source**: finds the release merge on the line and verifies the release commit (see
   [What Release - publish refuses](#what-release---publish-refuses)).
2. **The vulnerability and SBOM gates** on that commit, with the **approval** alongside.
3. **draft**: creates (or reuses) the draft release.
4. **The four build legs**, in parallel, signed and notarized, each uploading its installers.
5. **mac-feed**: merges the two macOS update feeds into one.
6. **checksums**: `SHA256SUMS`, cosign and GPG signatures, and build provenance.
7. **finalize**: tags the release commit and publishes the release. It's marked **latest**
   only if it's the highest release, so a patch to an older line never takes the update feed.
8. **sync-main**: opens a PR that brings the release's `CHANGELOG.md` section (and, for X.Y.0,
   the version) to `main`, and turns on auto-merge so it joins the merge queue once CI passes.
   The release PR merged into the line, not `main`, so without this `main` would keep the old
   version and miss these notes, and the next line would be cut without them. If auto-merge
   can't be turned on, the run still passes and its summary says to queue the PR yourself.
9. **distribute**: for a release marked **latest** only, sends the standalone CLI to npm
   (`@houston-code/cli`), the Homebrew tap and the AUR. Each channel stays off until its
   repository variable is `true`; [packaging/README.md](../packaging/README.md) has the
   setup for each.

The workflow files and the release orchestration scripts come from `main`, and everything
that's built and shipped comes from the release commit. So a fix to the pipeline applies to a
retry without changing what ships.

## One-time setup

Both workflows open PRs with `RELEASE_PR_TOKEN`, because a PR opened by the workflow's own
token runs no checks. It's a fine-grained personal access token for this repository, stored in
the `release-pr` environment (Settings > Environments), whose deployment branches are limited
to `main` so a workflow edited on another branch can't read it. It needs:

| Permission | Used for |
| --- | --- |
| Pull requests: read and write | opening, closing, reopening and commenting on the release and sync PRs |
| Contents: read and write | turning on auto-merge for the sync PR, so it joins the merge queue |

Branches are pushed with the workflow's own token, not this one. Auto-merge also needs **Allow
auto-merge** on in the repository settings.

## Common tasks

### Release a new minor or major version

1. Release - prepare: **Next minor version**, `0.10.0`.
2. Edit the notes in the release PR: the summary must be one sentence of at most 120
   characters (the `release-notes` check on the PR says when it passes).
3. Merge it with **Create a merge commit**.
4. Release - publish: `0.10.0`.
5. Point the GitHub Action at the new CLI in a PR to `main`: set `action/cli-release.json`
   to the version and the `houston-cli.cjs` hash from the release's `SHA256SUMS`, and add
   that `SHA256SUMS` and `SHA256SUMS.asc` under `action/test/fixtures/v<version>/` (its
   unit tests check the pinned hash against the signed list). Until then the action keeps
   running the CLI it pinned before.

### Fix something before it ships

The release PR is open or merged, and Release - prepare, review, or a failed Release -
publish turned up a problem in the shipped code.

1. Fix it on `main` with a normal PR.
2. Bring the fix to the line: see [Backporting a fix](#backporting-a-fix).
3. Release - prepare: **Update pending release**, `0.10.0`. If the release PR is still open it
   is updated in place (your edits to its notes are replaced; a comment says so); if it had
   merged, a new release PR opens.
4. Merge it, then run Release - publish as usual.

**Update pending release** also works with nothing new merged: it re-cuts and regenerates the
notes. Use it when a merged release PR's notes need another pass.

### Patch a shipped release

1. Fix it on `main`, then backport it to the line (below).
2. Release - prepare: **Patch a release**, `0.9.1`.
3. Merge the release PR, then Release - publish: `0.9.1`.

Any shipped release can be patched, not only the newest. A release from before release lines
existed (v0.8.0 and older) has no line yet: the first **Patch a release** for it creates the
line at its tag and stops there. Backport your fixes into the new line, then run **Patch a
release** again.

### Backporting a fix

Once the fix has merged to `main`, cherry-pick its merge commit onto the line in a PR:

```bash
git fetch origin
git switch -c backport/0.9/pr-123 origin/release/0.9
git cherry-pick -x -m 1 <merge commit of #123>
gh pr create --base release/0.9 --title "Backport #123 to 0.9: <original title>"
```

- `-x` records where the change came from; `-m 1` applies the whole PR's change from its merge
  commit.
- Resolve any conflict in the backport branch, as in any rebase.
- A fix for code that no longer exists on `main` is a normal PR straight into the line.
- Release lines have no merge queue. If GitHub shows the PR as behind, use **Update branch**,
  then merge with **Create a merge commit** or **Squash and merge**. Never **Rebase and merge**:
  its commits don't say which PR they came from, and Release - prepare refuses a line that has
  them.

### Abandon a cut you won't ship

Close its release PR, then delete `release-pr/vX.Y.Z` and, if nothing on it was ever
released, the line `release/X.Y`. Nothing was tagged, so nothing else needs undoing. Until
you do, the abandoned version stays pending, but it blocks nothing else.

## What Release - prepare refuses

| Situation | Message points you to |
| --- | --- |
| The version doesn't match the choice | the version that would |
| A patch version ending in `.0`, or for a line where nothing has shipped | the patch rule above |
| A patch while that line already has a pending version | **Update pending release** with it |
| **Update pending release** for a version that already shipped | **Patch a release** with the next patch |
| **Update pending release** for a version that isn't pending | preparing it first |
| A patch with nothing merged to the line since the last release | nothing to do |
| A line with a commit that didn't come in through a PR (a rebase merge or a direct push) | reverting it and re-merging through a PR |
| A new line whose branch already exists (an abandoned cut) | deleting it first |

## What Release - publish refuses

| Situation | What to do |
| --- | --- |
| No merged release PR for the version | merge it, or run Release - prepare first |
| The release PR was squash-merged | revert that commit on the line, then merge the release PR again with **Create a merge commit** |
| The release PR changes anything but the version and `CHANGELOG.md` (including dependency changes in `package.json`), or was rebased or updated from the line | **Update pending release** |
| Changes merged to the line after the release PR | **Update pending release**, so the notes announce them |
| Changes merged to the line while the release PR was open, which it doesn't include (it was merged while behind the line) | **Update pending release**, so they ship with this version |
| The notes' summary fails the check | fix it in the release PR; if it has merged, **Update pending release** |
| The version's tag already names a different commit | investigate: someone moved or created the tag by hand |

## When Release - publish fails

| What failed | Example | What to do |
| --- | --- | --- |
| Infrastructure | a runner lost, a network reset | re-run the failed jobs |
| The pipeline itself | a release script bug, a permission | fix it on `main`, then run Release - publish again with the same version |
| Something in the shipped code | a vulnerability, stale notices, an e2e failure, `electron-builder.yml` signing config | fix it on `main`, backport, **Update pending release**, merge, publish again |
| Found after it shipped | a user reports a bug | backport, **Patch a release** |

A failed attempt leaves an untagged draft. The next attempt reuses it, and empties it first if
it was made for a different commit. If `finalize` failed after pushing the tag, re-run just
`finalize`.

## Limitations

- **Release lines aren't protected by a ruleset.** Anyone with write access can push to one.
  Release - prepare refuses commits that skipped a PR, and Release - publish ships only the
  release PR's commit.
- **Patches to older releases don't reach auto-updating users.** The updater follows the
  release marked latest, so someone on 0.8 is offered 0.9.x, not 0.8.1. Older patches reach
  people who download them.
- **Very old lines may stop building.** Today's pipeline builds the line's code; if they drift
  too far apart it fails in Release - prepare, before anything ships.
- **One pending version per line, no skipped versions, no pre-release (`-rc`) versions.**
- **A backported fix appears twice in the notes:** in the patch, and again (as the original PR
  on `main`) in the next minor.
- **A Release - publish dry run still asks for approval.**
- **Release - prepare builds without caches**, like Release - publish, so it's slower than PR
  CI's packaging.
