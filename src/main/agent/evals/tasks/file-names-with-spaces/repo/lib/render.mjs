import { fileURLToPath } from 'node:url'
import { run } from './run.mjs'

const RENDERER = fileURLToPath(new URL('../tools/render.mjs', import.meta.url))
const NODE = process.execPath

/** Render one document to PDF with the external renderer. */
export function renderPdf({ input, output, title }) {
  let command = `"${NODE}" "${RENDERER}" --in ${input} --out ${output}`
  if (title) command += ` --title ${title}`
  run(command)
  return output
}
