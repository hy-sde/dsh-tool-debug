/**
 * Service Definition + Provider for the Debug Adapter Protocol capability
 * seam (`ctx.dap`): adapter resolution over the subprocess seam, a session
 * manager that launches/attaches, sets breakpoints, steps, lists threads and
 * stack frames, reads scopes and variables, evaluates expressions, and
 * terminates debug sessions, plus the framed DAP client and shared types.
 * Ported from oh-my-pi's `coding-agent/src/dap/*` (MIT).
 *
 * Unlike the LSP seam, the provider cannot be remote: a DAP adapter is a
 * local binary that owns the debuggee, so this package is both definition and
 * provider. Each mounted session gets its own isolated `ctx.dap` (see the
 * agent-preset `debug` realm), so adapter processes and the active-session
 * pointer stay per-agent.
 * @module @hy-sde-org/dsh-dap
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  classifyProgram,
  getAvailableAdapters,
  resolveAdapter,
  resolveLaunchOverrides,
  selectAttachAdapter,
  selectLaunchAdapter,
} from './config.ts'
import type { LaunchAdapterSelection, LaunchProgramKind } from './config.ts'
import type { DapResolvedAdapter } from './types.ts'
import { DapSessionManager } from './session.ts'
import type {
  DapBreakpointRecord,
  DapCapabilities,
  DapContinueOutcome,
  DapDataBreakpointInfoResponse,
  DapDataBreakpointRecord,
  DapDisassembledInstruction,
  DapEvaluateResponse,
  DapFunctionBreakpointRecord,
  DapInstructionBreakpointRecord,
  DapModule,
  DapOutputSnapshot,
  DapScope,
  DapSessionSummary,
  DapSource,
  DapStackFrame,
  DapThread,
  DapVariable,
} from './types.ts'
import { lstat as fsLstat, readdir as fsReaddir } from 'node:fs/promises'

export { DapClient } from './client.ts'
export type { DapReverseRequestHandler, DapTransport, DapWriteSink } from './client.ts'
export { MessageFramer, encodeDapMessage } from './framing.ts'
export { NON_INTERACTIVE_ENV } from './env.ts'
export { DapSessionManager } from './session.ts'
export type { DapSpawner, DapSessionManagerOptions } from './session.ts'
export {
  classifyProgram,
  getAdapterConfigs,
  getAvailableAdapters,
  hasRootMarkers,
  resolveAdapter,
  resolveLaunchOverrides,
  selectAttachAdapter,
  selectLaunchAdapter,
} from './config.ts'
export type { LaunchAdapterSelection, LaunchProgramKind } from './config.ts'
export { DEFAULT_ADAPTERS } from './defaults.ts'
export { isErrnoException, sleepMs } from './util.ts'
export type {
  DapAdapterConfig,
  DapAttachArguments,
  DapAttachSessionOptions,
  DapBreakpoint,
  DapBreakpointRecord,
  DapCapabilities,
  DapContinueOutcome,
  DapDataBreakpoint,
  DapDataBreakpointInfoResponse,
  DapDataBreakpointRecord,
  DapDisassembledInstruction,
  DapErrorBody,
  DapEvaluateArguments,
  DapEvaluateResponse,
  DapEventMessage,
  DapExitedEventBody,
  DapFunctionBreakpointRecord,
  DapInitializeArguments,
  DapInstructionBreakpointRecord,
  DapLaunchArguments,
  DapLaunchSessionOptions,
  DapMessage,
  DapModule,
  DapOutputEventBody,
  DapOutputSnapshot,
  DapProtocolMessage,
  DapRequestMessage,
  DapResolvedAdapter,
  DapResponseMessage,
  DapRunInTerminalArguments,
  DapRunInTerminalResponse,
  DapScope,
  DapSessionSummary,
  DapSessionStatus,
  DapSource,
  DapSourceBreakpoint,
  DapStackFrame,
  DapStopLocation,
  DapStoppedEventBody,
  DapThread,
  DapVariable,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dap: Dap
  }
}

/**
 * `ctx.dap`: one session manager per isolated realm. The manager owns the
 * active-session pointer, adapter processes, breakpoint state, and captured
 * output; every model-facing operation (see `@hy-sde-org/dsh-tool-debug`)
 * delegates here. Lifecycle is fiber-scoped: disposal terminates every live
 * adapter and stops the idle-cleanup timer.
 */
export class Dap extends Service {
  /** The subprocess seam this provider spawns adapters through. */
  static inject = ['subprocess']

  /** One manager per provided service instance (per isolated realm/session). */
  readonly manager: DapSessionManager

  constructor(ctx: Context) {
    super(ctx, 'dap')
    this.manager = new DapSessionManager({
      spawn: spec => ctx.subprocess.spawn(spec),
    })
    const manager = this.manager
    ctx.effect(
      () => () => {
        manager.dispose()
      },
      'dap manager teardown',
    )
  }

  /**
   * Launch a program under the given adapter (or auto-select one).
   * @param args - launch arguments, forwarded to the session manager.
   * @returns the new session summary once the debuggee is configured.
   */
  launch(...args: Parameters<DapSessionManager['launch']>): Promise<DapSessionSummary> {
    return this.manager.launch(...args)
  }

  /**
   * Attach to a running process by pid, or to a port (debugpy listen/attach).
   * @param args - attach arguments, forwarded to the session manager.
   * @returns the new session summary once the debuggee is configured.
   */
  attach(...args: Parameters<DapSessionManager['attach']>): Promise<DapSessionSummary> {
    return this.manager.attach(...args)
  }

  /**
   * The currently active session summary, or null.
   * @returns the active session summary, or null when no session is active.
   */
  getActiveSession(): DapSessionSummary | null {
    return this.manager.getActiveSession()
  }

  /**
   * Every live (and lingering) session summary under this manager.
   * @returns the list of session summaries.
   */
  listSessions(): DapSessionSummary[] {
    return this.manager.listSessions()
  }

  /**
   * Capabilities of the active session, or null when none.
   * @returns the active session's capabilities, or null when no session is active.
   */
  getCapabilities(): DapCapabilities | null {
    return this.manager.getCapabilities()
  }

  /**
   * Read a source breakpoint at `file:line`; returns the updated list.
   * @param args - setBreakpoint arguments, forwarded to the session manager.
   * @returns the updated breakpoint list for the file and the session snapshot.
   */
  setBreakpoint(
    ...args: Parameters<DapSessionManager['setBreakpoint']>
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapBreakpointRecord[]; sourcePath: string }> {
    return this.manager.setBreakpoint(...args)
  }

  /**
   * Remove a source breakpoint at `file:line`.
   * @param args - removeBreakpoint arguments, forwarded to the session manager.
   * @returns the updated breakpoint list for the file and the session snapshot.
   */
  removeBreakpoint(
    ...args: Parameters<DapSessionManager['removeBreakpoint']>
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapBreakpointRecord[] }> {
    return this.manager.removeBreakpoint(...args)
  }

  /**
   * Set a function breakpoint by qualified name.
   * @param args - setFunctionBreakpoint arguments, forwarded to the session manager.
   * @returns the updated function breakpoint list and the session snapshot.
   */
  setFunctionBreakpoint(
    ...args: Parameters<DapSessionManager['setFunctionBreakpoint']>
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapFunctionBreakpointRecord[] }> {
    return this.manager.setFunctionBreakpoint(...args)
  }

  /**
   * Remove a function breakpoint by name.
   * @param args - removeFunctionBreakpoint arguments, forwarded to the session manager.
   * @returns the updated function breakpoint list and the session snapshot.
   */
  removeFunctionBreakpoint(
    ...args: Parameters<DapSessionManager['removeFunctionBreakpoint']>
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapFunctionBreakpointRecord[] }> {
    return this.manager.removeFunctionBreakpoint(...args)
  }

  /**
   * Resume execution of the active thread.
   * @param args - continue arguments (signal, timeout), forwarded to the session manager.
   * @returns the stop outcome with the resulting session snapshot.
   */
  continue(...args: Parameters<DapSessionManager['continue']>): Promise<DapContinueOutcome> {
    return this.manager.continue(...args)
  }

  /**
   * Pause the debuggee.
   * @param args - pause arguments (signal, timeout), forwarded to the session manager.
   * @returns the session snapshot after the pause.
   */
  pause(...args: Parameters<DapSessionManager['pause']>): Promise<DapSessionSummary> {
    return this.manager.pause(...args)
  }

  /**
   * Step into the current frame.
   * @param args - stepIn arguments, forwarded to the session manager.
   * @returns the stop outcome with the resulting session snapshot.
   */
  stepIn(...args: Parameters<DapSessionManager['stepIn']>): Promise<DapContinueOutcome> {
    return this.manager.stepIn(...args)
  }

  /**
   * Step out of the current frame.
   * @param args - stepOut arguments, forwarded to the session manager.
   * @returns the stop outcome with the resulting session snapshot.
   */
  stepOut(...args: Parameters<DapSessionManager['stepOut']>): Promise<DapContinueOutcome> {
    return this.manager.stepOut(...args)
  }

  /**
   * Step over the current line.
   * @param args - stepOver arguments, forwarded to the session manager.
   * @returns the stop outcome with the resulting session snapshot.
   */
  stepOver(...args: Parameters<DapSessionManager['stepOver']>): Promise<DapContinueOutcome> {
    return this.manager.stepOver(...args)
  }

  /**
   * List the debuggee's threads.
   * @param args - threads arguments, forwarded to the session manager.
   * @returns the aggregated thread list and the session snapshot.
   */
  threads(...args: Parameters<DapSessionManager['threads']>): Promise<{ snapshot: DapSessionSummary; threads: DapThread[] }> {
    return this.manager.threads(...args)
  }

  /**
   * List the current thread's stack frames.
   * @param args - stackTrace arguments, forwarded to the session manager.
   * @returns the stack frames, total frame count, and the session snapshot.
   */
  stackTrace(
    ...args: Parameters<DapSessionManager['stackTrace']>
  ): Promise<{ snapshot: DapSessionSummary; stackFrames: DapStackFrame[]; totalFrames: number | undefined }> {
    return this.manager.stackTrace(...args)
  }

  /**
   * List the scopes of a stack frame.
   * @param args - scopes arguments, forwarded to the session manager.
   * @returns the scopes and the session snapshot.
   */
  scopes(...args: Parameters<DapSessionManager['scopes']>): Promise<{ snapshot: DapSessionSummary; scopes: DapScope[] }> {
    return this.manager.scopes(...args)
  }

  /**
   * List the variables of a variable reference.
   * @param args - variables arguments, forwarded to the session manager.
   * @returns the variables and the session snapshot.
   */
  variables(
    ...args: Parameters<DapSessionManager['variables']>
  ): Promise<{ snapshot: DapSessionSummary; variables: DapVariable[] }> {
    return this.manager.variables(...args)
  }

  /**
   * Evaluate an expression in the current frame.
   * @param args - evaluate arguments, forwarded to the session manager.
   * @returns the evaluation result and the session snapshot.
   */
  evaluate(
    ...args: Parameters<DapSessionManager['evaluate']>
  ): Promise<{ snapshot: DapSessionSummary; evaluation: DapEvaluateResponse | undefined }> {
    return this.manager.evaluate(...args)
  }

  /**
   * Captured stdout/stderr output of the active session (bounded).
   * @param limitBytes - optional cap on the number of returned output bytes.
   * @returns the tail of the captured output and the session snapshot.
   */
  getOutput(limitBytes?: number): DapOutputSnapshot {
    return this.manager.getOutput(limitBytes)
  }

  /**
   * Terminate the active session's whole tree.
   * @param args - terminate arguments, forwarded to the session manager.
   * @returns the final session snapshot, or null when no session was active.
   */
  terminate(...args: Parameters<DapSessionManager['terminate']>): Promise<DapSessionSummary | null> {
    return this.manager.terminate(...args)
  }

  /**
   * Set an instruction pointer breakpoint.
   * @param args - setInstructionBreakpoint arguments, forwarded to the session manager.
   * @returns the updated instruction breakpoint list and the session snapshot.
   */
  setInstructionBreakpoint(
    ...args: Parameters<DapSessionManager['setInstructionBreakpoint']>
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapInstructionBreakpointRecord[] }> {
    return this.manager.setInstructionBreakpoint(...args)
  }

  /**
   * Remove an instruction pointer breakpoint.
   * @param args - removeInstructionBreakpoint arguments, forwarded to the session manager.
   * @returns the updated instruction breakpoint list and the session snapshot.
   */
  removeInstructionBreakpoint(
    ...args: Parameters<DapSessionManager['removeInstructionBreakpoint']>
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapInstructionBreakpointRecord[] }> {
    return this.manager.removeInstructionBreakpoint(...args)
  }

  /**
   * Query data-breakpoint availability for a variable/expression.
   * @param args - dataBreakpointInfo arguments, forwarded to the session manager.
   * @returns the data-breakpoint info and the session snapshot.
   */
  dataBreakpointInfo(
    ...args: Parameters<DapSessionManager['dataBreakpointInfo']>
  ): Promise<{ snapshot: DapSessionSummary; info: DapDataBreakpointInfoResponse }> {
    return this.manager.dataBreakpointInfo(...args)
  }

  /**
   * Set a data breakpoint (write/read hardware breakpoint).
   * @param args - setDataBreakpoint arguments, forwarded to the session manager.
   * @returns the updated data breakpoint list and the session snapshot.
   */
  setDataBreakpoint(
    ...args: Parameters<DapSessionManager['setDataBreakpoint']>
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapDataBreakpointRecord[] }> {
    return this.manager.setDataBreakpoint(...args)
  }

  /**
   * Remove a data breakpoint.
   * @param args - removeDataBreakpoint arguments, forwarded to the session manager.
   * @returns the updated data breakpoint list and the session snapshot.
   */
  removeDataBreakpoint(
    ...args: Parameters<DapSessionManager['removeDataBreakpoint']>
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapDataBreakpointRecord[] }> {
    return this.manager.removeDataBreakpoint(...args)
  }

  /**
   * Disassemble instructions around a memory reference.
   * @param args - disassemble arguments, forwarded to the session manager.
   * @returns the disassembled instructions and the session snapshot.
   */
  disassemble(
    ...args: Parameters<DapSessionManager['disassemble']>
  ): Promise<{ snapshot: DapSessionSummary; instructions: DapDisassembledInstruction[] }> {
    return this.manager.disassemble(...args)
  }

  /**
   * Read raw process memory (base64 buffer string).
   * @param args - readMemory arguments, forwarded to the session manager.
   * @returns the memory read result and the session snapshot.
   */
  readMemory(
    ...args: Parameters<DapSessionManager['readMemory']>
  ): Promise<{ snapshot: DapSessionSummary; address: string; data: string | undefined; unreadableBytes: number | undefined }> {
    return this.manager.readMemory(...args)
  }

  /**
   * Write raw process memory (base64 buffer string).
   * @param args - writeMemory arguments, forwarded to the session manager.
   * @returns the memory write result and the session snapshot.
   */
  writeMemory(
    ...args: Parameters<DapSessionManager['writeMemory']>
  ): Promise<{ snapshot: DapSessionSummary; offset: number | undefined; bytesWritten: number | undefined }> {
    return this.manager.writeMemory(...args)
  }

  /**
   * List loaded modules of the debuggee.
   * @param args - modules arguments, forwarded to the session manager.
   * @returns the loaded modules and the session snapshot.
   */
  modules(...args: Parameters<DapSessionManager['modules']>): Promise<{ snapshot: DapSessionSummary; modules: DapModule[] }> {
    return this.manager.modules(...args)
  }

  /**
   * List source files loaded by the debuggee.
   * @param args - loadedSources arguments, forwarded to the session manager.
   * @returns the loaded sources and the session snapshot.
   */
  loadedSources(
    ...args: Parameters<DapSessionManager['loadedSources']>
  ): Promise<{ snapshot: DapSessionSummary; sources: DapSource[] }> {
    return this.manager.loadedSources(...args)
  }

  /**
   * Send an unstandardized DAP request to the active adapter.
   * @param args - customRequest arguments, forwarded to the session manager.
   * @returns the adapter response body and the session snapshot.
   */
  customRequest(
    ...args: Parameters<DapSessionManager['customRequest']>
  ): Promise<{ snapshot: DapSessionSummary; body: unknown }> {
    return this.manager.customRequest(...args)
  }

  /** Dispose every session under this manager. */
  disposeManager(): void {
    this.manager.dispose()
  }

  /**
   * Classify a launch program as file/directory on disk.
   * @param program - the launch program path.
   * @param cwd - the working directory used for resolution.
   * @returns the classification of the program.
   */
  async classifyProgram(program: string, cwd: string): Promise<LaunchProgramKind> {
    return classifyProgram(program, cwd, lstatOrNull)
  }

  /**
   * Select (or auto-select) a launch adapter for `program` in `cwd`.
   * @param program - the launch program path.
   * @param cwd - the working directory used for adapter resolution.
   * @param options - optional adapter name, program kind, and abort signal.
   * @returns the launch adapter selection.
   */
  async selectLaunchAdapter(
    program: string,
    cwd: string,
    options?: { adapter?: string; programKind?: LaunchProgramKind; signal?: AbortSignal },
  ): Promise<LaunchAdapterSelection> {
    const resolveExecutable = this.ctx.subprocess.resolveExecutable.bind(this.ctx.subprocess)
    const programKind = options?.programKind ?? (await classifyProgram(program, cwd, lstatOrNull))
    return selectLaunchAdapter(
      program,
      cwd,
      { resolveExecutable, signal: options?.signal },
      listOrEmpty,
      options?.adapter,
      programKind,
    )
  }

  /**
   * Select an attach adapter: explicit name, otherwise the best installed default.
   * @param cwd - the working directory used for adapter resolution.
   * @param options - optional adapter name, port, and abort signal.
   * @returns the resolved attach adapter, or null when none is available.
   */
  async selectAttachAdapter(
    cwd: string,
    options?: { adapter?: string; port?: number; signal?: AbortSignal },
  ): Promise<DapResolvedAdapter | null> {
    const resolveExecutable = this.ctx.subprocess.resolveExecutable.bind(this.ctx.subprocess)
    return selectAttachAdapter(cwd, { resolveExecutable, signal: options?.signal }, options?.adapter, options?.port)
  }

  /**
   * Every configured adapter whose command resolves under `cwd`.
   * @param cwd - the working directory used for adapter resolution.
   * @param signal - optional abort signal.
   * @returns the names of the available adapters.
   */
  async listAdapters(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const resolveExecutable = this.ctx.subprocess.resolveExecutable.bind(this.ctx.subprocess)
    const adapters = await getAvailableAdapters(cwd, { resolveExecutable, signal })
    return adapters.map(adapter => adapter.name)
  }

  /**
   * Resolve one named adapter under `cwd`, or null when unavailable.
   * @param name - the adapter name to resolve.
   * @param cwd - the working directory used for adapter resolution.
   * @param signal - optional abort signal.
   * @returns the resolved adapter, or null when unavailable.
   */
  async resolveAdapter(name: string, cwd: string, signal?: AbortSignal): Promise<DapResolvedAdapter | null> {
    const resolveExecutable = this.ctx.subprocess.resolveExecutable.bind(this.ctx.subprocess)
    return resolveAdapter(name, cwd, { resolveExecutable, signal })
  }

  /**
   * Compute adapter-specific launch overrides for a resolved program.
   * @param adapter - the resolved adapter.
   * @param program - the launch program path.
   * @param programKind - the classification of the launch program.
   * @returns the adapter-specific launch override arguments.
   */
  resolveLaunchOverrides(
    adapter: DapResolvedAdapter,
    program: string,
    programKind: LaunchProgramKind,
  ): Record<string, unknown> {
    return resolveLaunchOverrides(adapter, program, programKind)
  }
}

/** node:fs-based lstat that reports directory-ness, or null for a missing entry. */
async function lstatOrNull(
  filePath: string,
): Promise<{ isDirectory(): boolean } | null> {
  try {
    const entry = await fsLstat(filePath)
    return { isDirectory: () => entry.isDirectory() }
  } catch {
    return null
  }
}

/** node:fs-based directory listing; any failure yields an empty list. */
async function listOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fsReaddir(dir)
  } catch {
    return []
  }
}

export default Dap
