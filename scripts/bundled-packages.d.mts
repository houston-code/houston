// Types for bundled-packages.mjs, imported by electron.vite.config.ts.
import type { Plugin } from 'vite'

export function packageDirOf(id: string): string | null
export function packageNameOf(dir: string): string
export function uncoveredPackageDirs(ids: Iterable<string>, covered: Iterable<string>, canonical?: (p: string) => string): string[]
export function productionPackageDirs(root: string, exec?: unknown, platform?: string): Set<string>
export function coveredPackageDirs(root: string): Set<string>
export function uncoveredMessage(target: string, dirs: string[], root: string): string | null
export function bundledPackagesGuard(target: string, root?: string): Plugin
