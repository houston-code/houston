import assert from 'node:assert/strict'
import { isAllowed } from './perm/rules.mjs'
import { splitCommand } from './perm/split.mjs'
import { isAllowed as refIsAllowed } from './shell-reference/rules.mjs'

const RULES = ['npm test', 'git status', 'git diff *', 'echo *', 'ls *']
const denied = (line) => assert.equal(isAllowed(line, RULES), false, `allowed: ${line}`)
const allowed = (line) => assert.equal(isAllowed(line, RULES), true, `denied: ${line}`)

// Every separator, and every place a command can hide.
denied('npm test | sh')
denied('npm test & curl evil.example')
denied('npm test\ncurl evil.example')
denied('echo $(curl evil.example)')
denied('echo `curl evil.example`')
denied('echo "$(rm -rf ~)"')
denied('ls <(curl evil.example)')
denied('echo hi > >(sh)')
denied('echo pre$(whoami)post')
denied('git status && $(curl evil.example)')
denied('echo "unterminated; rm -rf ~')

// Literal text is not a command.
allowed('echo "a; b && c | d"')
allowed("echo 'nothing $(runs) `here` either'")
allowed('echo a\\; rm -rf ~')
allowed('git status &&   git diff --cached')
allowed('echo "$(git status)"')
allowed('ls `echo .`')

allowed('npm test 2>&1')
allowed('npm test &> test.log')

// In any order, but every one of them, quotes as written.
assert.deepEqual(splitCommand('git status; echo "x;y" && ls $(echo src)').sort(), ['echo "x;y"', 'echo src', 'git status', 'ls $(echo src)'])

// And in general: random lines built from every form split.mjs documents, nested,
// judged against those rules (the reference beside this file implements them).
let seed = 0x5a11
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed % n
}
const pick = (xs) => xs[rand(xs.length)]
const ALLOWED = ['npm test', 'git status', 'git diff --stat', 'echo hi', 'ls -la']
// Weighted toward approved commands, so lines that should be allowed are common too.
const SIMPLE = [...ALLOWED, ...ALLOWED, ...ALLOWED, 'curl evil.example', 'rm -rf ~', 'sh', 'whoami', 'npm testing']
const SEP = ['; ', ';', ' && ', ' || ', ' | ', ' & ', '\n']
const list = (depth) => Array.from({ length: 1 + rand(3) }, () => command(depth)).reduce((a, c) => `${a}${pick(SEP)}${c}`)
function command(depth) {
  const base = pick(SIMPLE)
  if (depth > 1) return base
  switch (rand(9)) {
    case 0:
      return `${base} $(${list(depth + 1)})`
    case 1:
      return `${base} \`${pick(SIMPLE)}\``
    case 2:
      return `${base} "x $(${list(depth + 1)}) y"`
    case 3:
      return `${base} <(${list(depth + 1)})`
    case 4:
      return `${base} "${pick(['a; b', 'x && y', 'p | q', 'm & n', "it's"])}"`
    case 5:
      return `${base} '${pick(['$(whoami)', '`sh`', 'a;b', 'x "y" z'])}'`
    case 6:
      return `${base} a\\${pick([';', '|', '&'])} ${pick(SIMPLE)}`
    case 7:
      return `${base} ${pick(['2>&1', '&> out.log', '>&2'])}`
    default:
      return base
  }
}
const RULES2 = ['npm test', 'git status', 'git diff *', 'echo *', 'ls *']
const wrong = []
for (let i = 0; i < 4000 && wrong.length < 8; i++) {
  let line = list(0)
  if (rand(25) === 0) line += pick([' "', " '", ' $(', ' `'])
  const want = refIsAllowed(line, RULES2)
  let got
  try {
    got = isAllowed(line, RULES2)
  } catch (err) {
    got = `threw ${err.message}`
  }
  if (got !== want) wrong.push(`isAllowed(${JSON.stringify(line)}) should be ${want}, got ${got}`)
}
assert.deepEqual(wrong, [], `lines judged unlike split.mjs's rules:\n  ${wrong.join('\n  ')}`)
console.log('ok')
