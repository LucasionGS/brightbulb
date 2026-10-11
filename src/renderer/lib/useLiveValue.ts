import { useEffect, useRef, useState } from "react";

const HOLD_MS = 800;

/**
 * A value owned by the main process that the user can also drag locally.  
 * Local edits win for a moment, so the echo of an older value cannot yank a
 * slider back mid-drag; after that the remote value takes over again.
 */
export function useLiveValue<T>(remote: T): [T, (value: T) => void] {
  const [local, setLocal] = useState<T>(remote);
  const editedAt = useRef(0);

  useEffect(() => {
    if (Date.now() - editedAt.current > HOLD_MS) setLocal(remote);
    else {
      const timer = window.setTimeout(() => setLocal(remote), HOLD_MS);
      return () => window.clearTimeout(timer);
    }
  }, [remote]);

  return [local, (value: T) => {
    editedAt.current = Date.now();
    setLocal(value);
  }];
}
