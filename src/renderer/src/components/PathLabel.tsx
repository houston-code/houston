/** A path's folder part (with its trailing slash, '' at the top level) and file name. */
export function splitPath(path: string): { dir: string; base: string } {
  const cut = path.lastIndexOf('/') + 1
  return { dir: path.slice(0, cut), base: path.slice(cut) }
}

/**
 * A file path on one line, for a narrow column: when it doesn't fit, the folder part
 * is cut short (with an ellipsis) and the file name stays whole, since the name is
 * what tells two rows apart. A rename shows `old → new` the same way, the old path
 * dimmed. The full text reads as one path to a screen reader.
 */
export function PathLabel({
  path,
  oldPath,
  className = ''
}: {
  path: string
  /** The path before a rename; shown first, dimmed. */
  oldPath?: string
  className?: string
}): JSX.Element {
  const { dir, base } = splitPath(path)
  const renamed = oldPath !== undefined && oldPath !== path
  return (
    <span className={`path-label${className ? ` ${className}` : ''}`} title={renamed ? `${oldPath} → ${path}` : path}>
      {renamed && <span className="path-label__old">{oldPath} → </span>}
      {dir && <span className="path-label__dir">{dir}</span>}
      <span className="path-label__base">{base}</span>
    </span>
  )
}
