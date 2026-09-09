/**
 * Schema-level vocabulary for the `debug` tool: the closed action set and the
 * raw model-facing argument shape (snake_case, DAP terminology). Ported from
 * oh-my-pi's `coding-agent/src/tools/debug.ts` (MIT).
 * @module @hy-sde-org/dsh-tool-debug/types
 */

/** The 28 debug actions. Read-only introspection actions are safe to read from
 *  a paused program; everything else mutates execution state. */
export const DEBUG_ACTIONS = [
  'launch',
  'attach',
  'set_breakpoint',
  'remove_breakpoint',
  'set_instruction_breakpoint',
  'remove_instruction_breakpoint',
  'data_breakpoint_info',
  'set_data_breakpoint',
  'remove_data_breakpoint',
  'continue',
  'step_over',
  'step_in',
  'step_out',
  'pause',
  'evaluate',
  'stack_trace',
  'threads',
  'scopes',
  'variables',
  'disassemble',
  'read_memory',
  'write_memory',
  'modules',
  'loaded_sources',
  'custom_request',
  'output',
  'terminate',
  'sessions',
] as const

/** The closed union of debug actions. */
export type DebugToolAction = (typeof DEBUG_ACTIONS)[number]

/**
 * Narrow a runtime value to `DebugToolAction` when it names one.
 * @param value - the runtime value to test.
 * @returns whether `value` is a known debug action.
 */
export function isDebugAction(value: unknown): value is DebugToolAction {
  return typeof value === 'string' && (DEBUG_ACTIONS as readonly string[]).includes(value)
}

/** Read-only actions that only inspect program state (no mutation/execution). */
export const DEBUG_READONLY_ACTIONS: ReadonlySet<string> = new Set([
  'output',
  'threads',
  'stack_trace',
  'scopes',
  'variables',
  'disassemble',
  'read_memory',
  'loaded_sources',
  'modules',
  'sessions',
])

/** Model-facing arguments of one `debug` call (all optional except `action`). */
export interface DebugToolArgs {
  readonly action: DebugToolAction
  /** Debug target path; Delve accepts Go package directories. */
  readonly program?: string
  /** Program arguments for launch. */
  readonly args?: string[]
  /** Configured adapter id (gdb, lldb-dap, debugpy, dlv, ... or a dap.json entry). */
  readonly adapter?: string
  /** Call working directory; defaults to the session workspace. */
  readonly cwd?: string
  /** Source file (breakpoint operations; resolved against cwd). */
  readonly file?: string
  readonly line?: number
  /** Function name (breakpoint operations). */
  readonly function?: string
  /** Variable or data name (data_breakpoint_info). */
  readonly name?: string
  /** Breakpoint condition expression. */
  readonly condition?: string
  readonly hit_condition?: string
  /** Expression to evaluate. */
  readonly expression?: string
  /** Evaluate context: watch | repl | hover | variables | clipboard. */
  readonly context?: string
  readonly frame_id?: number
  /** Scope variables reference. */
  readonly scope_id?: number
  /** Variable reference. */
  readonly variable_ref?: number
  /** Process id for attach. */
  readonly pid?: number
  /** Remote attach port. */
  readonly port?: number
  readonly host?: string
  /** Max stack frames for stack_trace. */
  readonly levels?: number
  /** Memory reference or address. */
  readonly memory_reference?: string
  readonly instruction_reference?: string
  readonly instruction_count?: number
  readonly instruction_offset?: number
  /** Bytes to read for read_memory. */
  readonly count?: number
  /** Base64 memory payload for write_memory. */
  readonly data?: string
  readonly data_id?: string
  readonly access_type?: 'read' | 'write' | 'readWrite'
  /** Custom DAP request command. */
  readonly command?: string
  /** Custom request arguments. */
  readonly arguments?: Record<string, unknown>
  readonly offset?: number
  readonly resolve_symbols?: boolean
  readonly allow_partial?: boolean
  readonly start_module?: number
  readonly module_count?: number
  /** Per-request timeout seconds. */
  readonly timeout?: number
}
