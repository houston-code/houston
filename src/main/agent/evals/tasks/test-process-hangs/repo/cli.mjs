// The item service from the command line:
//   node cli.mjs get <path> [--user <name>]   print one item as JSON
//   node cli.mjs --help
import { appendFileSync, readFileSync } from 'node:fs'
import { createService } from './src/service.mjs'

const USAGE = 'usage: node cli.mjs get <path> [--user <name>]'

async function main(argv) {
  const items = JSON.parse(readFileSync(new URL('./data/items.json', import.meta.url), 'utf8'))
  const service = createService({
    loadItem: async (path) => items[path] ?? null,
    auditSink: { write: (batch) => appendFileSync('audit.log', batch.map((e) => JSON.stringify(e)).join('\n') + '\n') }
  })
  if (argv.includes('--help') || argv[0] !== 'get') {
    console.log(USAGE)
    return
  }
  const userAt = argv.indexOf('--user')
  const user = userAt === -1 ? 'cli' : argv[userAt + 1]
  const res = await service.handle({ user, path: argv[1] })
  console.log(JSON.stringify(res))
  await service.close()
}

await main(process.argv.slice(2))
