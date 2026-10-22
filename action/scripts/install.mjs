#!/usr/bin/env node
// Entry point for the action's "Install the Houston CLI" step (see lib/install.mjs).
import { exec } from '../lib/exec.mjs'
import { install } from '../lib/install.mjs'

install({ env: process.env, exec }).then(
  () => process.exit(0),
  (e) => {
    process.stdout.write(`::error title=Houston::${String(e?.message ?? e).replace(/[\r\n]+/g, ' ').replace(/::/g, ': :')}\n`)
    process.exit(1)
  }
)
