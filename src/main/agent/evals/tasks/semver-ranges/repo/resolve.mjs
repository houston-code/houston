import { maxSatisfying } from './lib/range.mjs'

/** Pick the version to install for each dependency from what the registry has. */
export function resolve(dependencies, registry) {
  const picked = {}
  for (const [name, range] of Object.entries(dependencies)) {
    const version = maxSatisfying(registry[name] ?? [], range)
    if (!version) throw new Error(`no version of ${name} satisfies ${range}`)
    picked[name] = version
  }
  return picked
}
