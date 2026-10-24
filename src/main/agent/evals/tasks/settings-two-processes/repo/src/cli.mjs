// The terminal client's settings commands, run as their own process:
//   node src/cli.mjs <file> get
//   node src/cli.mjs <file> set <key> <json value>
//   node src/cli.mjs <file> allow <command>
//   node src/cli.mjs <file> revoke <command>
import { openSettings } from './settings.mjs'

const [file, command, ...args] = process.argv.slice(2)
const settings = openSettings(file)
switch (command) {
  case 'get':
    console.log(JSON.stringify(settings.get()))
    break
  case 'set':
    settings.update({ [args[0]]: JSON.parse(args[1]) })
    break
  case 'allow':
    settings.allow(args.join(' '))
    break
  case 'revoke':
    settings.revoke(args.join(' '))
    break
  default:
    console.error(`unknown command: ${command}`)
    process.exit(2)
}
