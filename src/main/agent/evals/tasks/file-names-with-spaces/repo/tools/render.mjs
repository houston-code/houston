#!/usr/bin/env node
// Stand-in for the PDF renderer the app shells out to: `render.mjs --in <file> --out <file> [--title <text>]`.
// It writes "rendered <title>: <input contents>" to the output file.
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const input = opt('--in')
const output = opt('--out')
if (!input || !output) {
  console.error(`usage: render.mjs --in <file> --out <file> [--title <text>] (got ${JSON.stringify(args)})`)
  process.exit(2)
}
writeFileSync(output, `rendered ${opt('--title') ?? 'untitled'}: ${readFileSync(input, 'utf8')}`)
