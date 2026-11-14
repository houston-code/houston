import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A flag that turns itself off `ms` after it is shown (the "Copied" tick on a copy
 * button). The pending timer is cleared when the component unmounts, so it never
 * sets state on an unmounted component: in a test, that fired after the test's DOM
 * was torn down and failed the run with "window is not defined". Showing it again
 * restarts the wait.
 */
export function useTransientFlag(ms: number): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const show = useCallback(() => {
    setOn(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setOn(false)
    }, ms)
  }, [ms])
  return [on, show]
}
