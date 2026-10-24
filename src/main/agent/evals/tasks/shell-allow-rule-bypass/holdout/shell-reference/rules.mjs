import { splitCommand, UnparseableCommand } from './split.mjs'

/**
 * Allow rules are command prefixes: "npm test" allows `npm test` and
 * `npm test -- --watch`, but not `npm testing`. A trailing " *" is spelled out for
 * readability and means the same thing.
 */
function matches(command, rule) {
  const prefix = rule.replace(/ \*$/, '')
  return command === prefix || command.startsWith(`${prefix} `)
}

/**
 * Is every program in `line` allowed by some rule? A line the shell couldn't parse
 * (an unterminated quote or substitution) is never allowed.
 */
export function isAllowed(line, rules) {
  let commands
  try {
    commands = splitCommand(line)
  } catch (err) {
    if (err instanceof UnparseableCommand) return false
    throw err
  }
  return commands.length > 0 && commands.every((c) => rules.some((r) => matches(c, r)))
}
