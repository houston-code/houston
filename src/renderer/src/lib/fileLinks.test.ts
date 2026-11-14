import { describe, expect, it } from 'vitest'
import {
  fileTargetFromHref,
  fileTargetFromPath,
  filesPanelKey,
  splitLine,
  toolFileTarget,
  workspaceRelative
} from './fileLinks'

const WS = '/home/me/proj'

describe('workspaceRelative', () => {
  it('keeps a plain relative path and tidies it', () => {
    expect(workspaceRelative('src/a.ts', WS)).toBe('src/a.ts')
    expect(workspaceRelative('./src//a.ts', WS)).toBe('src/a.ts')
    expect(workspaceRelative('src/x/../a.ts', WS)).toBe('src/a.ts')
    expect(workspaceRelative('src\\a.ts', WS)).toBe('src/a.ts')
  })
  it('refuses a path that climbs out of the workspace', () => {
    expect(workspaceRelative('../secret', WS)).toBeNull()
    expect(workspaceRelative('src/../../secret', WS)).toBeNull()
    expect(workspaceRelative('.', WS)).toBeNull()
    expect(workspaceRelative('', WS)).toBeNull()
  })
  it('takes an absolute path only inside the workspace', () => {
    expect(workspaceRelative('/home/me/proj/src/a.ts', WS)).toBe('src/a.ts')
    expect(workspaceRelative('/home/me/proj-other/a.ts', WS)).toBeNull()
    expect(workspaceRelative('/home/me/proj/../other/a.ts', WS)).toBeNull()
    expect(workspaceRelative('/etc/passwd', WS)).toBeNull()
    expect(workspaceRelative('/home/me/proj', WS)).toBeNull()
  })
  it('compares Windows paths without regard to case', () => {
    expect(workspaceRelative('c:\\Users\\Me\\Proj\\src\\a.ts', 'C:\\Users\\me\\proj')).toBe('src/a.ts')
    expect(workspaceRelative('D:\\proj\\a.ts', 'C:\\proj')).toBeNull()
  })
})

describe('splitLine', () => {
  it('reads the line forms a reply uses', () => {
    expect(splitLine('a.ts#L10')).toEqual({ path: 'a.ts', line: 10 })
    expect(splitLine('a.ts#L10-L20')).toEqual({ path: 'a.ts', line: 10 })
    expect(splitLine('a.ts:12')).toEqual({ path: 'a.ts', line: 12 })
    expect(splitLine('a.ts:12:4')).toEqual({ path: 'a.ts', line: 12 })
    expect(splitLine('docs/x.md#usage')).toEqual({ path: 'docs/x.md' })
    expect(splitLine('a.ts#L0')).toEqual({ path: 'a.ts' })
    expect(splitLine('C:/proj/a.ts:3')).toEqual({ path: 'C:/proj/a.ts', line: 3 })
  })
})

describe('fileTargetFromHref', () => {
  it('opens a relative link, with its line', () => {
    expect(fileTargetFromHref('README.md', WS)).toEqual({ path: 'README.md' })
    expect(fileTargetFromHref('src/a.ts#L7', WS)).toEqual({ path: 'src/a.ts', line: 7 })
    expect(fileTargetFromHref('src/my%20file.ts', WS)).toEqual({ path: 'src/my file.ts' })
    expect(fileTargetFromHref('src/a.ts?plain=1#L3', WS)).toEqual({ path: 'src/a.ts', line: 3 })
  })
  it('never opens a scheme, an anchor, or a path outside the workspace', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'vbscript:x',
      '#heading',
      '//evil.example/x',
      '../outside.md',
      '/etc/passwd',
      'src/%2e%2e/%2e%2e/x',
      'a%0Ab',
      '%E0%A4%A'
    ]) {
      expect(fileTargetFromHref(href, WS), href).toBeNull()
    }
  })
  it('opens nothing without a workspace', () => {
    expect(fileTargetFromHref('README.md', null)).toBeNull()
  })
})

describe('tool and receipt paths', () => {
  it('takes a file tool path, and a read offset as its line', () => {
    expect(toolFileTarget('read_file', { path: 'src/a.ts', offset: 40 }, WS)).toEqual({ path: 'src/a.ts', line: 40 })
    expect(toolFileTarget('edit_file', { path: `${WS}/src/a.ts` }, WS)).toEqual({ path: 'src/a.ts' })
    expect(toolFileTarget('run_shell', { path: 'x' }, WS)).toBeNull()
    expect(toolFileTarget('read_file', { path: '/etc/hosts' }, WS)).toBeNull()
    expect(toolFileTarget('read_file', undefined, WS)).toBeNull()
  })
  it('ignores a line that is not a positive whole number', () => {
    expect(fileTargetFromPath('a.ts', WS, 0)).toEqual({ path: 'a.ts' })
    expect(fileTargetFromPath('a.ts', WS, 2.5)).toEqual({ path: 'a.ts' })
  })
})

describe('filesPanelKey', () => {
  it('changes on every reveal, even of the same file and line', () => {
    // Opening a link, picking another file in the tree, then opening the same link
    // again must remount the panel onto the link's file.
    expect(filesPanelKey(WS, 'src/a.ts', 3, 1)).not.toBe(filesPanelKey(WS, 'src/a.ts', 3, 2))
  })
  it('changes with the target and workspace', () => {
    expect(filesPanelKey(WS, 'src/a.ts', undefined, 1)).not.toBe(filesPanelKey(WS, 'src/b.ts', undefined, 1))
    expect(filesPanelKey(WS, 'src/a.ts', undefined, 1)).not.toBe(filesPanelKey('/other', 'src/a.ts', undefined, 1))
  })
})
