import { describe, expect, it } from 'vitest'
import { detectTestEdits, isTestPath, isTestRelevantPath, testEditsNote } from './testTampering'

const SUITE = [
  "import { describe, expect, it } from 'vitest'",
  "describe('add', () => {",
  "  it('adds', () => {",
  '    expect(add(1, 2)).toBe(3)',
  '  })',
  "  it('rejects strings', () => {",
  "    expect(() => add('1', 2)).toThrow()",
  '  })',
  '})',
  ''
].join('\n')

describe('isTestPath', () => {
  it.each([
    'src/a.test.ts',
    'src/a.spec.jsx',
    'web/__tests__/b.js',
    'tests/test_app.py',
    'test_app.py',
    'app_test.py',
    'pkg/server_test.go',
    'spec/models/user_spec.rb',
    'tests/integration.rs',
    'src/test/java/com/x/FooTest.java'
  ])('%s is a test file', (p) => expect(isTestPath(p)).toBe(true))

  it.each(['src/app.ts', 'src/latest.java', 'README.md', 'src/contest.py', 'tests/fixtures/data.json'])(
    '%s is not',
    (p) => expect(isTestPath(p)).toBe(false)
  )

  it('reads Windows separators', () => expect(isTestPath('src\\__tests__\\a.js')).toBe(true))

  it('counts runner configs as relevant', () => {
    expect(isTestRelevantPath('package.json')).toBe(true)
    expect(isTestRelevantPath('vitest.config.ts')).toBe(true)
    expect(isTestRelevantPath('pyproject.toml')).toBe(true)
    expect(isTestRelevantPath('src/index.ts')).toBe(false)
  })
})

describe('detectTestEdits: test files', () => {
  it('flags a deleted test file with assertions', () => {
    expect(detectTestEdits([{ path: 'src/add.test.ts', before: SUITE, after: null }])).toEqual([
      { path: 'src/add.test.ts', kind: 'deleted', detail: 'deleted, with 2 assertions' }
    ])
  })

  it('does not flag a test file moved with its assertions', () => {
    expect(
      detectTestEdits([
        { path: 'src/add.test.ts', before: SUITE, after: null },
        { path: 'src/math/add.test.ts', before: null, after: SUITE }
      ])
    ).toEqual([])
  })

  it('does not flag a deleted test helper with nothing in it to lose', () => {
    const helper = 'export const fixture = { a: 1 }\n'
    expect(detectTestEdits([{ path: 'tests/helpers.ts', before: helper, after: null }])).toEqual([])
  })

  it('flags an added .skip, naming the line', () => {
    const after = SUITE.replace("it('rejects strings'", "it.skip('rejects strings'")
    expect(detectTestEdits([{ path: 'src/add.test.ts', before: SUITE, after }])).toEqual([
      { path: 'src/add.test.ts', kind: 'skip', detail: "added it.skip('rejects strings', () => {" }
    ])
  })

  it.each([
    ['xit', SUITE.replace("it('adds'", "xit('adds'")],
    ['it.todo', SUITE.replace("it('adds', () => {", "it.todo('adds', () => {")],
    ['describe.skip', SUITE.replace("describe('add'", "describe.skip('add'")]
  ])('flags an added %s', (_name, after) => {
    expect(detectTestEdits([{ path: 'src/add.test.ts', before: SUITE, after }]).map((e) => e.kind)).toEqual(['skip'])
  })

  it('flags pytest, unittest, go, and rust skip markers', () => {
    const py = 'def test_a():\n    assert a() == 1\n'
    const go = 'func TestA(t *testing.T) {\n\tif a() != 1 {\n\t\tt.Errorf("bad")\n\t}\n}\n'
    const rs = '#[test]\nfn a() {\n    assert_eq!(a(), 1);\n}\n'
    const edits = detectTestEdits([
      { path: 'tests/test_a.py', before: py, after: `import pytest\n\n@pytest.mark.skip(reason="flaky")\n${py}` },
      { path: 'tests/test_b.py', before: py, after: `import unittest\n@unittest.skip("later")\n${py}` },
      { path: 'a_test.go', before: go, after: go.replace('{\n\tif', '{\n\tt.Skip("later")\n\tif') },
      { path: 'tests/a.rs', before: rs, after: rs.replace('#[test]', '#[test]\n#[ignore]') }
    ])
    expect(edits.map((e) => [e.path, e.kind])).toEqual([
      ['tests/test_a.py', 'skip'],
      ['tests/test_b.py', 'skip'],
      ['a_test.go', 'skip'],
      ['tests/a.rs', 'skip']
    ])
  })

  it('flags an added .only as a focus', () => {
    const after = SUITE.replace("it('adds'", "it.only('adds'")
    expect(detectTestEdits([{ path: 'src/add.test.ts', before: SUITE, after }])).toEqual([
      { path: 'src/add.test.ts', kind: 'focus', detail: "added it.only('adds', () => {" }
    ])
  })

  it('does not flag a skip that was already there', () => {
    const before = SUITE.replace("it('adds'", "it.skip('adds'")
    const after = before.replace('toBe(3)', 'toEqual(3)')
    expect(detectTestEdits([{ path: 'src/add.test.ts', before, after }])).toEqual([])
  })

  it('does not count a commented-out skip as one', () => {
    const after = SUITE.replace("  it('adds'", "  // it.skip('adds') was flaky once\n  it('adds'")
    expect(detectTestEdits([{ path: 'src/add.test.ts', before: SUITE, after }])).toEqual([])
  })

  it('flags removed assertions', () => {
    const after = SUITE.replace("    expect(() => add('1', 2)).toThrow()\n", '')
    expect(detectTestEdits([{ path: 'src/add.test.ts', before: SUITE, after }])).toEqual([
      { path: 'src/add.test.ts', kind: 'asserts', detail: '1 assertion, down from 2' }
    ])
  })

  it('counts a commented-out assertion as removed', () => {
    const after = SUITE.replace("    expect(() => add('1', 2))", "    // expect(() => add('1', 2))")
    expect(detectTestEdits([{ path: 'src/add.test.ts', before: SUITE, after }]).map((e) => e.kind)).toEqual(['asserts'])
  })

  it('does not flag assertions moved to another test file', () => {
    const one = SUITE.replace("    expect(() => add('1', 2)).toThrow()\n", '')
    const other = "it('rejects strings', () => {\n  expect(() => add('1', 2)).toThrow()\n})\n"
    expect(
      detectTestEdits([
        { path: 'src/add.test.ts', before: SUITE, after: one },
        { path: 'src/add-errors.test.ts', before: null, after: other }
      ])
    ).toEqual([])
  })

  it('does not flag added tests or assertions, or a brand-new test file', () => {
    const more = SUITE.replace('  })\n})', "  })\n  it('adds zero', () => {\n    expect(add(0, 0)).toBe(0)\n  })\n})")
    expect(
      detectTestEdits([
        { path: 'src/add.test.ts', before: SUITE, after: more },
        { path: 'src/new.test.ts', before: null, after: SUITE.replace("it('adds'", "it.skip('adds'") }
      ])
    ).toEqual([])
  })

  it('flags a skip the moved test gained on the way', () => {
    const after = SUITE.replace("it('adds'", "it.skip('adds'")
    expect(
      detectTestEdits([
        { path: 'src/add.test.ts', before: SUITE, after: null },
        { path: 'src/math/add.test.ts', before: null, after }
      ]).map((e) => [e.path, e.kind])
    ).toEqual([['src/math/add.test.ts', 'skip']])
  })

  it('ignores files that are not tests', () => {
    const src = 'export function add(a, b) {\n  assert(typeof a === "number")\n  return a + b\n}\n'
    expect(
      detectTestEdits([
        { path: 'src/add.ts', before: src, after: 'export const add = (a, b) => a + b\n' },
        { path: 'src/old.ts', before: src, after: null }
      ])
    ).toEqual([])
  })
})

describe('detectTestEdits: scripts and configs', () => {
  const pkg = (test: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ name: 'x', scripts: { test, build: 'tsc' }, ...extra }, null, 2)

  it.each([
    ['vitest run || true', 'an exit status that is always 0'],
    ['vitest run; exit 0', 'an exit status that is always 0'],
    ['jest --passWithNoTests', '--passWithNoTests']
  ])('flags a test script that gained %s', (next, text) => {
    expect(detectTestEdits([{ path: 'package.json', before: pkg('vitest run'), after: pkg(next) }])).toEqual([
      { path: 'package.json', kind: 'script', detail: `"test" gained ${text}: ${next}` }
    ])
  })

  it('flags a test script that no longer runs tests, or was removed', () => {
    expect(
      detectTestEdits([{ path: 'package.json', before: pkg('vitest run'), after: pkg('echo "no tests"') }])[0]
    ).toMatchObject({ kind: 'script', detail: '"test" no longer runs tests: echo "no tests"' })
    const gone = JSON.stringify({ scripts: { build: 'tsc' } })
    expect(detectTestEdits([{ path: 'package.json', before: pkg('vitest run'), after: gone }])[0]).toMatchObject({
      kind: 'script',
      detail: 'removed the "test" script'
    })
  })

  it('does not flag other package.json changes', () => {
    expect(
      detectTestEdits([
        { path: 'package.json', before: pkg('vitest run'), after: pkg('vitest run --reporter=dot', { version: '2.0.0' }) },
        { path: 'web/package.json', before: '{not json', after: '{}' }
      ])
    ).toEqual([])
  })

  it('flags a jest block in package.json that changed which tests run', () => {
    const before = pkg('jest', { jest: { testMatch: ['**/*.test.js'] } })
    const after = pkg('jest', { jest: { testMatch: ['**/*.test.js'], testPathIgnorePatterns: ['slow'] } })
    expect(detectTestEdits([{ path: 'package.json', before, after }])).toEqual([
      { path: 'package.json', kind: 'config', detail: 'changed which tests jest runs' }
    ])
  })

  it('flags a vitest config whose exclude grew, across lines', () => {
    const before = "export default {\n  test: {\n    exclude: [\n      'node_modules'\n    ]\n  }\n}\n"
    const after = "export default {\n  test: {\n    exclude: [\n      'node_modules',\n      'src/add.test.ts'\n    ]\n  }\n}\n"
    expect(detectTestEdits([{ path: 'vitest.config.ts', before, after }])).toEqual([
      { path: 'vitest.config.ts', kind: 'config', detail: 'changed exclude' }
    ])
  })

  it('reads only the test block of a vite config', () => {
    const base = (deps: string, ex: string): string =>
      `export default {\n  optimizeDeps: { include: [${deps}] },\n  test: {\n    include: ['src/**/*.test.ts'],\n    exclude: [${ex}]\n  }\n}\n`
    expect(detectTestEdits([{ path: 'vite.config.ts', before: base("'a'", ''), after: base("'a', 'b'", '') }])).toEqual([])
    expect(
      detectTestEdits([{ path: 'vite.config.ts', before: base("'a'", ''), after: base("'a'", "'src/x.test.ts'") }])
    ).toEqual([{ path: 'vite.config.ts', kind: 'config', detail: 'changed exclude' }])
  })

  it('flags pytest addopts gaining -k, only inside the pytest section', () => {
    const toml = (addopts: string, black: string): string =>
      `[tool.black]\nexclude = "${black}"\n\n[tool.pytest.ini_options]\naddopts = "${addopts}"\ntestpaths = ["tests"]\n`
    expect(
      detectTestEdits([{ path: 'pyproject.toml', before: toml('-q', 'a'), after: toml('-q -k "not slow"', 'a') }])
    ).toEqual([{ path: 'pyproject.toml', kind: 'config', detail: 'changed addopts' }])
    expect(detectTestEdits([{ path: 'pyproject.toml', before: toml('-q', 'a'), after: toml('-q', 'b') }])).toEqual([])
    const ini = '[pytest]\naddopts =\n    -q\n'
    expect(
      detectTestEdits([{ path: 'pytest.ini', before: ini, after: `${ini}    --deselect tests/test_a.py::test_x\n` }])
    ).toEqual([{ path: 'pytest.ini', kind: 'config', detail: 'changed addopts' }])
  })

  it('does not flag a config the turn created', () => {
    expect(detectTestEdits([{ path: 'vitest.config.ts', before: null, after: "export default { test: { exclude: ['x'] } }" }])).toEqual([])
  })
})

describe('testEditsNote', () => {
  it('lists the edits and asks for a restore or an explanation', () => {
    const note = testEditsNote([{ path: 'src/a.test.ts', kind: 'skip', detail: "added it.skip('x'" }])
    expect(note).toContain("- src/a.test.ts: added it.skip('x'")
    expect(note).toContain('restore the test')
    expect(note).toContain('say so plainly in your reply')
    expect(note).not.toContain('—')
  })
})
