/**
 * Derive the workspace root a `debug` call resolves paths against: the calling
 * agent's per-session workspace (`exec.agent.session.header.cwd`), mirroring
 * the filesystem and LSP tools. When a call supplies an explicit `cwd`, paths
 * are resolved against that instead (still relative to the session workspace
 * when `cwd` itself is relative).
 * @module @hy-sde-org/dsh-tool-debug/session
 */

import * as path from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller.
 */
export function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * Resolve a user-supplied path against the session workspace (absolute paths
 * pass through; relative paths join `base`).
 * @param input - the path as the model provided it.
 * @param base - the resolution root (session cwd or an explicit call cwd).
 * @returns the resolved absolute path.
 */
export function resolveToCwd(input: string, base: string): string {
  return path.isAbsolute(input) ? input : path.resolve(base, input)
}

/**
 * The effective working directory for one call: the explicit `cwd` arg when
 * present (absolute, or joined onto the session cwd), else the session cwd.
 * @param args - parsed call arguments.
 * @param workspace - the session workspace cwd (required).
 * @returns the resolved call working directory.
 */
export function resolveCallCwd(args: { readonly cwd?: string }, workspace: string): string {
  if (args.cwd === undefined) return workspace
  return path.isAbsolute(args.cwd) ? args.cwd : path.resolve(workspace, args.cwd)
}
