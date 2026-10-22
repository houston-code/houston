import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { bundledPackagesGuard } from './scripts/bundled-packages.mjs'

const sharedAlias = {
  '@shared': resolve('src/shared')
}

/**
 * Copy mermaid's prebuilt single-file bundle into out/main/vendor, where the main
 * process serves it to the offscreen diagram renderer (src/main/visualRender.ts).
 * mermaid is a devDependency so the packaged app ships this one file rather than
 * its whole dependency tree; scripts/vendored-js.mjs keeps its licenses attributed.
 */
const vendorMermaid = {
  name: 'houston-vendor-mermaid',
  writeBundle(): void {
    mkdirSync(resolve('out/main/vendor'), { recursive: true })
    copyFileSync(resolve('node_modules/mermaid/dist/mermaid.min.js'), resolve('out/main/vendor/mermaid.min.js'))
  }
}

// Each target also runs bundledPackagesGuard: the build fails if it inlines an npm
// package that THIRD-PARTY-NOTICES.md and the license gate don't cover (a
// devDependency the renderer imports, say), so attribution can't silently lag the build.
//
// electron-vite ships every target unminified by default (unlike plain Vite,
// which minifies production builds). Opt in explicitly so the packaged main,
// preload, and renderer bundles aren't shipped as readable, multi-line source —
// this roughly halves the renderer bundle and trims startup parse cost.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), vendorMermaid, bundledPackagesGuard('main')],
    resolve: { alias: sharedAlias },
    build: {
      minify: true,
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), bundledPackagesGuard('preload')],
    resolve: { alias: sharedAlias },
    build: {
      minify: true,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: sharedAlias },
    plugins: [react(), bundledPackagesGuard('renderer')],
    build: {
      minify: true,
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
