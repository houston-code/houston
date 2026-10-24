# CLI distribution channels

The standalone CLI (`houston-cli.cjs`, built by `scripts/build-cli.mjs`) ships through
these channels on top of the GitHub Release asset. Every one installs the same file,
checked against the release's `SHA256SUMS`, and every one installs the command as
`houston`.

| Channel | Install command | Source here | Published by |
|---|---|---|---|
| npm (and bun) | `npm i -g @houston-code/cli` | `packaging/npm/`, `scripts/stage-npm-cli.mjs` | `distribute` job, when `NPM_PUBLISH` is `true` |
| Homebrew tap | `brew install houston-code/tap/houston` | `packaging/homebrew/houston.rb.tmpl` | `distribute` job, when `HOMEBREW_TAP` is `true` |
| AUR (paru, yay) | `paru -S houston-bin` | `scripts/render-packaging.mjs` | `distribute` job, when `AUR_PUBLISH` is `true` |
| Install script | `curl -fsSL https://houstoncode.ai/install.sh \| sh` | `website/public/install.sh` | Cloudflare Pages, with the website |

The `distribute` job in `.github/workflows/release-publish.yml` runs after the release is
public. It downloads `houston-cli.cjs` and `SHA256SUMS` from the release, checks the
signature on `SHA256SUMS` (cosign, keyless, against this workflow) and the CLI's hash,
renders the formula and PKGBUILD (`scripts/render-packaging.mjs`, uploaded as the
`cli-packaging` artifact on every run), then publishes to each channel whose variable is
on. A channel that is off is skipped, so the release never fails on an unregistered one.
The job runs only for a release that becomes `latest`: a patch to an older release line
or a pre-release leaves every channel on the current version.

The install script needs no setup: it reads the latest GitHub Release directly.

## One-time setup

Use the project address (`dev@houstoncode.ai`) for every registry account, never a
personal one: npm publishes maintainer emails in package metadata, and AUR packages carry
the maintainer address. Turn on 2FA everywhere.

### npm

1. Sign in at npmjs.com and create the organization `houston-code` (free plan). This
   claims the `@houston-code` scope.
2. Publish the first version by hand, since trusted publishing is configured per existing
   package. Publish the current release's own file and manifest, so the package matches it:
   ```bash
   v=0.9.0 && d="$(mktemp -d)" && git fetch --tags origin
   gh release download "v$v" -R houston-code/houston -p houston-cli.cjs -p SHA256SUMS -D "$d"
   (cd "$d" && shasum -a 256 -c --ignore-missing SHA256SUMS)
   git show "v$v:package.json" > "$d/package.json"
   node scripts/stage-npm-cli.mjs --cli "$d/houston-cli.cjs" --manifest "$d/package.json"
   cd out/npm-cli && npm publish --access public
   ```
3. On the package page, open **Settings > Trusted Publisher > GitHub Actions** and enter
   organization `houston-code`, repository `houston`, workflow `release-publish.yml`,
   environment `release`.
4. In the same settings, set publishing access to require 2FA and disallow tokens.
5. In the GitHub repo, add the Actions variable `NPM_PUBLISH` = `true`.

Before publishing, `scripts/check-npm-trusted-publishing.mjs` performs the trusted-publishing
token exchange itself. If npm rejects it, the job fails with the registry's reason and the
repository, workflow and environment the Trusted Publisher entry has to name. (Without this
check npm reports only `ENEEDAUTH`.) Fix the entry on npmjs.com, then re-run the failed
`distribute` job: it skips any channel already at the release's version.

### Homebrew tap

1. Create the public repo `houston-code/homebrew-tap` (the `homebrew-` prefix is what
   makes `houston-code/tap` resolve).
2. Seed it: download `cli-packaging` from a release run (or run
   `scripts/render-packaging.mjs` yourself) and commit `homebrew/houston.rb` as
   `Formula/houston.rb`. Check it with `brew install houston-code/tap/houston`,
   `brew test houston` and `brew audit --strict houston`.
3. Create a fine-grained token with **Contents: read and write** on
   `houston-code/homebrew-tap` only, and store it as the `HOMEBREW_TAP_TOKEN` secret in
   the `release` environment.
4. Add the Actions variable `HOMEBREW_TAP` = `true`.

### AUR

1. Register at aur.archlinux.org and add an SSH public key to the account. Use a key made
   for this purpose only (`ssh-keygen -t ed25519 -f aur_houston -C dev@houstoncode.ai`).
2. Create the package by pushing the first version by hand:
   ```bash
   git clone ssh://aur@aur.archlinux.org/houston-bin.git
   cp <cli-packaging>/aur/PKGBUILD <cli-packaging>/aur/.SRCINFO houston-bin/
   ```
   On an Arch machine or container, run `makepkg -si` there first to check the build,
   and `makepkg --printsrcinfo | diff - .SRCINFO` to check the generated `.SRCINFO`.
   Then commit and `git push`.
3. Store the private key as the `AUR_SSH_KEY` secret in the `release` environment.
4. Add the Actions variable `AUR_KNOWN_HOSTS` with the `aur.archlinux.org` known_hosts
   line, after checking its fingerprint against the ones listed on aur.archlinux.org.
5. Add the Actions variable `AUR_PUBLISH` = `true`.

## Not supported

- **PyPI and crates.io.** The CLI is JavaScript and needs Node; a Python or Rust wrapper
  would still need Node. Both registries also forbid reserving names without a working
  package.
- **apt.** Ubuntu LTS releases ship Node older than 22, so a CLI `.deb` could not satisfy
  its own dependency from the distribution. A signed apt repository is tracked for the
  desktop `.deb` instead.
