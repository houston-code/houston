import { describe, expect, it } from 'vitest'
import {
  buildBwrapArgs,
  bwrapShell,
  BubblewrapBackend,
  dedupeExisting,
  linuxTmpDirs,
  probeBwrapUsable,
  type BwrapArgsInput
} from './linux'

const base = (over: Partial<BwrapArgsInput> = {}): BwrapArgsInput => ({
  roots: ['/home/u/proj'],
  tmpDirs: ['/tmp'],
  allowNetwork: false,
  command: 'npm test',
  cwd: '/home/u/proj',
  ...over
})

/** Index of the start of the [a, b, c] subsequence in argv, or -1. */
function seqIndex(argv: string[], seq: string[]): number {
  for (let i = 0; i + seq.length <= argv.length; i++) {
    if (seq.every((s, j) => argv[i + j] === s)) return i
  }
  return -1
}

describe('buildBwrapArgs', () => {
  it('mounts the host read-only as the base layer, first', () => {
    const a = buildBwrapArgs(base())
    expect(seqIndex(a, ['--ro-bind', '/', '/'])).toBe(0)
    // exactly one read-only root mount
    expect(a.filter((x) => x === '--ro-bind')).toHaveLength(1)
  })

  it('binds each writable root read-write AFTER the read-only base', () => {
    const a = buildBwrapArgs(base({ roots: ['/a', '/b'] }))
    const ro = seqIndex(a, ['--ro-bind', '/', '/'])
    expect(seqIndex(a, ['--bind', '/a', '/a'])).toBeGreaterThan(ro)
    expect(seqIndex(a, ['--bind', '/b', '/b'])).toBeGreaterThan(ro)
  })

  it('binds temp dirs with --bind-try (tolerating a missing source)', () => {
    const a = buildBwrapArgs(base({ tmpDirs: ['/tmp', '/var/tmp'] }))
    expect(seqIndex(a, ['--bind-try', '/tmp', '/tmp'])).toBeGreaterThan(-1)
    expect(seqIndex(a, ['--bind-try', '/var/tmp', '/var/tmp'])).toBeGreaterThan(-1)
  })

  it('gates the network namespace on allowNetwork', () => {
    expect(buildBwrapArgs(base({ allowNetwork: false }))).toContain('--unshare-net')
    expect(buildBwrapArgs(base({ allowNetwork: true }))).not.toContain('--unshare-net')
    // never spuriously add a share-net flag
    expect(buildBwrapArgs(base({ allowNetwork: true }))).not.toContain('--share-net')
  })

  it('always isolates pid/ipc/uts namespaces and dies with the parent', () => {
    const a = buildBwrapArgs(base())
    for (const flag of ['--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent']) {
      expect(a).toContain(flag)
    }
  })

  it('provides a fresh /dev and /proc, never --dev-bind (host device exposure)', () => {
    const a = buildBwrapArgs(base())
    expect(seqIndex(a, ['--dev', '/dev'])).toBeGreaterThan(-1)
    expect(seqIndex(a, ['--proc', '/proc'])).toBeGreaterThan(-1)
    expect(a).not.toContain('--dev-bind')
  })

  it('never uses --new-session or --as-pid-1 (kill-tree + exit-status reporting rely on this)', () => {
    const a = buildBwrapArgs(base())
    expect(a).not.toContain('--new-session')
    expect(a).not.toContain('--as-pid-1')
  })

  it('does not touch the environment (--clearenv / --setenv) — env is inherited from spawn', () => {
    const a = buildBwrapArgs(base())
    expect(a).not.toContain('--clearenv')
    expect(a).not.toContain('--setenv')
  })

  it('changes to the cwd inside the namespace', () => {
    expect(seqIndex(buildBwrapArgs(base({ cwd: '/work/here' })), ['--chdir', '/work/here'])).toBeGreaterThan(-1)
  })

  it('ends with [shell, -c, command] and keeps the command a single argv element', () => {
    const command = 'echo "a; b" && rm -rf /tmp/x'
    const a = buildBwrapArgs(base({ command }))
    expect(a.slice(-3)).toEqual(['/bin/bash', '-c', command])
  })

  it('propagates the chosen shell', () => {
    expect(buildBwrapArgs(base({ shell: '/bin/sh' })).slice(-3)).toEqual(['/bin/sh', '-c', 'npm test'])
  })

  const proxy = { tcpPort: 9137, unixSocketPath: '/tmp/he/proxy.sock', forwarderPath: '/tmp/he/forwarder.cjs' }

  it('proxied mode KEEPS the empty network namespace — the forwarder is the only road out', () => {
    const a = buildBwrapArgs(base({ allowNetwork: true, egressProxy: proxy, nodeBin: '/usr/bin/node' }))
    expect(a).toContain('--unshare-net')
  })

  it('proxied mode makes the forwarder the entrypoint, command as verbatim child argv', () => {
    const command = 'curl https://registry.npmjs.org/ && echo "done; ok"'
    const a = buildBwrapArgs(
      base({ allowNetwork: true, egressProxy: proxy, nodeBin: '/usr/bin/node', command })
    )
    const tail = a.slice(a.indexOf('/usr/bin/node'))
    expect(tail).toEqual([
      '/usr/bin/node',
      '/tmp/he/forwarder.cjs',
      '/tmp/he/proxy.sock',
      '24127',
      '--',
      '/bin/bash',
      '-c',
      command
    ])
  })

  it('egress endpoints without a network grant stay fully denied (no forwarder)', () => {
    const a = buildBwrapArgs(base({ allowNetwork: false, egressProxy: proxy, nodeBin: '/usr/bin/node' }))
    expect(a).toContain('--unshare-net')
    expect(a).not.toContain('/tmp/he/forwarder.cjs')
    expect(a.slice(-3)).toEqual(['/bin/bash', '-c', 'npm test'])
  })

  it('a TCP-only endpoint set (no unix socket) cannot be proxied — falls back to full share, not a broken launch', () => {
    // Defensive: the loop always passes unix endpoints on Linux; if it ever
    // didn't, silently launching a forwarder pointing nowhere would break every
    // command. Full share matches the legacy allowNetwork:true meaning.
    const a = buildBwrapArgs(base({ allowNetwork: true, egressProxy: { tcpPort: 9137 } }))
    expect(a).not.toContain('--unshare-net')
    expect(a.slice(-3)).toEqual(['/bin/bash', '-c', 'npm test'])
  })
})

describe('dedupeExisting', () => {
  it('drops non-existent paths', () => {
    const out = dedupeExisting(['/a', '/missing'], {
      exists: (p) => p === '/a',
      realpath: (p) => p
    })
    expect(out).toEqual(['/a'])
  })

  it('de-duplicates by canonical (realpath) path, preserving order', () => {
    const out = dedupeExisting(['/link', '/real', '/real'], {
      exists: () => true,
      realpath: (p) => (p === '/link' ? '/real' : p)
    })
    expect(out).toEqual(['/real'])
  })

  it('drops empty entries', () => {
    expect(dedupeExisting(['', '/a'], { exists: () => true, realpath: (p) => p })).toEqual(['/a'])
  })
})

describe('linuxTmpDirs', () => {
  it('includes tmpdir and /tmp, plus $TMPDIR when set', () => {
    const dirs = linuxTmpDirs({ TMPDIR: '/scratch' })
    expect(dirs).toContain('/tmp')
    expect(dirs).toContain('/scratch')
  })
})

describe('bwrapShell', () => {
  it('prefers /bin/bash when present, else /bin/sh', () => {
    expect(bwrapShell((p) => p === '/bin/bash')).toBe('/bin/bash')
    expect(bwrapShell(() => false)).toBe('/bin/sh')
  })

  it('finds bash outside /bin (e.g. /usr/bin/bash) before dropping to /bin/sh', () => {
    expect(bwrapShell((p) => p === '/usr/bin/bash')).toBe('/usr/bin/bash')
  })
})

describe('probeBwrapUsable', () => {
  it('is true when the probe command exits cleanly', () => {
    expect(probeBwrapUsable({ exec: () => {}, shell: '/bin/sh' })).toBe(true)
  })

  it('is false when bwrap is missing or unprivileged userns is blocked', () => {
    expect(
      probeBwrapUsable({
        exec: () => {
          throw new Error('bwrap: Creating new namespace failed: Operation not permitted')
        },
        shell: '/bin/sh'
      })
    ).toBe(false)
  })

  it('exercises the network namespace in the probe (catches the userns/loopback failure)', () => {
    let seen: string[] = []
    probeBwrapUsable({
      exec: (_file, args) => {
        seen = args
      },
      shell: '/bin/sh'
    })
    expect(seen).toContain('--unshare-net')
    expect(seen).toContain('--unshare-pid')
  })
})

describe('BubblewrapBackend', () => {
  it('launches via bwrap, detached, and reports confinement honestly', () => {
    const launch = BubblewrapBackend.buildLaunch({
      command: 'echo hi',
      roots: ['/'],
      allowNetwork: false,
      cwd: '/'
    })
    expect(launch.file).toBe('bwrap')
    expect(launch.detached).toBe(true)
    expect(launch.windowsHide).toBe(false)
    expect(seqIndex(launch.args, ['--ro-bind', '/', '/'])).toBe(0)
    expect(launch.args.slice(-2)).toEqual(['-c', 'echo hi'])
    expect(BubblewrapBackend.sandboxed).toBe(true)
    expect(BubblewrapBackend.confinesNetwork).toBe(true)
  })

  it('proxied launch carries the forwarder env (RUN_AS_NODE + inner-port proxy vars)', () => {
    const launch = BubblewrapBackend.buildLaunch({
      command: 'curl https://registry.npmjs.org/',
      roots: ['/'],
      allowNetwork: true,
      egressProxy: {
        tcpPort: 9137,
        unixSocketPath: '/tmp/he/proxy.sock',
        forwarderPath: '/tmp/he/forwarder.cjs'
      },
      cwd: '/'
    })
    expect(launch.args).toContain('--unshare-net')
    expect(launch.args).toContain('/tmp/he/forwarder.cjs')
    expect(launch.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(launch.env?.HTTPS_PROXY).toBe('http://127.0.0.1:24127')
    expect(launch.env?.NO_PROXY).toContain('localhost')
  })

  it('unproxied launches carry no env overrides', () => {
    const launch = BubblewrapBackend.buildLaunch({
      command: 'echo hi',
      roots: ['/'],
      allowNetwork: true,
      cwd: '/'
    })
    expect(launch.env).toBeUndefined()
  })
})
