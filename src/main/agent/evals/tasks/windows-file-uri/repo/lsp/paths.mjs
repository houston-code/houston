/**
 * The key a file is stored under. On Windows the editor hands us backslash paths,
 * so normalize separators; elsewhere a path is already its own key.
 */
export function fileKey(path, platform = process.platform) {
  if (platform !== 'win32') return path
  return path.replace(/\//g, '\\')
}
