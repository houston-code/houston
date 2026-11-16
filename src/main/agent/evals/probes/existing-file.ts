import { callTool, say, turn, type ProbeTask } from '../types'
import { codeBlocks, fail, listFiles, pass, readText, writeFiles } from './kit'

const FILES: Record<string, string> = {
  'hello.py': 'def main():\n    print("Hello, world!")\n\n\nif __name__ == "__main__":\n    main()\n',
  'README.md': '# greeter\n\nA small example project.\n'
}

/**
 * Asked for something the project already has, the agent should say so rather than
 * write a second copy, and point at the file rather than paste it into the reply.
 */
export const probe: ProbeTask = {
  id: 'existing-file',
  title: 'Asked for a file that already exists: no duplicate file, no pasted contents',
  prompt: 'Create a hello world script in Python for this project.',
  maxActions: 4,
  setup: (ws) => writeFiles(ws, FILES),
  grade(run, ws) {
    const added = listFiles(ws).filter((f) => !(f in FILES) && f.endsWith('.py'))
    if (added.length) return fail(`wrote another script beside hello.py: ${added.join(', ')}`)
    // Lines of any script in the workspace, long enough that a match is the file, not a word.
    const scriptLines = new Set(
      listFiles(ws)
        .filter((f) => f.endsWith('.py'))
        .flatMap((f) => (readText(ws, f) ?? '').split('\n'))
        .map((l) => l.trim())
        .filter((l) => l.length >= 8)
    )
    const pasted = codeBlocks(run.finalText)
      .flatMap((b) => b.split('\n'))
      .map((l) => l.trim())
      .filter((l) => scriptLines.has(l))
    if (pasted.length) return fail(`pasted the script into the reply: ${pasted[0]}`)
    return pass(run.finalText.trim() ? 'pointed at the existing hello.py' : 'wrote no second script')
  },
  passScript: [
    turn(callTool('p1', 'read_file', { path: 'hello.py' })),
    turn(say('This project already has `hello.py`, which prints a greeting. Run it with:\n\n```\npython hello.py\n```'))
  ],
  failScript: [
    turn(callTool('f1', 'write_file', { path: 'hello_world.py', content: 'print("Hello, world!")\n' })),
    turn(say('Created `hello_world.py`:\n\n```python\nprint("Hello, world!")\n```'))
  ]
}
