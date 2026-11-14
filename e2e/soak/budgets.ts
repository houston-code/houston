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
 * Measured, 12 turns x 12 steps and a 47 MB, 400-turn chat:
 *   desktopSession  peak 957-1484, main heap after GC 33-34, kept 5-371, window heap
 *                   kept 34-35, page elements kept 7 (macOS laptop and runner, Linux)
 *   largeChat       opening +235 to +334, window heap open 74-75, 0.4-1.8 s, kept -5 to
 *                   107, window heap kept 48 (all three)
 *   cliSession      peak 375-562, growth turn 2 to 12 53-314, idle 117-266 (macOS,
 *                   Windows); Linux idle 446, since glibc keeps the freed heap and the
 *                   idle size stays at the peak. The save-buffer regression fixed earlier
 *                   grew ~65 MB per turn, over 600 MB across this session.
 *
 * Window heap kept (35-48 MB) is a known retention: App closures from the render where
 * the chat was open keep that render's scope and the chat's rows. Lower
 * rendererRetainedMB to about 15 once that is fixed.
 *
 * Totals are the sum of every Electron process's working set (getAppMetrics), and the
 * CLI's are its resident set, so they compare within a platform, not across them.
 */
const BUDGETS = {
  desktopSession: {
    darwin: { peakTotalMB: 1800, mainHeapAfterGcMB: 160, retainedMB: 500, rendererRetainedMB: 80, domNodesRetained: 1500 },
    linux: { peakTotalMB: 1800, mainHeapAfterGcMB: 160, retainedMB: 500, rendererRetainedMB: 80, domNodesRetained: 1500 },
    win32: { peakTotalMB: 1800, mainHeapAfterGcMB: 160, retainedMB: 500, rendererRetainedMB: 80, domNodesRetained: 1500 }
  },
  largeChat: {
    darwin: { openTotalGrowthMB: 600, openRendererHeapMB: 150, openSeconds: 20, retainedMB: 400, rendererRetainedMB: 80 },
    linux: { openTotalGrowthMB: 600, openRendererHeapMB: 150, openSeconds: 20, retainedMB: 400, rendererRetainedMB: 80 },
    win32: { openTotalGrowthMB: 600, openRendererHeapMB: 150, openSeconds: 20, retainedMB: 400, rendererRetainedMB: 80 }
  },
  cliSession: {
    darwin: { peakResidentMB: 800, lateGrowthMB: 450, idleResidentMB: 450 },
    linux: { peakResidentMB: 800, lateGrowthMB: 450, idleResidentMB: 650 },
    win32: { peakResidentMB: 800, lateGrowthMB: 450, idleResidentMB: 450 }
  }
}

type Scenario = keyof typeof BUDGETS
type Platform = 'darwin' | 'linux' | 'win32'

/** The budget for `scenario` on this platform. */
export function budget<S extends Scenario>(scenario: S): (typeof BUDGETS)[S]['linux'] {
  const platform: Platform = (['darwin', 'linux', 'win32'] as const).find((p) => p === process.platform) ?? 'linux'
  return BUDGETS[scenario][platform] as (typeof BUDGETS)[S]['linux']
}
