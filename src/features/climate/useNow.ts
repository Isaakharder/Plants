import { useEffect, useState } from 'react'

/** The current time (ms), refreshed every `stepMs`, so renders stay pure and status ages update. */
export function useNow(stepMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs)
    return () => clearInterval(id)
  }, [stepMs])
  return now
}
