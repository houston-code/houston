/**
 * Memory budgets for the soak scenarios, per platform. When a change legitimately
 * moves a number, update the measurements below and the limit in the same PR.
 *
 * Two kinds of limit:
 * - JS heap checks (main heap after GC, window heap kept, page elements kept) are
 *   stable within a few MB from run to run and across machines, so they sit close
 *   to what is measured and catch a retention on their own.
 * - Process totals (working sets, the CLI's resident set) move by a few hundred MB
 *   with the machine's memory pressure and how far collection had got, and the same
 *   build has measured 5 MB and 370 MB kept. Their limits only catch a gross
 *   regression, such as a buffer that grows every turn.
 *
 * Measured, 12 turns x 12 steps (60 x 15 where noted) and a 47 MB, 400-turn chat:
 *   desktopSession  peak 957-1484 (60 x 15: 1710-2367), main heap after GC 33-41
 *                   (60 x 15: 128-129), kept 5-371, window heap kept 4 (34-35 before
 *                   the fix), page elements kept 7 (macOS laptop and runner, Linux)
 *   largeChat       opening +235 to +334, window heap open 74-75, 0.4-1.8 s, kept -5 to
 *                   107, window heap kept 2 (48 before the fix) (all three)
 *   cliSession      peak 316-562, growth turn 2 to 12 53-314, idle 117-468 (macOS,
 *                   Windows; a runner may not have handed pages back 15 s after the run); Linux idle 446, since glibc keeps the freed heap and the
 *                   idle size stays at the peak. The save-buffer regression fixed earlier
 *                   grew ~65 MB per turn, over 600 MB across this session.
 *
 * The peak grows with the session, so its limit is a base plus an allowance per tool
 * call (turns x steps): 1759 MB for the nightly 12 x 12, 2855 MB for the weekly 60 x 15.
 * What a heavy session keeps while its chat is open grows by about 12-36 MB a turn (the
 * transcript's rows and layout, its images, and the history in the main process), at
 * a steady or falling rate as the session goes on. Between collections up to as much
 * again is garbage not yet collected: 60 x 15 peaked at 1710-2367 MB but measured
 * 1115-1359 MB after GC with the chat still open. A buffer that grows every turn
 * would push either past this; a fixed limit cannot fit both session sizes.
 *
 * Window heap kept was 35-48 MB until App stopped letting its closures reach the
 * transcript: closures from the render where the chat was open kept that render's
 * scope, and with it every row of the chat. Now 2-4 MB. If this check fails, open the
 * heap snapshot it saves and follow the retainers of a row's text.
 *
 * Totals are the sum of every Electron process's working set (getAppMetrics), and the
 * CLI's are its resident set, so they compare within a platform, not across them.
 */
const BUDGETS = {
  desktopSession: {
    darwin: { peakBaseMB: 1550, peakPerCallMB: 1.45, mainHeapAfterGcMB: 160, retainedMB: 500, rendererRetainedMB: 15, domNodesRetained: 1500 },
    linux: { peakBaseMB: 1550, peakPerCallMB: 1.45, mainHeapAfterGcMB: 160, retainedMB: 500, rendererRetainedMB: 15, domNodesRetained: 1500 },
    win32: { peakBaseMB: 1550, peakPerCallMB: 1.45, mainHeapAfterGcMB: 160, retainedMB: 500, rendererRetainedMB: 15, domNodesRetained: 1500 }
  },
  largeChat: {
    darwin: { openTotalGrowthMB: 600, openRendererHeapMB: 150, openSeconds: 20, retainedMB: 400, rendererRetainedMB: 15 },
    linux: { openTotalGrowthMB: 600, openRendererHeapMB: 150, openSeconds: 20, retainedMB: 400, rendererRetainedMB: 15 },
    win32: { openTotalGrowthMB: 600, openRendererHeapMB: 150, openSeconds: 20, retainedMB: 400, rendererRetainedMB: 15 }
  },
  cliSession: {
    darwin: { peakResidentMB: 800, lateGrowthMB: 450, idleResidentMB: 650 },
    linux: { peakResidentMB: 800, lateGrowthMB: 450, idleResidentMB: 650 },
    win32: { peakResidentMB: 800, lateGrowthMB: 450, idleResidentMB: 650 }
  }
}

type Scenario = keyof typeof BUDGETS
type Platform = 'darwin' | 'linux' | 'win32'

/** The budget for `scenario` on this platform. */
export function budget<S extends Scenario>(scenario: S): (typeof BUDGETS)[S]['linux'] {
  const platform: Platform = (['darwin', 'linux', 'win32'] as const).find((p) => p === process.platform) ?? 'linux'
  return BUDGETS[scenario][platform] as (typeof BUDGETS)[S]['linux']
}
