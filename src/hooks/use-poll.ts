import { useEffect, useRef } from "react";

/**
 * Interval poller that skips a tick while the previous run is still in
 * flight, pauses while the document is hidden (running one catch-up tick
 * when the page becomes visible again) and clears its timer on unmount.
 */
export function usePoller(
  fn: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
) {
  const runRef = useRef(fn);
  runRef.current = fn;
  const runningRef = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const tick = () => {
      if (document.hidden || runningRef.current) return;
      const result = runRef.current();
      if (result instanceof Promise) {
        runningRef.current = true;
        void result.finally(() => {
          runningRef.current = false;
        });
      }
    };
    timer = window.setInterval(tick, intervalMs);
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs]);
}
