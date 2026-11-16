#!/usr/bin/env node
// Write the ACP registry entry Harbor launches Houston from, for one run.
//
//   node bench/terminal-bench/agent-entry.mjs <template.json>                       # as written
//   node bench/terminal-bench/agent-entry.mjs <template.json> --release <version>   # a published version
//   node bench/terminal-bench/agent-entry.mjs <template.json> --pkg <file.tgz> [--label <build>]
//
// Prints the entry as JSON. Harbor's npx distribution runs `npx -y <package> <args...>` in the
// task container. --release pins the published @houston-code/cli. --pkg runs a local build
// instead: run.sh mounts the tarball's folder read-only at PKG_MOUNT, and the entry names the
// tarball as `--package=<path>` with the `houston` command as the first argument, so npx
// installs the tarball and runs its bin with the template's flags.
//
// The pure builders are unit-tested in agent-entry.test.mjs.

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE = '@houston-code/cli'
export const PKG_MOUNT = '/opt/houston-pkg'
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const LABEL = /^[0-9A-Za-z][0-9A-Za-z.-]*$/
const USAGE = 'usage: agent-entry.mjs <template.json> [--release <version> | --pkg <file.tgz> [--label <build>]]'

function npxOf(template) {
  const npx = template?.distribution?.npx
  if (!npx || typeof npx.package !== 'string' || !Array.isArray(npx.args)) {
    throw new Error('the template needs a distribution.npx entry with a package and args')
  }
  return npx
}

/** The template pinned to a published release of the CLI package. */
export function releaseEntry(template, version) {
  if (!VERSION.test(version)) throw new Error(`--release needs a version like 0.12.1 (got ${JSON.stringify(version)})`)
  const npx = npxOf(template)
  return { ...template, version, distribution: { npx: { ...npx, package: `${PACKAGE}@${version}` } } }
}

/**
 * The template pointed at a local package tarball (`npm pack` of scripts/stage-npm-cli.mjs's
 * output, named houston-code-cli-<version>.tgz), mounted at PKG_MOUNT. The entry's version is
 * the tarball's plus `+<label>`, so the build shows in every trial's result.
 */
export function localEntry(template, tgzName, label = 'local') {
  const match = /^houston-code-cli-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(tgzName)
  if (!match) throw new Error(`--pkg needs a houston-code-cli-<version>.tgz from npm pack (got ${JSON.stringify(tgzName)})`)
  if (!LABEL.test(label)) throw new Error(`--label may hold only letters, digits, dots and hyphens (got ${JSON.stringify(label)})`)
  const npx = npxOf(template)
  return {
    ...template,
    version: `${match[1]}+${label}`,
    description: `${template.description} (local build ${label})`,
    distribution: { npx: { ...npx, package: `--package=${PKG_MOUNT}/${tgzName}`, args: ['houston', ...npx.args] } }
  }
}

function parseArgs(argv) {
  const opts = { template: null, release: null, pkg: null, label: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--release' || arg === '--pkg' || arg === '--label') {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      opts[arg.slice(2)] = value
    } else if (arg.startsWith('-') || opts.template !== null) throw new Error(`unexpected argument: ${arg}`)
    else opts.template = arg
  }
  if (opts.template === null) throw new Error('a template file is required')
  if (opts.release !== null && opts.pkg !== null) throw new Error('--release and --pkg are alternatives')
  if (opts.label !== undefined && opts.pkg === null) throw new Error('--label goes with --pkg')
  return opts
}

/** Runs the CLI and returns its exit code, so the test can drive it without a child process. */
export function main(argv, out = process.stdout, err = process.stderr) {
  try {
    const opts = parseArgs(argv)
    const template = JSON.parse(readFileSync(opts.template, 'utf8'))
    npxOf(template)
    const entry =
      opts.release !== null
        ? releaseEntry(template, opts.release)
        : opts.pkg !== null
          ? localEntry(template, basename(opts.pkg), opts.label)
          : template
    out.write(`${JSON.stringify(entry, null, 2)}\n`)
    return 0
  } catch (e) {
    err.write(`agent-entry.mjs: ${e.message}\n${USAGE}\n`)
    return 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
