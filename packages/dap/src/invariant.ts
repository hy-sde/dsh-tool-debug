/**
 * Package-owned invariant companion for `@hy-sde-org/dsh-dap`.
 * @module @hy-sde-org/dsh-dap/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@hy-sde-org/dsh-dap'

/** Cordis companion plugin name. */
export const name = 'dap-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: per-realm sessions and their adapter processes are
 * private, disposed state that the seam neither exposes wholly nor emits
 * lifecycle events for; the tool consumer asserts its own invariants.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
