/**
 * Debug session manager behind the DAP capability seam (`ctx.dap`): one
 * active session at a time, launch/attach, breakpoint bookkeeping (source,
 * function, instruction, and data breakpoints, synchronized across a
 * js-debug session tree), stepping, threads/stack/frames/variables/evaluate,
 * bounded output capture, idle cleanup, and tree-scoped termination. Ported
 * from oh-my-pi's `coding-agent/src/dap/session.ts` (MIT) with its
 * Bun/timers plumbing mapped onto the DSH subprocess seam and plain timers.
 * @module @hy-sde-org/dsh-dap/session
 */

import * as path from 'node:path'
import type { Readable } from 'node:stream'
import { DapClient } from './client.ts'
import { NON_INTERACTIVE_ENV } from './env.ts'
import { sleepMs } from './util.ts'
import type {
  DapAttachArguments,
  DapAttachSessionOptions,
  DapBreakpoint,
  DapBreakpointRecord,
  DapCapabilities,
  DapContinueArguments,
  DapContinueOutcome,
  DapContinueResponse,
  DapDataBreakpoint,
  DapDataBreakpointInfoArguments,
  DapDataBreakpointInfoResponse,
  DapDataBreakpointRecord,
  DapDisassembleArguments,
  DapDisassembledInstruction,
  DapDisassembleResponse,
  DapEvaluateArguments,
  DapEvaluateResponse,
  DapExitedEventBody,
  DapFunctionBreakpoint,
  DapFunctionBreakpointRecord,
  DapInitializeArguments,
  DapInstructionBreakpoint,
  DapInstructionBreakpointRecord,
  DapLaunchArguments,
  DapLaunchSessionOptions,
  DapLoadedSourcesResponse,
  DapModule,
  DapModulesArguments,
  DapModulesResponse,
  DapOutputEventBody,
  DapOutputSnapshot,
  DapPauseArguments,
  DapReadMemoryArguments,
  DapReadMemoryResponse,
  DapResolvedAdapter,
  DapRunInTerminalArguments,
  DapRunInTerminalResponse,
  DapScope,
  DapScopesArguments,
  DapScopesResponse,
  DapVariable,
  DapSessionStatus,
  DapSessionSummary,
  DapSetDataBreakpointsArguments,
  DapSetInstructionBreakpointsArguments,
  DapSource,
  DapSourceBreakpoint,
  DapStackFrame,
  DapStackTraceArguments,
  DapStackTraceResponse,
  DapStartDebuggingArguments,
  DapStepArguments,
  DapStopLocation,
  DapStoppedEventBody,
  DapThread,
  DapThreadsResponse,
  DapVariablesArguments,
  DapVariablesResponse,
  DapWriteMemoryArguments,
  DapWriteMemoryResponse,
} from './types.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

interface DapSession {
  id: string
  adapter: DapResolvedAdapter
  cwd: string
  program: string | undefined
  client: DapClient
  status: DapSessionStatus
  launchedAt: number
  lastUsedAt: number
  breakpoints: Map<string, DapBreakpointRecord[]>
  functionBreakpoints: DapFunctionBreakpointRecord[]
  instructionBreakpoints: DapInstructionBreakpoint[]
  dataBreakpoints: DapDataBreakpoint[]
  /** Serializes breakpoint mutations — see {@link serializeBreakpointMutation}. */
  breakpointMutationQueue: Promise<void>
  /** Recent output chunks; trimmed from the front when over maxOutputBytes. */
  outputChunks: string[]
  /** Cumulative bytes of output ever received (reported in summaries). */
  outputBytes: number
  /** Bytes currently buffered in outputChunks. */
  outputBufferedBytes: number
  outputTruncated: boolean
  stop: DapStopLocation
  threads: DapThread[]
  lastStackFrames: DapStackFrame[]
  exitCode: number | undefined
  capabilities: DapCapabilities | undefined
  initializedSeen: boolean
  needsConfigurationDone: boolean
  configurationDoneSent: boolean
  parentSessionId: string | undefined
  childSessionIds: Set<string>
  port: number | undefined
  /** Heartbeat interval for liveness probing; cleared on termination. */
  heartbeat: ReturnType<typeof setInterval> | undefined
}

interface DapTreeOutcomeWaiter {
  rootSessionId: string
  resolve(value: unknown): void
  reject(reason: unknown): void
}

/** Spawner the session manager routes adapter processes through. */
export interface DapSpawner {
  (spec: SubprocessSpawnSpec): SubprocessHandle
}

/** Options that configure a DapSessionManager instance. */
export interface DapSessionManagerOptions {
  spawn: DapSpawner
  /** Idle before a session is disposed (ms). Default 10 min. */
  idleTimeoutMs?: number
  /** Cadence of the idle-cleanup pass (ms). Default 30 s. */
  cleanupIntervalMs?: number
  /** Recent output retained per session (bytes). Default 128 KiB. */
  maxOutputBytes?: number
  /** Fake-clock for tests (defaults to Date.now). */
  now?: () => number
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_CLEANUP_INTERVAL_MS = 30 * 1000
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024
const STOP_CAPTURE_TIMEOUT_MS = 5_000

/** A fully-blank stop location for session reset/creation. */
function blankStopLocation(): DapStopLocation {
  return {
    threadId: undefined,
    frameId: undefined,
    reason: undefined,
    description: undefined,
    text: undefined,
    frameName: undefined,
    instructionPointerReference: undefined,
    source: undefined,
    line: undefined,
    column: undefined,
  }
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

/** Minimal warning sink (house style avoids a logger dependency here). */
function warn(message: string, extra?: unknown): void {
  console.warn(`[dsh-dap] ${message}`, extra === undefined ? '' : extra)
}

interface DapStartRequestFailure {
  rejected: boolean
  error?: unknown
  /**
   * Resolves (never rejects) when the underlying launch/attach request
   * settles either way. Set by {@link trackDapStartRequest} on each call, so a
   * single failure object must not be reused across launch attempts. Consumed
   * by {@link throwPreferredDapStartError} to bound how long to wait for a
   * delayed adapter-side rejection before falling back to the cascade error
   * from configurationDone.
   */
  settled?: Promise<void>
}

function trackDapStartRequest<T>(promise: Promise<T>, failure: DapStartRequestFailure): Promise<T> {
  const tracked = promise.catch((error: unknown) => {
    failure.rejected = true
    failure.error = error
    throw error
  })
  failure.settled = tracked.then(
    () => {},
    () => {},
  )
  return tracked
}

function combineDapStartErrors(command: 'launch' | 'attach', startError: unknown, configurationError: unknown): Error {
  const startMessage = toErrorMessage(startError)
  const configurationMessage = toErrorMessage(configurationError)
  if (startMessage === configurationMessage) {
    return startError instanceof Error ? startError : new Error(startMessage)
  }
  return new Error(
    `DAP ${command} failed: ${startMessage}\nDAP configurationDone also failed: ${configurationMessage}`,
  )
}

async function throwPreferredDapStartError(
  command: 'launch' | 'attach',
  startFailure: DapStartRequestFailure,
  configurationError: unknown,
): Promise<never> {
  await Promise.race([startFailure.settled ?? Promise.resolve(), sleepMs(50)])
  if (startFailure.rejected) {
    throw combineDapStartErrors(command, startFailure.error, configurationError)
  }
  throw configurationError
}

const DEBUGPY_MISSING_MODULE_RE = /No module named ['"]?debugpy['"]?/

/**
 * Map a generic adapter-side failure into the targeted `pip install debugpy`
 * hint when the adapter is debugpy and stderr/the wrapping error mentions the
 * missing module. Returns null when the heuristic does not apply, so the
 * caller can rethrow the original error untouched.
 */
function mapDebugpyMissingModule(adapterName: string, error: unknown): Error | null {
  if (adapterName !== 'debugpy') return null
  if (!DEBUGPY_MISSING_MODULE_RE.test(toErrorMessage(error))) return null
  return new Error("adapter 'debugpy' is not available: install with 'pip install debugpy'")
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath)
}

function truncateOutput(session: DapSession, output: string, maxOutputBytes: number): void {
  if (!output) return
  const bytes = Buffer.byteLength(output, 'utf-8')
  session.outputChunks.push(output)
  session.outputBytes += bytes
  session.outputBufferedBytes += bytes
  // Trim whole chunks from the front, but only while the remainder still holds
  // a full maxOutputBytes tail — dropping the front chunk whenever the total
  // exceeded the cap could retain far less than the cap (e.g. [120KB, 10KB]
  // would keep only 10KB). Recomputing one big string's byte length per 1KB
  // trim iteration was O(n^2) inside the event dispatch loop.
  while (session.outputChunks.length > 1) {
    const frontBytes = Buffer.byteLength(session.outputChunks[0] ?? '', 'utf-8')
    if (session.outputBufferedBytes - frontBytes < maxOutputBytes) break
    session.outputChunks.shift()
    session.outputBufferedBytes -= frontBytes
    session.outputTruncated = true
  }
  if (session.outputBufferedBytes > maxOutputBytes) {
    // Byte-slice the front chunk's head so exactly the cap remains (a torn
    // code point at the cut decodes as U+FFFD, acceptable for log output).
    const front = session.outputChunks[0] ?? ''
    const frontBytes = Buffer.byteLength(front, 'utf-8')
    const excess = session.outputBufferedBytes - maxOutputBytes
    const kept = Buffer.from(front, 'utf-8').subarray(excess).toString('utf-8')
    session.outputChunks[0] = kept
    session.outputBufferedBytes += Buffer.byteLength(kept, 'utf-8') - frontBytes
    session.outputTruncated = true
  }
}

/**
 * Drain a `runInTerminal` debuggee's stdout into the session output buffer.
 * The reverse-request path has no terminal surface here, so route the child's
 * stdout through {@link truncateOutput}: this bounds memory at maxOutputBytes
 * and surfaces the program's output to the agent, mirroring the adapter's own
 * `output` events. Runs in the background; a killed child or closed pipe ends
 * the loop quietly.
 */
async function drainTerminalStdout(stream: Readable, session: DapSession, maxOutputBytes: number): Promise<void> {
  const decoder = new TextDecoder()
  try {
    for await (const chunk of stream) {
      truncateOutput(session, decoder.decode(chunk as Buffer, { stream: true }), maxOutputBytes)
    }
    truncateOutput(session, decoder.decode(), maxOutputBytes)
  } catch {
    // Child killed or pipe closed mid-stream; nothing more to surface.
  }
}

function summarizeBreakpointCount(breakpoints: Map<string, DapBreakpointRecord[]>): number {
  let total = 0
  for (const entries of breakpoints.values()) {
    total += entries.length
  }
  return total
}

function buildSummary(session: DapSession): DapSessionSummary {
  return {
    id: session.id,
    adapter: session.adapter.name,
    cwd: session.cwd,
    program: session.program,
    status: session.status,
    launchedAt: new Date(session.launchedAt).toISOString(),
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    threadId: session.stop.threadId,
    frameId: session.stop.frameId,
    stopReason: session.stop.reason,
    stopDescription: session.stop.description ?? session.stop.text,
    frameName: session.stop.frameName,
    instructionPointerReference: session.stop.instructionPointerReference,
    source: session.stop.source,
    line: session.stop.line,
    column: session.stop.column,
    breakpointFiles: session.breakpoints.size,
    breakpointCount: summarizeBreakpointCount(session.breakpoints),
    functionBreakpointCount: session.functionBreakpoints.length,
    outputBytes: session.outputBytes,
    outputTruncated: session.outputTruncated,
    exitCode: session.exitCode,
    needsConfigurationDone: session.needsConfigurationDone && !session.configurationDoneSent,
    parentSessionId: session.parentSessionId,
    childSessionIds: session.childSessionIds.size > 0 ? [...session.childSessionIds] : undefined,
  }
}

/**
 * Coordinates every debug session for one `ctx.dap` instance. One active
 * session at a time; launch/attach, breakpoints, stepping, inspection, and
 * teardown all funnel through here.
 */
export class DapSessionManager {
  #sessions = new Map<string, DapSession>()
  #activeSessionId: string | null = null
  #cleanupTimer: ReturnType<typeof setInterval> | undefined
  #nextId = 0
  #treeOutcomeWaiters = new Set<DapTreeOutcomeWaiter>()
  #disposed = false
  readonly #spawner: DapSpawner
  readonly #idleTimeoutMs: number
  readonly #cleanupIntervalMs: number
  readonly #maxOutputBytes: number
  readonly #now: () => number

  constructor(options: DapSessionManagerOptions) {
    this.#spawner = options.spawn
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.#cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.#now = options.now ?? (() => Date.now())
    this.#startCleanupTimer()
  }

  /** Dispose every session and stop the cleanup timer. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer)
      this.#cleanupTimer = undefined
    }
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    this.#activeSessionId = null
    for (const session of sessions) {
      void session.client.dispose().catch(() => {})
    }
  }

  /**
   * Return the active (root) debug session summary, or null when none is running.
   * @returns the active session snapshot, or null.
   */
  getActiveSession(): DapSessionSummary | null {
    const session = this.#getActiveSessionOrNull()
    return session ? buildSummary(session) : null
  }

  /**
   * List every live debug session in the current session tree.
   * @returns the live session snapshots.
   */
  listSessions(): DapSessionSummary[] {
    return Array.from(this.#sessions.values()).map(buildSummary)
  }

  /**
   * Return the DAP capabilities the connected adapter advertised during initialization.
   * @returns the adapter capabilities, or null when no session is active.
   */
  getCapabilities(): DapCapabilities | null {
    return this.#getActiveSessionOrNull()?.capabilities ?? null
  }

  /**
   * Launch a debuggee through the selected adapter and wait for the DAP handshake.
   * @param options - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async launch(
    options: DapLaunchSessionOptions,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<DapSessionSummary> {
    this.#ensureLaunchSlot()
    const client = await DapClient.spawn({
      adapter: options.adapter,
      cwd: options.cwd,
      spawn: spec => this.#spawner(spec),
    })
    const session = this.#registerSession(client, options.adapter, options.cwd, options.program)
    try {
      session.capabilities = await client.initialize(
        this.#buildInitializeArguments(options.adapter),
        signal,
        timeoutMs,
      )
      session.needsConfigurationDone = session.capabilities.supportsConfigurationDoneRequest === true
      const launchArguments: DapLaunchArguments = {
        ...options.adapter.launchDefaults,
        ...(options.extraLaunchArguments ?? {}),
        program: options.program,
        cwd: options.cwd,
        ...(options.args !== undefined ? { args: options.args } : {}),
      }
      // Subscribe to stop events BEFORE launching so we don't miss
      // stopOnEntry events that arrive before we start listening.
      const initialStopPromise = this.#prepareStopOutcome(
        session,
        signal,
        Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
      )
      // DAP spec: many adapters do not respond to launch until after
      // configurationDone. Fire launch, complete the config handshake, then
      // await the launch response.
      const launchFailure: DapStartRequestFailure = { rejected: false }
      const launchPromise = trackDapStartRequest(
        client.sendRequest('launch', launchArguments, signal, timeoutMs),
        launchFailure,
      )
      // Mark handled so a fast error response doesn't become an unhandled
      // rejection while we await the config handshake. The actual error still
      // propagates when we await launchPromise below.
      launchPromise.catch(() => {})
      try {
        await this.#completeConfigurationHandshake(session, signal, timeoutMs)
      } catch (error) {
        await throwPreferredDapStartError('launch', launchFailure, error)
      }
      await launchPromise
      // Try to capture initial stopped state (e.g. stopOnEntry). Timeout is
      // acceptable — the program may simply be running.
      let resultSession = session
      try {
        await untilAborted(signal, initialStopPromise)
        const active = this.#getActiveSessionOrNull()
        if (active && this.#getRootSession(active).id === session.id) {
          resultSession = active
        }
        if (resultSession.status === 'stopped') {
          await this.#fetchTopFrame(resultSession, signal, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS))
        }
      } catch {
        if (session.initializedSeen && session.status === 'launching') {
          session.status = session.configurationDoneSent ? 'running' : 'configuring'
        }
      }
      return buildSummary(resultSession)
    } catch (error) {
      this.#disposeSession(session)
      const mapped = mapDebugpyMissingModule(options.adapter.name, error)
      if (mapped) throw mapped
      throw error
    }
  }

  /**
   * Attach to an already-running target (by pid, port, or host) through the selected adapter.
   * @param options - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async attach(
    options: DapAttachSessionOptions,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<DapSessionSummary> {
    this.#ensureLaunchSlot()
    const client = await DapClient.spawn({
      adapter: options.adapter,
      cwd: options.cwd,
      spawn: spec => this.#spawner(spec),
    })
    const session = this.#registerSession(client, options.adapter, options.cwd)
    try {
      session.capabilities = await client.initialize(
        this.#buildInitializeArguments(options.adapter),
        signal,
        timeoutMs,
      )
      session.needsConfigurationDone = session.capabilities.supportsConfigurationDoneRequest === true
      const attachArguments: DapAttachArguments = {
        ...options.adapter.attachDefaults,
        cwd: options.cwd,
        ...(options.pid !== undefined ? { pid: options.pid, processId: options.pid } : {}),
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.host ? { host: options.host } : {}),
      }
      const initialStopPromise = this.#prepareStopOutcome(
        session,
        signal,
        Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
      )
      const attachFailure: DapStartRequestFailure = { rejected: false }
      const attachPromise = trackDapStartRequest(
        client.sendRequest('attach', attachArguments, signal, timeoutMs),
        attachFailure,
      )
      attachPromise.catch(() => {})
      try {
        await this.#completeConfigurationHandshake(session, signal, timeoutMs)
      } catch (error) {
        await throwPreferredDapStartError('attach', attachFailure, error)
      }
      await attachPromise
      let resultSession = session
      try {
        await untilAborted(signal, initialStopPromise)
        const active = this.#getActiveSessionOrNull()
        if (active && this.#getRootSession(active).id === session.id) {
          resultSession = active
        }
        if (resultSession.status === 'stopped') {
          await this.#fetchTopFrame(resultSession, signal, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS))
        }
      } catch {
        if (session.initializedSeen && session.status === 'launching') {
          session.status = session.configurationDoneSent ? 'running' : 'configuring'
        }
      }
      return buildSummary(resultSession)
    } catch (error) {
      this.#disposeSession(session)
      const mapped = mapDebugpyMissingModule(options.adapter.name, error)
      if (mapped) throw mapped
      throw error
    }
  }

  /**
   * Serialize breakpoint mutations per session: every mutator does a
   * read-modify-write of session state around an await, and the adapter-side
   * set*Breakpoints request replaces the whole list — concurrent mutations
   * would silently drop each other's breakpoints on both sides.
   */
  #serializeBreakpointMutation<T>(
    session: DapSession,
    mutate: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const run = session.breakpointMutationQueue.then(() => {
      // A mutation can sit behind several queued 30s predecessors; honor a
      // caller abort at dequeue instead of running a request nobody awaits.
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Aborted')
      return mutate()
    })
    session.breakpointMutationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #syncBreakpointTree(
    origin: DapSession,
    command: string,
    args: unknown,
    prepare: (session: DapSession) => void,
    apply: (session: DapSession, breakpoints: DapBreakpoint[] | undefined) => void,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<void> {
    const sessions = this.#getTreeSessions(origin).filter(
      session => session.status !== 'terminated' && session.client.isAlive(),
    )
    for (const session of sessions) prepare(session)
    await this.#serializeBreakpointMutation(
      origin,
      async () => {
        const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] } | undefined>(
          origin,
          command,
          args,
          signal,
          timeoutMs,
        )
        apply(origin, response?.breakpoints)
      },
      signal,
    )
    await Promise.all(
      sessions
        .filter(session => session !== origin)
        .map(async (session) => {
          try {
            await this.#serializeBreakpointMutation(
              session,
              async () => {
                const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] } | undefined>(
                  session,
                  command,
                  args,
                  signal,
                  timeoutMs,
                )
                apply(session, response?.breakpoints)
              },
              signal,
            )
          } catch (error) {
            warn('Failed to synchronize breakpoint request with child debug session', {
              sessionId: session.id,
              command,
              error: toErrorMessage(error),
            })
          }
        }),
    )
  }

  /**
   * Set (or update) one source breakpoint at file:line, verifying against the adapter.
   * @param file - argument forwarded to the adapter request.
   * @param line - argument forwarded to the adapter request.
   * @param condition - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async setBreakpoint(
    file: string,
    line: number,
    condition?: string,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapBreakpointRecord[]; sourcePath: string }> {
    const session = this.#touchActiveSession()
    const sourcePath = normalizePath(file)
    const root = this.#getRootSession(session)
    const current = [...(root.breakpoints.get(sourcePath) ?? [])].filter(entry => entry.line !== line)
    current.push({ verified: false, line, condition, id: undefined, message: undefined })
    current.sort((left, right) => left.line - right.line)
    const args = {
      source: { path: sourcePath, name: path.basename(sourcePath) },
      breakpoints: current.map<DapSourceBreakpoint>(entry => ({
        line: entry.line,
        ...(entry.condition ? { condition: entry.condition } : {}),
      })),
    }
    await this.#syncBreakpointTree(
      session,
      'setBreakpoints',
      args,
      target =>
        target.breakpoints.set(
          sourcePath,
          current.map(entry => ({ ...entry, verified: false })),
        ),
      (target, response) => target.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(current, response)),
      signal,
      timeoutMs,
    )
    return {
      snapshot: buildSummary(session),
      breakpoints: session.breakpoints.get(sourcePath) ?? [],
      sourcePath,
    }
  }

  /**
   * Remove one source breakpoint at file:line.
   * @param file - argument forwarded to the adapter request.
   * @param line - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async removeBreakpoint(
    file: string,
    line: number,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapBreakpointRecord[]; sourcePath: string }> {
    const session = this.#touchActiveSession()
    const sourcePath = normalizePath(file)
    const root = this.#getRootSession(session)
    const current = [...(root.breakpoints.get(sourcePath) ?? [])].filter(entry => entry.line !== line)
    const args = {
      source: { path: sourcePath, name: path.basename(sourcePath) },
      breakpoints: current.map<DapSourceBreakpoint>(entry => ({
        line: entry.line,
        ...(entry.condition ? { condition: entry.condition } : {}),
      })),
    }
    const prepare = (target: DapSession) => {
      if (current.length === 0) target.breakpoints.delete(sourcePath)
      else
        target.breakpoints.set(
          sourcePath,
          current.map(entry => ({ ...entry, verified: false })),
        )
    }
    await this.#syncBreakpointTree(
      session,
      'setBreakpoints',
      args,
      prepare,
      (target, response) => {
        if (current.length === 0) target.breakpoints.delete(sourcePath)
        else target.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(current, response))
      },
      signal,
      timeoutMs,
    )
    return {
      snapshot: buildSummary(session),
      breakpoints: session.breakpoints.get(sourcePath) ?? [],
      sourcePath,
    }
  }

  /**
   * Add a function breakpoint by qualified name.
   * @param name - argument forwarded to the adapter request.
   * @param condition - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async setFunctionBreakpoint(
    name: string,
    condition?: string,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapFunctionBreakpointRecord[] }> {
    const session = this.#touchActiveSession()
    const current = this.#getRootSession(session).functionBreakpoints.filter(entry => entry.name !== name)
    current.push({ verified: false, name, condition, id: undefined, message: undefined })
    current.sort((left, right) => left.name.localeCompare(right.name))
    const args = {
      breakpoints: current.map<DapFunctionBreakpoint>(entry => ({
        name: entry.name,
        ...(entry.condition ? { condition: entry.condition } : {}),
      })),
    }
    await this.#syncBreakpointTree(
      session,
      'setFunctionBreakpoints',
      args,
      (target) => {
        target.functionBreakpoints = current.map(entry => ({ ...entry, verified: false }))
      },
      (target, response) => {
        target.functionBreakpoints = this.#mapFunctionBreakpoints(current, response)
      },
      signal,
      timeoutMs,
    )
    return { snapshot: buildSummary(session), breakpoints: session.functionBreakpoints }
  }

  /**
   * Remove a function breakpoint by qualified name.
   * @param name - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async removeFunctionBreakpoint(
    name: string,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapFunctionBreakpointRecord[] }> {
    const session = this.#touchActiveSession()
    const current = this.#getRootSession(session).functionBreakpoints.filter(entry => entry.name !== name)
    const args = {
      breakpoints: current.map<DapFunctionBreakpoint>(entry => ({
        name: entry.name,
        ...(entry.condition ? { condition: entry.condition } : {}),
      })),
    }
    await this.#syncBreakpointTree(
      session,
      'setFunctionBreakpoints',
      args,
      (target) => {
        target.functionBreakpoints = current.map(entry => ({ ...entry, verified: false }))
      },
      (target, response) => {
        target.functionBreakpoints = this.#mapFunctionBreakpoints(current, response)
      },
      signal,
      timeoutMs,
    )
    return { snapshot: buildSummary(session), breakpoints: session.functionBreakpoints }
  }

  /**
   * Set an instruction breakpoint at an instruction reference (with optional offset/condition).
   * @param instructionReference - argument forwarded to the adapter request.
   * @param offset - argument forwarded to the adapter request.
   * @param condition - argument forwarded to the adapter request.
   * @param hitCondition - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async setInstructionBreakpoint(
    instructionReference: string,
    offset?: number,
    condition?: string,
    hitCondition?: string,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapInstructionBreakpointRecord[] }> {
    const session = this.#touchActiveSession()
    const current = this.#getRootSession(session).instructionBreakpoints.filter(
      entry => entry.instructionReference !== instructionReference || entry.offset !== offset,
    )
    current.push({
      instructionReference,
      ...(offset !== undefined ? { offset } : {}),
      ...(condition ? { condition } : {}),
      ...(hitCondition ? { hitCondition } : {}),
    })
    current.sort((left, right) => {
      const referenceOrder = left.instructionReference.localeCompare(right.instructionReference)
      return referenceOrder !== 0 ? referenceOrder : (left.offset ?? 0) - (right.offset ?? 0)
    })
    const args = { breakpoints: current } satisfies DapSetInstructionBreakpointsArguments
    let responseBreakpoints: DapBreakpoint[] | undefined
    await this.#syncBreakpointTree(
      session,
      'setInstructionBreakpoints',
      args,
      (target) => {
        target.instructionBreakpoints = current.map(entry => ({ ...entry }))
      },
      (target, response) => {
        if (target === session) responseBreakpoints = response
      },
      signal,
      timeoutMs,
    )
    return {
      snapshot: buildSummary(session),
      breakpoints: this.#mapInstructionBreakpoints(current, responseBreakpoints),
    }
  }

  /**
   * Remove an instruction breakpoint at an instruction reference/offset.
   * @param instructionReference - argument forwarded to the adapter request.
   * @param offset - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async removeInstructionBreakpoint(
    instructionReference: string,
    offset?: number,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapInstructionBreakpointRecord[] }> {
    const session = this.#touchActiveSession()
    const current = this.#getRootSession(session).instructionBreakpoints.filter((entry) => {
      if (entry.instructionReference !== instructionReference) return true
      return offset !== undefined && entry.offset !== offset
    })
    const args = { breakpoints: current } satisfies DapSetInstructionBreakpointsArguments
    let responseBreakpoints: DapBreakpoint[] | undefined
    await this.#syncBreakpointTree(
      session,
      'setInstructionBreakpoints',
      args,
      (target) => {
        target.instructionBreakpoints = current.map(entry => ({ ...entry }))
      },
      (target, response) => {
        if (target === session) responseBreakpoints = response
      },
      signal,
      timeoutMs,
    )
    return {
      snapshot: buildSummary(session),
      breakpoints: this.#mapInstructionBreakpoints(current, responseBreakpoints),
    }
  }

  /**
   * Ask the adapter what data breakpoints are available for a name/expression.
   * @param name - argument forwarded to the adapter request.
   * @param variablesReference - argument forwarded to the adapter request.
   * @param frameId - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async dataBreakpointInfo(
    name: string,
    variablesReference?: number,
    frameId?: number,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; info: DapDataBreakpointInfoResponse }> {
    const session = this.#touchActiveSession()
    const info = await this.#sendRequestWithConfig<DapDataBreakpointInfoResponse>(
      session,
      'dataBreakpointInfo',
      {
        name,
        ...(variablesReference !== undefined ? { variablesReference } : {}),
        ...(frameId !== undefined ? { frameId } : {}),
      } satisfies DapDataBreakpointInfoArguments,
      signal,
      timeoutMs,
    )
    return { snapshot: buildSummary(session), info }
  }

  /**
   * Set a data breakpoint on a dataId with access type and conditions.
   * @param dataId - argument forwarded to the adapter request.
   * @param accessType - argument forwarded to the adapter request.
   * @param condition - argument forwarded to the adapter request.
   * @param hitCondition - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async setDataBreakpoint(
    dataId: string,
    accessType?: 'read' | 'write' | 'readWrite',
    condition?: string,
    hitCondition?: string,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapDataBreakpointRecord[] }> {
    const session = this.#touchActiveSession()
    const current = this.#getRootSession(session).dataBreakpoints.filter(entry => entry.dataId !== dataId)
    current.push({
      dataId,
      ...(accessType ? { accessType } : {}),
      ...(condition ? { condition } : {}),
      ...(hitCondition ? { hitCondition } : {}),
    })
    current.sort((left, right) => left.dataId.localeCompare(right.dataId))
    const args = { breakpoints: current } satisfies DapSetDataBreakpointsArguments
    let responseBreakpoints: DapBreakpoint[] | undefined
    await this.#syncBreakpointTree(
      session,
      'setDataBreakpoints',
      args,
      (target) => {
        target.dataBreakpoints = current.map(entry => ({ ...entry }))
      },
      (target, response) => {
        if (target === session) responseBreakpoints = response
      },
      signal,
      timeoutMs,
    )
    return {
      snapshot: buildSummary(session),
      breakpoints: this.#mapDataBreakpoints(current, responseBreakpoints),
    }
  }

  /**
   * Remove a data breakpoint by dataId.
   * @param dataId - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async removeDataBreakpoint(
    dataId: string,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapDataBreakpointRecord[] }> {
    const session = this.#touchActiveSession()
    const current = this.#getRootSession(session).dataBreakpoints.filter(entry => entry.dataId !== dataId)
    const args = { breakpoints: current } satisfies DapSetDataBreakpointsArguments
    let responseBreakpoints: DapBreakpoint[] | undefined
    await this.#syncBreakpointTree(
      session,
      'setDataBreakpoints',
      args,
      (target) => {
        target.dataBreakpoints = current.map(entry => ({ ...entry }))
      },
      (target, response) => {
        if (target === session) responseBreakpoints = response
      },
      signal,
      timeoutMs,
    )
    return {
      snapshot: buildSummary(session),
      breakpoints: this.#mapDataBreakpoints(current, responseBreakpoints),
    }
  }

  /**
   * Disassemble instructions around a memory reference.
   * @param memoryReference - argument forwarded to the adapter request.
   * @param instructionCount - argument forwarded to the adapter request.
   * @param offset - argument forwarded to the adapter request.
   * @param instructionOffset - argument forwarded to the adapter request.
   * @param resolveSymbols - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async disassemble(
    memoryReference: string,
    instructionCount: number,
    offset?: number,
    instructionOffset?: number,
    resolveSymbols?: boolean,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; instructions: DapDisassembledInstruction[] }> {
    const session = this.#touchActiveSession()
    const response = await this.#sendRequestWithConfig<DapDisassembleResponse | undefined>(
      session,
      'disassemble',
      {
        memoryReference,
        instructionCount,
        ...(offset !== undefined ? { offset } : {}),
        ...(instructionOffset !== undefined ? { instructionOffset } : {}),
        ...(resolveSymbols !== undefined ? { resolveSymbols } : {}),
      } satisfies DapDisassembleArguments,
      signal,
      timeoutMs,
    )
    return { snapshot: buildSummary(session), instructions: response?.instructions ?? [] }
  }

  /**
   * Read raw bytes from the debuggee memory at an address (base64 data).
   * @param memoryReference - argument forwarded to the adapter request.
   * @param count - argument forwarded to the adapter request.
   * @param offset - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async readMemory(
    memoryReference: string,
    count: number,
    offset?: number,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; address: string; data: string | undefined; unreadableBytes: number | undefined }> {
    const session = this.#touchActiveSession()
    const response = await this.#sendRequestWithConfig<DapReadMemoryResponse | undefined>(
      session,
      'readMemory',
      {
        memoryReference,
        count,
        ...(offset !== undefined ? { offset } : {}),
      } satisfies DapReadMemoryArguments,
      signal,
      timeoutMs,
    )
    return {
      snapshot: buildSummary(session),
      address: response?.address ?? memoryReference,
      data: response?.data,
      unreadableBytes: response?.unreadableBytes,
    }
  }

  /**
   * Write raw bytes into debuggee memory at an address.
   * @param memoryReference - argument forwarded to the adapter request.
   * @param data - argument forwarded to the adapter request.
   * @param offset - argument forwarded to the adapter request.
   * @param allowPartial - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async writeMemory(
    memoryReference: string,
    data: string,
    offset?: number,
    allowPartial?: boolean,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; offset: number | undefined; bytesWritten: number | undefined }> {
    const session = this.#touchActiveSession()
    const response = await this.#sendRequestWithConfig<DapWriteMemoryResponse | undefined>(
      session,
      'writeMemory',
      {
        memoryReference,
        data,
        ...(offset !== undefined ? { offset } : {}),
        ...(allowPartial !== undefined ? { allowPartial } : {}),
      } satisfies DapWriteMemoryArguments,
      signal,
      timeoutMs,
    )
    return {
      snapshot: buildSummary(session),
      offset: response?.offset,
      bytesWritten: response?.bytesWritten,
    }
  }

  /**
   * List the debuggee modules starting at startModule.
   * @param startModule - argument forwarded to the adapter request.
   * @param moduleCount - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async modules(
    startModule?: number,
    moduleCount?: number,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; modules: DapModule[] }> {
    const session = this.#touchActiveSession()
    const response = await this.#sendRequestWithConfig<DapModulesResponse | undefined>(
      session,
      'modules',
      {
        ...(startModule !== undefined ? { startModule } : {}),
        ...(moduleCount !== undefined ? { moduleCount } : {}),
      } satisfies DapModulesArguments,
      signal,
      timeoutMs,
    )
    return { snapshot: buildSummary(session), modules: response?.modules ?? [] }
  }

  /**
   * List the sources the adapter has loaded.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async loadedSources(
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; sources: DapSource[] }> {
    const session = this.#touchActiveSession()
    const response = await this.#sendRequestWithConfig<DapLoadedSourcesResponse | undefined>(
      session,
      'loadedSources',
      {},
      signal,
      timeoutMs,
    )
    return { snapshot: buildSummary(session), sources: response?.sources ?? [] }
  }

  /**
   * Send an unstandardized DAP request to the active adapter.
   * @param command - the custom request command name.
   * @param args - optional custom request arguments.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async customRequest(
    command: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; body: unknown }> {
    const session = this.#touchActiveSession()
    const body = await this.#sendRequestWithConfig<unknown>(session, command, args, signal, timeoutMs)
    return { snapshot: buildSummary(session), body }
  }

  /**
   * Continue program execution until the next stop or termination (with timeout).
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async continue(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapContinueOutcome> {
    const session = this.#touchActiveSession()
    const threadId = await this.#resolveThreadId(session, signal, timeoutMs)
    // Reset state and subscribe BEFORE sending continue to avoid missing
    // events that arrive in the same buffer as the response.
    session.stop = blankStopLocation()
    session.lastStackFrames = []
    session.status = 'running'
    const outcomePromise = this.#prepareStopOutcome(session, signal, timeoutMs)
    await this.#sendRequestWithConfig<DapContinueResponse>(
      session,
      'continue',
      { threadId } satisfies DapContinueArguments,
      signal,
      timeoutMs,
    )
    return this.#awaitStopOutcome(session, outcomePromise, signal, timeoutMs)
  }

  /**
   * Pause a running debuggee and wait for the stopped event.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async pause(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapSessionSummary> {
    const session = this.#touchActiveSession()
    // status is mutated by the event reader between awaits; check through a
    // closure so TS does not carry stale narrowing from the early return.
    const isStopped = () => session.status === 'stopped'
    if (isStopped()) {
      return buildSummary(session)
    }
    const threadId = await this.#resolveThreadId(session, signal, timeoutMs)
    // Subscribe BEFORE sending pause: the stopped event can arrive in the
    // same chunk as the response and would otherwise be dispatched before the
    // waiter subscribes, burning the whole timeout.
    const stoppedPromise = session.client.waitForEvent<DapStoppedEventBody>('stopped', undefined, signal, timeoutMs)
    stoppedPromise.catch(() => {})
    await this.#sendRequestWithConfig(session, 'pause', { threadId } satisfies DapPauseArguments, signal, timeoutMs)
    if (!isStopped()) {
      try {
        await untilAborted(signal, stoppedPromise)
      } catch {
        // Timeout or abort — report current state regardless
      }
    }
    return buildSummary(session)
  }

  /**
   * Step into one line of execution.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async stepIn(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapContinueOutcome> {
    return this.#step('stepIn', signal, timeoutMs)
  }

  /**
   * Step out of the current function.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async stepOut(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapContinueOutcome> {
    return this.#step('stepOut', signal, timeoutMs)
  }

  /**
   * Step over one line of execution.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async stepOver(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapContinueOutcome> {
    return this.#step('next', signal, timeoutMs)
  }

  /**
   * List threads across the live session tree.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async threads(
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; threads: DapThread[] }> {
    const anchor = this.#touchActiveSession()
    // A js-debug launch is a session tree: the root may be a threadless
    // launcher while each real thread lives in a child, and other adapters
    // keep every thread on the root. Aggregate across the whole live tree.
    const targets = this.#liveTreeSessions(anchor)
    const merged: DapThread[] = []
    const seen = new Set<string>()
    for (const target of targets) {
      let threads: DapThread[]
      try {
        const response = await this.#sendRequestWithConfig<DapThreadsResponse | undefined>(
          target,
          'threads',
          undefined,
          signal,
          timeoutMs,
        )
        threads = response?.threads ?? []
      } catch (error) {
        // Caller cancellation is not an adapter failure: propagate it instead
        // of degrading a cancelled call into a successful partial result.
        if (signal?.aborted) throw error
        warn('Failed to list threads for debug session', {
          sessionId: target.id,
          error: toErrorMessage(error),
        })
        continue
      }
      target.threads = threads
      // DAP thread IDs are scoped per client session, so identical IDs from
      // different sessions are distinct live threads and MUST be preserved;
      // only collapse an exact repeat within a single session's response.
      for (const thread of threads) {
        const key = `${target.id}\0${thread.id}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(thread)
      }
    }
    return { snapshot: buildSummary(anchor), threads: merged }
  }

  /**
   * Read stack frames for the stopped thread.
   * @param frameCount - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async stackTrace(
    frameCount: number | undefined,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; stackFrames: DapStackFrame[]; totalFrames: number | undefined }> {
    const session = this.#touchActiveSession()
    const threadId = await this.#resolveThreadId(session, signal, timeoutMs)
    const response = await this.#sendRequestWithConfig<DapStackTraceResponse | undefined>(
      session,
      'stackTrace',
      {
        threadId,
        ...(frameCount !== undefined ? { levels: frameCount } : {}),
      } satisfies DapStackTraceArguments,
      signal,
      timeoutMs,
    )
    session.lastStackFrames = response?.stackFrames ?? []
    this.#applyTopFrame(session, session.lastStackFrames[0])
    return {
      snapshot: buildSummary(session),
      stackFrames: session.lastStackFrames,
      totalFrames: response?.totalFrames,
    }
  }

  /**
   * Read scopes for a stack frame.
   * @param frameId - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async scopes(
    frameId: number | undefined,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; scopes: DapScope[] }> {
    const session = this.#touchActiveSession()
    const resolvedFrameId = frameId ?? session.stop.frameId
    if (resolvedFrameId === undefined) {
      throw new Error('No active stack frame. Run stackTrace first or supply frame_id.')
    }
    const response = await this.#sendRequestWithConfig<DapScopesResponse | undefined>(
      session,
      'scopes',
      { frameId: resolvedFrameId } satisfies DapScopesArguments,
      signal,
      timeoutMs,
    )
    return { snapshot: buildSummary(session), scopes: response?.scopes ?? [] }
  }

  /**
   * Read variables under a variable reference.
   * @param variableReference - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async variables(
    variableReference: number,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; variables: DapVariable[] }> {
    const session = this.#touchActiveSession()
    const response = await this.#sendRequestWithConfig<DapVariablesResponse | undefined>(
      session,
      'variables',
      { variablesReference: variableReference } satisfies DapVariablesArguments,
      signal,
      timeoutMs,
    )
    return { snapshot: buildSummary(session), variables: response?.variables ?? [] }
  }

  /**
   * Evaluate an expression in a frame context.
   * @param expression - argument forwarded to the adapter request.
   * @param context - argument forwarded to the adapter request.
   * @param frameId - argument forwarded to the adapter request.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async evaluate(
    expression: string,
    context: DapEvaluateArguments['context'],
    frameId: number | undefined,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<{ snapshot: DapSessionSummary; evaluation: DapEvaluateResponse | undefined }> {
    const session = this.#touchActiveSession()
    // Default to the top stopped frame so callers don't need to pass frame_id
    // explicitly for the common case.
    const effectiveFrameId = frameId ?? session.stop.frameId
    const response = await this.#sendRequestWithConfig<DapEvaluateResponse>(
      session,
      'evaluate',
      {
        expression,
        context: context ?? 'repl',
        ...(effectiveFrameId !== undefined ? { frameId: effectiveFrameId } : {}),
      } satisfies DapEvaluateArguments,
      signal,
      timeoutMs,
    )
    return { snapshot: buildSummary(session), evaluation: response }
  }

  /**
   * Return captured debuggee output, byte-limited from the tail.
   * @param limitBytes - optional byte cap; the tail is returned beyond it.
   * @returns the output snapshot and the session snapshot.
   */
  getOutput(limitBytes?: number): DapOutputSnapshot {
    const session = this.#touchActiveSession()
    const output = session.outputChunks.join('')
    if (!limitBytes || limitBytes <= 0 || session.outputBufferedBytes <= limitBytes) {
      return { snapshot: buildSummary(session), output }
    }
    // Byte-slice the tail once; a torn code point at the cut decodes as U+FFFD.
    const buffer = Buffer.from(output, 'utf-8')
    if (buffer.length <= limitBytes) {
      return { snapshot: buildSummary(session), output }
    }
    return { snapshot: buildSummary(session), output: buffer.subarray(buffer.length - limitBytes).toString('utf-8') }
  }

  /**
   * Terminate the active debug session and wait for exit.
   * @param signal - optional cancellation forwarded to the adapter.
   * @param timeoutMs - per-request timeout budget in ms.
   * @returns the operation result together with the session snapshot.
   */
  async terminate(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapSessionSummary | null> {
    const session = this.#getActiveSessionOrNull()
    if (!session) return null
    this.#touchSessionAndAncestors(session)
    const root = this.#getRootSession(session)
    const summary = buildSummary(session)
    await this.#terminateSessionTree(root, signal, timeoutMs)
    return summary
  }

  async #terminateSessionTree(session: DapSession, signal?: AbortSignal, timeoutMs: number = 30_000): Promise<void> {
    session.status = 'terminated'
    try {
      for (const childId of [...session.childSessionIds]) {
        const child = this.#sessions.get(childId)
        if (child) {
          await this.#terminateSessionTree(child, signal, timeoutMs)
        }
      }
      if (session.capabilities?.supportsTerminateRequest) {
        await session.client.sendRequest('terminate', undefined, signal, timeoutMs).catch(() => undefined)
      }
      await session.client
        .sendRequest('disconnect', { terminateDebuggee: true }, signal, timeoutMs)
        .catch(() => undefined)
    } catch {
      /* Disposal remains mandatory when a caller aborts best-effort DAP shutdown. */
    } finally {
      this.#disposeSession(session)
    }
  }

  #startCleanupTimer(): void {
    if (this.#cleanupTimer) return
    this.#cleanupTimer = setInterval(() => {
      try {
        this.#cleanupIdleSessions()
      } catch (error) {
        warn('DAP idle session cleanup failed', { error: toErrorMessage(error) })
      }
    }, this.#cleanupIntervalMs)
    this.#cleanupTimer.unref()
  }

  #cleanupIdleSessions(): void {
    if (this.#sessions.size === 0) return
    const now = this.#now()
    for (const session of this.#sessions.values()) {
      if (
        session.status === 'terminated' ||
        now - session.lastUsedAt > this.#idleTimeoutMs ||
        !session.client.isAlive()
      ) {
        this.#disposeSession(session)
      }
    }
  }

  async #startChildSession(
    parent: DapSession,
    request: 'launch' | 'attach',
    configuration: Record<string, unknown>,
    timeoutMs: number = 30_000,
  ): Promise<void> {
    if (parent.adapter.connectMode !== 'tcp' || parent.port === undefined) {
      throw new Error(`DAP adapter ${parent.adapter.name} cannot accept child session connections`)
    }
    const cwd = path.resolve(parent.cwd, typeof configuration.cwd === 'string' ? configuration.cwd : '.')
    const client = await DapClient.connect({
      adapter: parent.adapter,
      cwd,
      host: '127.0.0.1',
      port: parent.port,
    })
    const child = this.#registerSession(
      client,
      parent.adapter,
      cwd,
      typeof configuration.program === 'string' ? configuration.program : undefined,
      parent.id,
    )
    try {
      child.capabilities = await client.initialize(
        this.#buildInitializeArguments(parent.adapter),
        undefined,
        timeoutMs,
      )
      child.needsConfigurationDone = child.capabilities.supportsConfigurationDoneRequest === true
      const startFailure: DapStartRequestFailure = { rejected: false }
      const startPromise = trackDapStartRequest(
        client.sendRequest(request, { ...configuration, cwd }, undefined, timeoutMs),
        startFailure,
      )
      startPromise.catch(() => {})
      try {
        await this.#completeConfigurationHandshake(child, undefined, timeoutMs)
      } catch (error) {
        await throwPreferredDapStartError(request, startFailure, error)
      }
      await startPromise
    } catch (error) {
      this.#disposeSession(child)
      throw error
    }
  }

  async #applyRootBreakpointsToSession(
    session: DapSession,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<void> {
    const root = this.#getRootSession(session)
    for (const [sourcePath, entries] of root.breakpoints) {
      try {
        const response = await session.client.sendRequest<{ breakpoints?: DapBreakpoint[] } | undefined>(
          'setBreakpoints',
          {
            source: { path: sourcePath, name: path.basename(sourcePath) },
            breakpoints: entries.map<DapSourceBreakpoint>(entry => ({
              line: entry.line,
              ...(entry.condition ? { condition: entry.condition } : {}),
            })),
          },
          signal,
          timeoutMs,
        )
        session.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(entries, response?.breakpoints))
      } catch (error) {
        warn('Failed to bind source breakpoints in child debug session', {
          sessionId: session.id,
          sourcePath,
          error: toErrorMessage(error),
        })
      }
    }
    if (root.functionBreakpoints.length > 0) {
      try {
        const response = await session.client.sendRequest<{ breakpoints?: DapBreakpoint[] } | undefined>(
          'setFunctionBreakpoints',
          {
            breakpoints: root.functionBreakpoints.map<DapFunctionBreakpoint>(entry => ({
              name: entry.name,
              ...(entry.condition ? { condition: entry.condition } : {}),
            })),
          },
          signal,
          timeoutMs,
        )
        session.functionBreakpoints = this.#mapFunctionBreakpoints(root.functionBreakpoints, response?.breakpoints)
      } catch (error) {
        warn('Failed to bind function breakpoints in child debug session', {
          sessionId: session.id,
          error: toErrorMessage(error),
        })
      }
    }
    if (root.instructionBreakpoints.length > 0) {
      try {
        await session.client.sendRequest(
          'setInstructionBreakpoints',
          { breakpoints: root.instructionBreakpoints } satisfies DapSetInstructionBreakpointsArguments,
          signal,
          timeoutMs,
        )
        session.instructionBreakpoints = root.instructionBreakpoints.map(entry => ({ ...entry }))
      } catch (error) {
        warn('Failed to bind instruction breakpoints in child debug session', {
          sessionId: session.id,
          error: toErrorMessage(error),
        })
      }
    }
    if (root.dataBreakpoints.length > 0) {
      try {
        await session.client.sendRequest(
          'setDataBreakpoints',
          { breakpoints: root.dataBreakpoints } satisfies DapSetDataBreakpointsArguments,
          signal,
          timeoutMs,
        )
        session.dataBreakpoints = root.dataBreakpoints.map(entry => ({ ...entry }))
      } catch (error) {
        warn('Failed to bind data breakpoints in child debug session', {
          sessionId: session.id,
          error: toErrorMessage(error),
        })
      }
    }
  }

  #ensureLaunchSlot(): void {
    for (const session of [...this.#sessions.values()]) {
      if (session.status === 'terminated' || !session.client.isAlive()) {
        this.#disposeSession(session)
      }
    }
    const root = [...this.#sessions.values()].find(session => !session.parentSessionId)
    if (!root) return
    throw new Error(`Debug session ${root.id} is still active. Terminate it before launching another.`)
  }

  #registerSession(
    client: DapClient,
    adapter: DapResolvedAdapter,
    cwd: string,
    program?: string,
    parentSessionId?: string,
  ): DapSession {
    const session: DapSession = {
      id: `debug-${++this.#nextId}`,
      adapter,
      cwd,
      program,
      client,
      status: 'launching',
      launchedAt: this.#now(),
      lastUsedAt: this.#now(),
      breakpoints: new Map(),
      functionBreakpoints: [],
      instructionBreakpoints: [],
      dataBreakpoints: [],
      breakpointMutationQueue: Promise.resolve(),
      outputChunks: [],
      outputBytes: 0,
      outputBufferedBytes: 0,
      outputTruncated: false,
      stop: blankStopLocation(),
      threads: [],
      lastStackFrames: [],
      initializedSeen: false,
      needsConfigurationDone: false,
      configurationDoneSent: false,
      parentSessionId,
      childSessionIds: new Set(),
      port: client.port,
      exitCode: undefined,
      capabilities: undefined,
      heartbeat: undefined,
    }
    client.onReverseRequest('runInTerminal', (rawArgs) => {
      const args = (rawArgs ?? {}) as DapRunInTerminalArguments
      if (!Array.isArray(args.args) || args.args.length === 0) {
        throw new Error('runInTerminal request did not include a command')
      }
      const env = Object.fromEntries(
        Object.entries(args.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
      )
      const proc = this.#spawner({
        argv: args.args,
        cwd: path.resolve(session.cwd, args.cwd ?? '.'),
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: 1_000_000 },
        },
        graceMs: 2_000,
        env: {
          ...NON_INTERACTIVE_ENV,
          ...env,
        },
      })
      // Consume the child's stdout — subprocess pipes it but nothing drains it
      // in this reverse-request path, so an unconsumed stream buffers
      // unboundedly in this process.
      if (proc.stdout) {
        void drainTerminalStdout(proc.stdout, session, this.#maxOutputBytes)
      }
      if (proc.stdin) {
        proc.stdin.end()
      }
      return { processId: proc.pid, shellProcessId: proc.pid } satisfies DapRunInTerminalResponse
    })
    client.onReverseRequest('startDebugging', async (rawArgs) => {
      const startArgs = (rawArgs ?? {}) as Partial<DapStartDebuggingArguments>
      const request = startArgs.request === 'attach' ? 'attach' : 'launch'
      const configuration =
        startArgs.configuration && typeof startArgs.configuration === 'object' ? startArgs.configuration : {}
      warn('Adapter requested child debug session', {
        adapter: session.adapter.name,
        sessionId: session.id,
        request,
        name: typeof configuration.name === 'string' ? configuration.name : undefined,
      })
      await this.#startChildSession(session, request, configuration)
      return {}
    })
    client.onEvent('output', (body) => {
      truncateOutput(session, (body as DapOutputEventBody | undefined)?.output ?? '', this.#maxOutputBytes)
    })
    client.onEvent('initialized', () => {
      session.initializedSeen = true
      session.status = session.configurationDoneSent ? session.status : 'configuring'
    })
    client.onEvent('stopped', (body) => {
      this.#handleStoppedEvent(session, body as DapStoppedEventBody)
      this.#activeSessionId = session.id
      this.#resolveTreeOutcome(session)
    })
    client.onEvent('continued', (body) => {
      const continued = body as { threadId?: number } | undefined
      session.status = 'running'
      session.stop = {
        ...blankStopLocation(),
        threadId: continued?.threadId,
      }
      session.lastStackFrames = []
    })
    client.onEvent('exited', (body) => {
      session.exitCode = (body as DapExitedEventBody | undefined)?.exitCode
      session.status = 'terminated'
      this.#reactivateAfterTermination(session)
      this.#resolveTreeOutcome(session)
    })
    client.onEvent('terminated', () => {
      session.status = 'terminated'
      this.#reactivateAfterTermination(session)
      this.#resolveTreeOutcome(session)
    })
    this.#sessions.set(session.id, session)
    if (parentSessionId) {
      this.#sessions.get(parentSessionId)?.childSessionIds.add(session.id)
    }
    // Focus follows stops, not registrations: a lazily-attached child (e.g. a
    // js-debug `[worker N]` session) must not steal focus from a sibling that
    // is already stopped at a breakpoint / entry. Only claim focus when no
    // live, stopped session currently holds it.
    if (!this.#hasLiveStoppedActiveSession()) {
      this.#activeSessionId = session.id
    }
    const heartbeat = setInterval(() => {
      // The client's own exit wiring already marks the session terminated;
      // the interval only keeps session-wide bookkeeping honest on the rare
      // path where the process outlives its own exit task.
    }, 30_000)
    heartbeat.unref()
    session.heartbeat = heartbeat
    void client.proc.exited.finally(() => {
      clearInterval(heartbeat)
      session.heartbeat = undefined
      session.status = 'terminated'
      this.#reactivateAfterTermination(session)
      this.#resolveTreeOutcome(session)
    })
    return session
  }

  #buildInitializeArguments(adapter: DapResolvedAdapter): DapInitializeArguments {
    return {
      clientID: 'dsh',
      clientName: 'DeepSeek Harness',
      adapterID: adapter.name,
      locale: 'en-US',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsRunInTerminalRequest: true,
      supportsStartDebuggingRequest: true,
      supportsMemoryReferences: true,
      supportsVariableType: true,
      supportsInvalidatedEvent: true,
    }
  }

  /**
   * Wait for the adapter's `initialized` event (if not already received),
   * then send `configurationDone`. Many adapters block the `launch`/`attach`
   * response until this handshake completes.
   */
  async #completeConfigurationHandshake(
    session: DapSession,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<void> {
    if (session.configurationDoneSent) return
    if (!session.needsConfigurationDone) {
      if (session.parentSessionId) {
        await this.#applyRootBreakpointsToSession(session, signal, timeoutMs)
      }
      return
    }
    // Wait for the initialized event if we haven't seen it yet.
    if (!session.initializedSeen) {
      try {
        await untilAborted(signal, session.client.waitForEvent('initialized', undefined, signal, timeoutMs))
      } catch {
        // Adapter may not send initialized (e.g. it already terminated).
        // Proceed anyway — the launch/attach response will surface any real error.
        return
      }
    }
    if (session.parentSessionId) {
      await this.#applyRootBreakpointsToSession(session, signal, timeoutMs)
    }
    await session.client.sendRequest('configurationDone', {}, signal, timeoutMs)
    session.configurationDoneSent = true
    if (session.status === 'configuring') {
      session.status = 'running'
    }
  }

  #handleStoppedEvent(session: DapSession, stopped: DapStoppedEventBody): void {
    session.status = 'stopped'
    session.stop = {
      ...blankStopLocation(),
      threadId: stopped.threadId,
      reason: stopped.reason,
      description: stopped.description,
      text: stopped.text,
    }
    session.lastStackFrames = []
  }

  #applyTopFrame(session: DapSession, frame: DapStackFrame | undefined): void {
    if (!frame) return
    session.stop.frameId = frame.id
    session.stop.frameName = frame.name
    session.stop.instructionPointerReference = frame.instructionPointerReference
    session.stop.source = frame.source
    session.stop.line = frame.line
    session.stop.column = frame.column
  }

  /**
   * Fetch the top stack frame from the adapter and apply it to the session's
   * stop location. Called outside the event dispatch loop to avoid deadlocking
   * the message reader.
   */
  async #fetchTopFrame(session: DapSession, signal?: AbortSignal, timeoutMs: number = 5_000): Promise<void> {
    if (session.stop.threadId === undefined) return
    try {
      const response = await session.client.sendRequest<DapStackTraceResponse | undefined>(
        'stackTrace',
        { threadId: session.stop.threadId, levels: 1 } satisfies DapStackTraceArguments,
        signal,
        timeoutMs,
      )
      session.lastStackFrames = response?.stackFrames ?? []
      this.#applyTopFrame(session, session.lastStackFrames[0])
    } catch (error) {
      warn('Failed to capture stopped frame', {
        sessionId: session.id,
        error: toErrorMessage(error),
      })
    }
  }

  async #step(command: 'stepIn' | 'stepOut' | 'next', signal?: AbortSignal, timeoutMs: number = 30_000) {
    const session = this.#touchActiveSession()
    const threadId = await this.#resolveThreadId(session, signal, timeoutMs)
    // Reset state and subscribe BEFORE sending the step command to avoid
    // missing events that arrive in the same buffer as the response.
    session.stop = blankStopLocation()
    session.lastStackFrames = []
    session.status = 'running'
    const outcomePromise = this.#prepareStopOutcome(session, signal, timeoutMs)
    await this.#sendRequestWithConfig(session, command, { threadId } satisfies DapStepArguments, signal, timeoutMs)
    return this.#awaitStopOutcome(session, outcomePromise, signal, timeoutMs)
  }

  /**
   * Create a promise that resolves when the session stops, terminates, or exits.
   * MUST be called before the command that triggers the event.
   */
  #prepareStopOutcome(session: DapSession, signal?: AbortSignal, timeoutMs: number = 30_000): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const rootSessionId = this.#getRootSession(session).id
    const abortHandler = () => {
      waiter.reject(signal?.reason instanceof Error ? signal.reason : new Error('Debug operation aborted')) }
    const timeout = setTimeout(
      () => { waiter.reject(new Error(`DAP session tree outcome timed out after ${timeoutMs}ms`)) },
      timeoutMs,
    )
    const cleanup = () => {
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', abortHandler)
      this.#treeOutcomeWaiters.delete(waiter)
    }
    const waiter: DapTreeOutcomeWaiter = {
      rootSessionId,
      resolve: (value) => {
        cleanup()
        resolve(value)
      },
      reject: (reason) => {
        cleanup()
        reject(reason)
      },
    }
    this.#treeOutcomeWaiters.add(waiter)
    if (signal) {
      if (signal.aborted) abortHandler()
      else signal.addEventListener('abort', abortHandler, { once: true })
    }
    promise.catch(() => {})
    return promise
  }

  /**
   * Await a pre-subscribed stop outcome, then fetch the top frame if stopped.
   */
  async #awaitStopOutcome(
    session: DapSession,
    outcomePromise: Promise<unknown>,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<DapContinueOutcome> {
    try {
      await untilAborted(signal, outcomePromise)
      const active = this.#getActiveSessionOrNull()
      const resultSession =
        active && this.#getRootSession(active).id === this.#getRootSession(session).id ? active : session
      if (resultSession.status === 'stopped') {
        await this.#fetchTopFrame(resultSession, signal, Math.min(timeoutMs, 5_000))
      }
      const state =
        resultSession.status === 'stopped'
          ? 'stopped'
          : resultSession.status === 'terminated'
            ? 'terminated'
            : 'running'
      return { snapshot: buildSummary(resultSession), state, timedOut: false }
    } catch (error) {
      if (signal?.aborted) throw error
      const active = this.#getActiveSessionOrNull()
      const resultSession =
        active && this.#getRootSession(active).id === this.#getRootSession(session).id ? active : session
      return {
        snapshot: buildSummary(resultSession),
        state: 'running',
        timedOut: resultSession.status === 'running',
      }
    }
  }

  async #resolveThreadId(session: DapSession, signal?: AbortSignal, timeoutMs: number = 30_000): Promise<number> {
    if (session.stop.threadId !== undefined) {
      return session.stop.threadId
    }
    if (session.threads.length > 0) {
      const threadId = session.threads[0]?.id
      if (threadId !== undefined) {
        return threadId
      }
    }
    const response = await session.client.sendRequest<DapThreadsResponse | undefined>('threads', undefined, signal, timeoutMs)
    session.threads = response?.threads ?? []
    const threadId = session.threads[0]?.id
    if (threadId === undefined) {
      throw new Error('Debugger reported no threads.')
    }
    return threadId
  }

  async #sendRequestWithConfig<TBody>(
    session: DapSession,
    command: string,
    args: unknown,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<TBody> {
    await this.#ensureConfigurationDone(session, signal, timeoutMs)
    const body = await session.client.sendRequest<TBody>(command, args, signal, timeoutMs)
    this.#touchSessionAndAncestors(session)
    return body
  }

  async #ensureConfigurationDone(
    session: DapSession,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<void> {
    if (!session.needsConfigurationDone || session.configurationDoneSent) {
      return
    }
    await session.client.sendRequest('configurationDone', {}, signal, timeoutMs)
    session.configurationDoneSent = true
    if (session.status === 'configuring') {
      session.status = 'running'
    }
  }

  #mapSourceBreakpoints(
    input: DapBreakpointRecord[],
    responseBreakpoints: DapBreakpoint[] | undefined,
  ): DapBreakpointRecord[] {
    return input.map((entry, index) => ({
      line: entry.line,
      condition: entry.condition,
      id: responseBreakpoints?.[index]?.id,
      verified: responseBreakpoints?.[index]?.verified ?? false,
      message: responseBreakpoints?.[index]?.message,
    }))
  }

  #mapFunctionBreakpoints(
    input: DapFunctionBreakpointRecord[],
    responseBreakpoints: DapBreakpoint[] | undefined,
  ): DapFunctionBreakpointRecord[] {
    return input.map((entry, index) => ({
      name: entry.name,
      condition: entry.condition,
      id: responseBreakpoints?.[index]?.id,
      verified: responseBreakpoints?.[index]?.verified ?? false,
      message: responseBreakpoints?.[index]?.message,
    }))
  }

  #mapInstructionBreakpoints(
    input: DapInstructionBreakpoint[],
    responseBreakpoints: DapBreakpoint[] | undefined,
  ): DapInstructionBreakpointRecord[] {
    return input.map((entry, index) => ({
      instructionReference: responseBreakpoints?.[index]?.instructionReference ?? entry.instructionReference,
      offset: responseBreakpoints?.[index]?.offset ?? entry.offset,
      condition: entry.condition,
      hitCondition: entry.hitCondition,
      id: responseBreakpoints?.[index]?.id,
      verified: responseBreakpoints?.[index]?.verified ?? false,
      message: responseBreakpoints?.[index]?.message,
    }))
  }

  #mapDataBreakpoints(
    input: DapDataBreakpoint[],
    responseBreakpoints: DapBreakpoint[] | undefined,
  ): DapDataBreakpointRecord[] {
    return input.map((entry, index) => ({
      dataId: entry.dataId,
      accessType: entry.accessType,
      condition: entry.condition,
      hitCondition: entry.hitCondition,
      id: responseBreakpoints?.[index]?.id,
      verified: responseBreakpoints?.[index]?.verified ?? false,
      message: responseBreakpoints?.[index]?.message,
    }))
  }

  #touchActiveSession(): DapSession {
    const session = this.#getActiveSessionOrThrow()
    this.#touchSessionAndAncestors(session)
    if (session.status !== 'terminated' && !session.client.isAlive()) {
      session.status = 'terminated'
    }
    return session
  }

  #getActiveSessionOrNull(): DapSession | null {
    if (!this.#activeSessionId) {
      return null
    }
    const session = this.#sessions.get(this.#activeSessionId) ?? null
    if (!session) {
      this.#activeSessionId = null
    }
    return session
  }

  /** True when the current active session is live and paused at a stop. */
  #hasLiveStoppedActiveSession(): boolean {
    const active = this.#getActiveSessionOrNull()
    return active !== null && active.status === 'stopped' && active.client.isAlive()
  }

  #getActiveSessionOrThrow(): DapSession {
    const session = this.#getActiveSessionOrNull()
    if (!session) {
      throw new Error('No active debug session. Launch or attach first.')
    }
    return session
  }

  #getRootSession(session: DapSession): DapSession {
    let root = session
    while (root.parentSessionId) {
      const parent = this.#sessions.get(root.parentSessionId)
      if (!parent) break
      root = parent
    }
    return root
  }

  #getTreeSessions(session: DapSession): DapSession[] {
    const sessions: DapSession[] = []
    const pending = [this.#getRootSession(session)]
    while (pending.length > 0) {
      const current = pending.pop()
      if (!current) continue
      sessions.push(current)
      for (const childId of current.childSessionIds) {
        const child = this.#sessions.get(childId)
        if (child) pending.push(child)
      }
    }
    return sessions
  }

  /**
   * Live (non-terminated, connected) sessions in `session`'s tree, or the
   * session itself when the tree has collapsed. Used to fan `threads` out
   * across the whole tree; a threadless session just reports no threads, so
   * this makes no assumption about which node owns them.
   */
  #liveTreeSessions(session: DapSession): DapSession[] {
    const live = this.#getTreeSessions(session).filter(
      candidate => candidate.status !== 'terminated' && candidate.client.isAlive(),
    )
    return live.length > 0 ? live : [session]
  }

  #touchSessionAndAncestors(session: DapSession): void {
    const now = this.#now()
    let current: DapSession | undefined = session
    while (current) {
      current.lastUsedAt = now
      current = current.parentSessionId ? this.#sessions.get(current.parentSessionId) : undefined
    }
  }

  /** Point the active session at a live tree member when the active one terminates. */
  #reactivateAfterTermination(session: DapSession): void {
    if (this.#activeSessionId !== session.id) return
    const live = this.#getTreeSessions(session).filter(
      candidate => candidate.status !== 'terminated' && candidate.client.isAlive(),
    )
    if (live.length === 0) return
    const replacement =
      live.find(candidate => candidate.status === 'stopped') ??
      live.find(candidate => candidate.parentSessionId !== undefined) ??
      live[0]
    if (replacement) {
      this.#activeSessionId = replacement.id
    }
  }

  #resolveTreeOutcome(session: DapSession): void {
    const rootId = this.#getRootSession(session).id
    for (const waiter of [...this.#treeOutcomeWaiters]) {
      if (waiter.rootSessionId === rootId) {
        waiter.resolve(undefined)
      }
    }
  }

  #disposeSession(session: DapSession): void {
    if (!this.#sessions.has(session.id)) return
    for (const childId of [...session.childSessionIds]) {
      const child = this.#sessions.get(childId)
      if (child) this.#disposeSession(child)
    }
    this.#sessions.delete(session.id)
    if (session.parentSessionId) {
      this.#sessions.get(session.parentSessionId)?.childSessionIds.delete(session.id)
    }
    if (this.#activeSessionId === session.id) {
      const parent = session.parentSessionId ? this.#sessions.get(session.parentSessionId) : undefined
      this.#activeSessionId = parent?.id ?? this.#sessions.values().next().value?.id ?? null
    }
    if (session.heartbeat) {
      clearInterval(session.heartbeat)
      session.heartbeat = undefined
    }
    void session.client.dispose().catch(() => {})
  }
}

/**
 * Reject when `signal` aborts, otherwise settle with `promise`.
 * @param signal - the caller's cancellation signal (may be undefined or already aborted).
 * @param promise - the outcome to propagate when the signal never aborts.
 */
function untilAborted<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
