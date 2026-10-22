import { useEffect, useState } from 'react'

/** Whether this window has focus, following focus and blur. */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => typeof document !== 'undefined' && document.hasFocus())
  useEffect(() => {
    const on = (): void => setFocused(true)
    const off = (): void => setFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])
  return focused
}
