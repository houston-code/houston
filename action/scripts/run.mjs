#!/usr/bin/env node
// Entry point for the action's "Run Houston" step (see action.yml and lib/run.mjs).
import { exec } from '../lib/exec.mjs'
import { run } from '../lib/run.mjs'

run({ env: process.env, exec }).then(
  (code) => process.exit(code),
  (e) => {
    process.stdout.write(`::error title=Houston::${String(e?.message ?? e).replace(/[\r\n]+/g, ' ').replace(/::/g, ': :')}\n`)
    process.exit(1)
  }
)
