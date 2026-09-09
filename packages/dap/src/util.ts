/**
 * Small shared helpers for the DAP client: errno-aware exceptions and a
 * promise-based sleep tick.
 * @module @hy-sde-org/dsh-dap/util
 */

/** Node errno-shaped exception guard.
 * @param value - the unknown value to test.
 * @returns true when `value` looks like an ErrnoException.
 */
export function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as NodeJS.ErrnoException).code === 'string' &&
    !(
      'errno' in Object(value))
  )
}

/** Resolve after `ms` milliseconds (unref'd so it cannot hold the event loop).
 * @param ms - how long to wait before resolving.
 * @returns a promise that resolves after the delay.
 */
export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}
