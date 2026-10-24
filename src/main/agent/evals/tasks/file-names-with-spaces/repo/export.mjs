import { mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { renderPdf } from './lib/render.mjs'

/** Export the client's documents as PDFs into `outDir`, keeping their names. */
export function exportDocuments(files, outDir, { client } = {}) {
  mkdirSync(outDir, { recursive: true })
  return files.map((input) =>
    renderPdf({
      input,
      output: join(outDir, `${basename(input, extname(input))}.pdf`),
      title: client ? `${client}: ${basename(input)}` : undefined
    })
  )
}
