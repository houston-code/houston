import { useEffect, useRef, useState } from 'react'
import { dragHasFiles, droppedPaths } from '../lib/recentFolders'

/** The composer's own drop zone, which attaches what is dropped on it. */
const COMPOSER = '.composer__card'

function onComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER) !== null
}

/**
 * Open a folder dragged onto the window. Files dragged anywhere outside the composer
 * show the drop hint (the returned flag); on drop, the dropped paths go to `open`,
 * which asks main whether one is a folder. Anything dropped on the composer is the
 * composer's: it attaches files and says a folder can't be attached, and this hook
 * leaves that drop alone (the hint isn't shown over it either).
 *
 * The window-level preventDefault in main.tsx still stops a drop from navigating the
 * frame; this only reads the drop, it never lets the browser act on it.
 */
export function useFolderDrop(
  open: (paths: string[]) => void,
  pathFor: (file: File) => string
): boolean {
  const [over, setOver] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  const pathForRef = useRef(pathFor)
  pathForRef.current = pathFor

  useEffect(() => {
    // dragenter/dragleave fire for every child crossed, so count the depth.
    let depth = 0
    const enter = (e: DragEvent): void => {
      if (!dragHasFiles(e.dataTransfer?.types)) return
      depth++
      setOver(!onComposer(e.target))
    }
    const move = (e: DragEvent): void => {
      if (!dragHasFiles(e.dataTransfer?.types)) return
      setOver(!onComposer(e.target))
    }
    const leave = (e: DragEvent): void => {
      if (!dragHasFiles(e.dataTransfer?.types)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setOver(false)
    }
    const drop = (e: DragEvent): void => {
      depth = 0
      setOver(false)
      const dt = e.dataTransfer
      if (!dt || !dragHasFiles(dt.types)) return
      if (onComposer(e.target)) return
      const files = Array.from(dt.files)
      const paths = droppedPaths(files, pathForRef.current)
      if (paths.length > 0) openRef.current(paths)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', move)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', move)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  return over
}
