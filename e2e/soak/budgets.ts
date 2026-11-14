/**
 * Memory budgets for the soak scenarios, per platform. Each limit sits well above what
 * the scenario measures today (the comment beside it), so ordinary noise between runs
 * and runner images passes, while a real regression, such as history or images held
 * after a chat closes or a buffer that grows every turn, fails. When a change
 * legitimately moves a number, update the measured value and the limit together, in
 * the same PR that moves it.
 *
 * Measured on macOS arm64 (12 turns x 12 steps; a 47 MB, 400-turn chat):
 *   desktopSession: peak 1010, main heap after GC 33, kept 5, window heap kept 35, nodes kept 7
 *   largeChat: opening +322, window heap open 74, 0.8-1.8 s, kept -71 to 277 (one sample,
 *     before settledSample), window heap kept 48
 *   cliSession: peak 419, growth turn 2 to 12 154, idle 192
 * Linux and Windows start from the same limits until their first runs are read.
 *
 * The window heap a closed chat leaves behind (35-48 MB) is a known retention: App
 * callbacks and effect cleanups from the render where the chat was open keep that
 * render's scope, and so the chat's rows, alive until they are next recreated. It
 * holds one closed chat, not each one. Lower rendererRetainedMB once that is fixed.
 *
 * Totals are the sum of every Electron process's working set (getAppMetrics), and the
 * CLI's are its resident set, so they compare within a platform, not across them.
 */
const BUDGETS = {
  desktopSession: {
    darwin: { peakTotalMB: 1400, mainHeapAfterGcMB: 160, retainedMB: 250, rendererRetainedMB: 80, domNodesRetained: 1500 },
    linux: { peakTotalMB: 1400, mainHeapAfterGcMB: 160, retainedMB: 250, rendererRetainedMB: 80, domNodesRetained: 1500 },
    win32: { peakTotalMB: 1600, mainHeapAfterGcMB: 160, retainedMB: 300, rendererRetainedMB: 80, domNodesRetained: 1500 }
  },
  largeChat: {
    darwin: { openTotalGrowthMB: 600, openRendererHeapMB: 150, openSeconds: 20, retainedMB: 300, rendererRetainedMB: 80 },
    linux: { openTotalGrowthMB: 600, openRendererHeapMB: 150, openSeconds: 20, retainedMB: 300, rendererRetainedMB: 80 },
    win32: { openTotalGrowthMB: 700, openRendererHeapMB: 150, openSeconds: 30, retainedMB: 350, rendererRetainedMB: 80 }
  },
  cliSession: {
    darwin: { peakResidentMB: 700, lateGrowthMB: 300, idleResidentMB: 400 },
    linux: { peakResidentMB: 700, lateGrowthMB: 300, idleResidentMB: 400 },
    win32: { peakResidentMB: 800, lateGrowthMB: 300, idleResidentMB: 500 }
  }
}

type Scenario = keyof typeof BUDGETS
type Platform = 'darwin' | 'linux' | 'win32'

/** The budget for `scenario` on this platform. */
export function budget<S extends Scenario>(scenario: S): (typeof BUDGETS)[S]['linux'] {
  const platform: Platform = (['darwin', 'linux', 'win32'] as const).find((p) => p === process.platform) ?? 'linux'
  return BUDGETS[scenario][platform] as (typeof BUDGETS)[S]['linux']
}
