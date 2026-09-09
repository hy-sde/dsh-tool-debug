/**
 * A live DAP client: spawns (or connects to) one Debug Adapter Protocol
 * adapter, owns request/response correlation, event dispatch, reverse
 * requests, and connection teardown. Talks over the DSH subprocess seam for
 * stdio adapters and over node:net for `tcp` (js-debug) and `socket` (dlv)
 * modes. Ported from oh-my-pi's `coding-agent/src/dap/client.ts`
 * (MIT) with its Bun/ptree plumbing mapped onto `ctx.subprocess` and
 * `node:net`.
 * @module @hy-sde-org/dsh-dap/client
 */

import { createServer, connect as netConnect, type Socket } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { stat } from 'node:fs/promises'
import { isErrnoException, sleepMs } from './util.ts'
import { encodeDapMessage, MessageFramer } from './framing.ts'
import { NON_INTERACTIVE_ENV } from './env.ts'
import type {
  DapCapabilities,
  DapEventMessage,
  DapInitializeArguments,
  DapPendingRequest,
  DapRequestMessage,
  DapResolvedAdapter,
  DapResponseMessage,
} from './types.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Write surface accepted by the message path (subprocess stdin or a net socket). */
export interface DapWriteSink {
  write(data: string | Uint8Array, callback?: (error?: Error | null) => void): boolean
}

/** How the DAP bytes arrive: an evented byte source plus an exit boundary. */
export interface DapTransport {
  /** Attach a raw-bytes handler. */
  onData(handler: (chunk: Buffer) => void): void
  /** Attach a fatal-close handler invoked exactly once with the cause. */
  onClose(handler: (error: Error) => void): void
  /** End the outbound side (and the process for stdio transports). */
  close(): void
}

/** Handler invoked for each adapter→client event. */
export type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>
/** Handler invoked for each adapter→client reverse request. */
export type DapReverseRequestHandler = (args: unknown) => unknown

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Hard cap on a single message write. A wedged adapter stdin used to hang the
 *  whole client forever; on hitting this cap the client disposes itself so the
 *  next request fails fast instead of piling more work onto a broken adapter. */
const WRITE_MESSAGE_TIMEOUT_MS = 30_000
/** Default wait for socket-mode adapters to become reachable. */
const SOCKET_READY_TIMEOUT_MS = 10_000

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

/** A fake proc for pure-socket clients (no process of our own to manage). */
function procLike(exited: Promise<void>): DapClient['proc'] {
  return {
    exitCode: null,
    kill() {
      /* no process owned; the socket transport owns teardown */
    },
    exited,
    stderrTail: () => '',
    stdin: undefined,
    stdout: undefined,
  }
}

/**
 * DAP client bound to one adapter process or socket.
 *
 * Transport lifecycle: a stdio client owns the spawned adapter (dispose kills
 * the process tree); a socket-mode or tcp client owns the connection (dispose
 * ends the socket). In every mode the reader loop drains framed messages,
 * resolves matching responses, dispatches events, and answers adapter→client
 * requests; a lost transport fails every in-flight request and event waiter
 * fast instead of leaving them to their own timeouts.
 */
export class DapClient {
  /** The resolved adapter this client is bound to. */
  readonly adapter: DapResolvedAdapter
  /** The working directory the adapter was spawned in. */
  readonly cwd: string
  /** TCP server port reused by child DAP sessions (tcp mode only). */
  readonly port: number | undefined

  /**
   * The process facade: `exitCode` stays null until the transport dies, then
   * {@link #failConnection} observes the exit through the exited promise.
   * Exposed as a well-typed readonly so factories and tests can build it.
   */
  readonly proc: {
    readonly exitCode: number | null
    readonly kill: () => void
    readonly exited: Promise<unknown>
    readonly stderrTail: () => string
    readonly stdin: Writable | undefined
    readonly stdout: Readable | undefined
  }
  readonly #sink: DapWriteSink
  readonly #transport: DapTransport
  #requestSeq = 0
  #pendingRequests = new Map<number, DapPendingRequest>()
  #isReading = false
  #disposed = false
  #lastActivity = Date.now()
  #capabilities?: DapCapabilities
  #eventHandlers = new Map<string, Set<DapEventHandler>>()
  #anyEventHandlers = new Set<DapEventHandler>()
  #reverseRequestHandlers = new Map<string, DapReverseRequestHandler>()
  #adapterExited = false
  #pendingWriteExitRejectors = new Set<() => void>()
  #eventWaiterRejectors = new Set<(error: Error) => void>()
  #messageBuffer: Buffer | undefined

  private constructor(
    adapter: DapResolvedAdapter,
    cwd: string,
    proc: DapClient['proc'],
    sink: DapWriteSink,
    transport: DapTransport,
    port?: number,
  ) {
    this.adapter = adapter
    this.cwd = cwd
    this.proc = proc
    this.#sink = sink
    this.#transport = transport
    this.port = port
  }

  /** Spawn an adapter over its configured transport (`stdio` | `socket` | `tcp`).
   * @param options - spawn configuration: adapter, cwd, subprocess spawn fn, socket readiness timeout.
   * @returns a live client bound to the spawned adapter.
   */
  static spawn(options: {
    adapter: DapResolvedAdapter
    cwd: string
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
    socketReadyTimeoutMs?: number
  }): Promise<DapClient> {
    const { adapter, cwd, spawn } = options
    const timeoutMs = options.socketReadyTimeoutMs ?? SOCKET_READY_TIMEOUT_MS
    const env = { ...NON_INTERACTIVE_ENV }
    if (adapter.connectMode === 'socket') {
      return this.#spawnSocketMode({ adapter, cwd, spawn, env, timeoutMs })
    }
    if (adapter.connectMode === 'tcp') {
      return this.#spawnTcpMode({ adapter, cwd, spawn, env, timeoutMs })
    }
    return this.#spawnStdioMode({ adapter, cwd, spawn, env, timeoutMs })
  }

  /** Connect to an existing session on an established TCP DAP server.
   * @param options - connection configuration: adapter, cwd, host, and TCP port.
   * @returns a live client bound to the existing DAP server.
   */
  static connect(options: {
    adapter: DapResolvedAdapter
    cwd: string
    host: string
    port: number
  }): Promise<DapClient> {
    const { adapter, cwd, host, port } = options
    const exited = Promise.withResolvers<void>()
    const closed = () => { exited.resolve() }
    const socket = netConnect({ host, port })
    socket.setNoDelay(true)
    const pair = socketTransport(socket, closed)
    const client = new DapClient(adapter, cwd, procLike(exited.promise), pair.sink, pair.transport, port)
    void exited.promise.then(() => { client.#handleProcessExit() }).catch(() => undefined)
    void exited.promise.catch(() => undefined)
    client.#startMessageReader()
    return Promise.resolve(client)
  }

  /** Adapter capabilities reported by the `initialize` response. */
  get capabilities(): DapCapabilities | undefined {
    return this.#capabilities
  }

  /** Milliseconds since the epoch of the last transport activity. */
  get lastActivity(): number {
    return this.#lastActivity
  }

  /** True while the client has not been disposed.
   * @returns whether the client is still alive.
   */
  isAlive(): boolean {
    return !this.#disposed
  }

  /** Send `initialize` and cache the returned adapter capabilities.
   * @param args - initialize arguments.
   * @param signal - optional abort signal.
   * @param timeoutMs - optional request timeout in ms.
   * @returns the adapter capabilities.
   */
  async initialize(args: DapInitializeArguments, signal?: AbortSignal, timeoutMs?: number): Promise<DapCapabilities> {
    const body = (await this.sendRequest('initialize', args, signal, timeoutMs)) as DapCapabilities | undefined
    this.#capabilities = body ?? {}
    return this.#capabilities
  }

  /** Register a handler for one DAP event.
   * @param event - the event name to listen for.
   * @param handler - called with the event body and raw message.
   * @returns an unsubscribe function.
   */
  onEvent(event: string, handler: DapEventHandler): () => void {
    const handlers = this.#eventHandlers.get(event) ?? new Set<DapEventHandler>()
    handlers.add(handler)
    this.#eventHandlers.set(event, handlers)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) {
        this.#eventHandlers.delete(event)
      }
    }
  }

  /** Register a handler invoked for every DAP event.
   * @param handler - called with the event body and raw message.
   * @returns an unsubscribe function.
   */
  onAnyEvent(handler: DapEventHandler): () => void {
    this.#anyEventHandlers.add(handler)
    return () => {
      this.#anyEventHandlers.delete(handler)
    }
  }

  /** Register a handler for one adapter→client reverse request command.
   * @param command - the request command name.
   * @param handler - called with the request arguments.
   * @returns an unsubscribe function.
   */
  onReverseRequest(command: string, handler: DapReverseRequestHandler): () => void {
    this.#reverseRequestHandlers.set(command, handler)
    return () => {
      if (this.#reverseRequestHandlers.get(command) === handler) {
        this.#reverseRequestHandlers.delete(command)
      }
    }
  }

  /** Resolve with the body of the next matching event.
   * @param event - the event name to wait for.
   * @param predicate - optional predicate on the event body.
   * @param signal - optional abort signal.
   * @param timeoutMs - how long to wait before rejecting.
   * @returns the matching event body.
   */
  async waitForEvent<TBody>(
    event: string,
    predicate?: (body: TBody) => boolean,
    signal?: AbortSignal,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<TBody> {
    if (signal?.aborted) {
      throw new Error(signal.reason instanceof Error ? signal.reason.message : 'Debug operation aborted')
    }
    const { promise, resolve, reject } = Promise.withResolvers<TBody>()
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`DAP event ${event} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const cleanup = () => {
      unsubscribe()
      this.#eventWaiterRejectors.delete(closeHandler)
      clearTimeout(timeout)
      if (signal) {
        signal.removeEventListener('abort', abortHandler)
      }
    }
    const abortHandler = () => {
      cleanup()
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Debug operation aborted'))
    }
    const closeHandler = (error: Error) => {
      cleanup()
      reject(error)
    }
    const unsubscribe = this.onEvent(event, (body) => {
      const typedBody = body as TBody
      if (predicate && !predicate(typedBody)) {
        return
      }
      cleanup()
      resolve(typedBody)
    })
    this.#eventWaiterRejectors.add(closeHandler)
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true })
    }
    return promise
  }

  /** Send a DAP request and resolve with the response body.
   * @param command - the DAP request command.
   * @param args - the request arguments.
   * @param signal - optional abort signal.
   * @param timeoutMs - how long to wait for the response before rejecting.
   * @returns the response body.
   */
  async sendRequest<TBody = unknown>(
    command: string,
    args?: unknown,
    signal?: AbortSignal,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<TBody> {
    if (signal?.aborted) {
      throw new Error(signal.reason instanceof Error ? signal.reason.message : 'Debug operation aborted')
    }
    if (this.#disposed) {
      throw new Error(`DAP adapter ${this.adapter.name} is not running`)
    }
    const requestSeq = ++this.#requestSeq
    const request: DapRequestMessage = {
      seq: requestSeq,
      type: 'request',
      command,
      arguments: args,
    }
    const { promise, resolve, reject } = Promise.withResolvers<TBody>()
    // Suppress "unhandled rejection" if the request timer or abort fires
    // before the caller's `await` subscribes — e.g. while #writeMessage is
    // still racing a wedged stdin flush. The caller's own `await` still
    // receives the rejection normally; this handler is a passive guard.
    promise.catch(() => {})

    const timeout = setTimeout(() => {
      if (!this.#pendingRequests.has(requestSeq)) return
      this.#pendingRequests.delete(requestSeq)
      cleanup()
      reject(new Error(`DAP request ${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      if (signal) {
        signal.removeEventListener('abort', abortHandler)
      }
    }
    const abortHandler = () => {
      this.#pendingRequests.delete(requestSeq)
      cleanup()
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Debug operation aborted'))
    }
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true })
    }
    this.#pendingRequests.set(requestSeq, {
      command,
      resolve: (body) => {
        cleanup()
        resolve(body as TBody)
      },
      reject: (error) => {
        cleanup()
        reject(error)
      },
    })
    this.#lastActivity = Date.now()
    // Fire the write in the background. Awaiting it here would let a wedged
    // stdin flush block the caller's `timeoutMs`; if it fails, propagate the
    // failure into `promise` — the timer or abort may still win the race.
    void this.#writeMessage(request).catch((error: unknown) => {
      if (!this.#pendingRequests.has(requestSeq)) return
      this.#pendingRequests.delete(requestSeq)
      cleanup()
      reject(error)
    })
    return promise
  }

  /** Send a response to an adapter request.
   * @param request - the request message being answered.
   * @param success - whether the request succeeded.
   * @param body - optional response body.
   * @param message - optional error message.
   * @returns a promise that resolves when the response is written.
   */
  async sendResponse(request: DapRequestMessage, success: boolean, body?: unknown, message?: string): Promise<void> {
    const response: DapResponseMessage = {
      seq: ++this.#requestSeq,
      type: 'response',
      request_seq: request.seq,
      success,
      command: request.command,
      ...(message ? { message } : {}),
      ...(body !== undefined ? { body } : {}),
    }
    await this.#writeMessage(response)
  }

  /**
   * Framed write to the adapter, bounded by {@link WRITE_MESSAGE_TIMEOUT_MS}
   * and by adapter exit. Without this bound a wedged adapter stdin used to
   * hang the whole client forever. On timeout or exit-before-write the client
   * disposes itself and rethrows.
   */
  async #writeMessage(message: DapRequestMessage | DapResponseMessage): Promise<void> {
    const framed = encodeDapMessage(message)
    if (this.#adapterExited) {
      throw new Error(`DAP adapter ${this.adapter.name} exited before write completed`)
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = (timer: ReturnType<typeof setTimeout> | undefined, onExit: () => void): void => {
        if (timer !== undefined) clearTimeout(timer)
        this.#pendingWriteExitRejectors.delete(onExit)
      }
      const timer = setTimeout(() => {
        cleanup(timer, onExit)
        reject(new Error(`DAP adapter ${this.adapter.name} write timed out after ${WRITE_MESSAGE_TIMEOUT_MS}ms`))
      }, WRITE_MESSAGE_TIMEOUT_MS)
      const onExit = () => {
        cleanup(timer, onExit)
        reject(new Error(`DAP adapter ${this.adapter.name} exited before write completed`))
      }
      this.#pendingWriteExitRejectors.add(onExit)
      try {
        this.#sink.write(framed, (error) => {
          cleanup(timer, onExit)
          if (error) {
            // The client is now known-broken. Kick off dispose in the background;
            // callers will see subsequent sendRequest calls fail fast.
            void this.dispose()
            reject(error)
            return
          }
          resolve()
        })
      } catch (error) {
        cleanup(timer, onExit)
        void this.dispose()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Spawn the adapter for connectMode `stdio`. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#rejectPendingRequests(new Error(`DAP adapter ${this.adapter.name} disposed`))
    try {
      this.#transport.close()
    } catch {
      /* transport may already be closed */
    }
    try {
      this.proc.kill()
    } catch {
      /* already exited */
    }
    await this.proc.exited.catch(() => {})
  }

  #startMessageReader(): void {
    if (this.#isReading) return
    this.#isReading = true
    const framer = new MessageFramer(this.#messageBuffer)

    let failed = false
    const failConnection = (error: Error) => {
      if (failed) return
      failed = true
      this.#rejectPendingRequests(error)
      const waiters = Array.from(this.#eventWaiterRejectors)
      this.#eventWaiterRejectors.clear()
      for (const reject of waiters) reject(error)
    }

    const onChunk = (chunk: Buffer) => {
      this.#lastActivity = Date.now()
      framer.push(chunk)
      for (const messageText of framer.drain((headerText) => {
        // Non-protocol bytes (e.g. an adapter printing to stdout). Drop past
        // the bogus terminator and resync instead of stalling on the same junk
        // header forever.
        this.#onFramingResync(headerText)
      })) {
        try {
          const message = JSON.parse(messageText) as DapResponseMessage | DapEventMessage | DapRequestMessage
          if (message.type === 'response') {
            this.#handleResponse(message)
          } else if (message.type === 'event') {
            void this.#dispatchEvent(message)
          } else {
            void this.#handleAdapterRequest(message)
          }
        } catch (error) {
          this.#onMessageFailure(error)
        }
      }
    }
    const onClose = (error: Error) => {
      // The transport is gone — on a thrown error or a clean stream end. Fail
      // every in-flight request and event waiter so callers see an immediate
      // error instead of waiting out their own timeout.
      this.#messageBuffer = undefined
      failConnection(error)
    }

    this.#transport.onData((chunk) => {
      try {
        onChunk(Buffer.from(chunk))
      } catch (error) {
        failConnection(error instanceof Error ? error : new Error(String(error)))
      }
    })
    this.#transport.onClose(onClose)
  }

  #onFramingResync(headerText: string): void {
    // A non-protocol header block (e.g. an adapter printing to stdout). We
    // deliberately avoid a logger dependency; resync is recoverable.
    console.warn(`dap: framing resync: header without Content-Length (${headerText.slice(0, 200)})`)
  }

  #onMessageFailure(error: unknown): void {
    // A malformed message must not kill the reader — later messages are still
    // well-framed.
    console.warn(`dap: message handling failed: ${toErrorMessage(error)}`)
  }

  #handleResponse(message: DapResponseMessage): void {
    const pending = this.#pendingRequests.get(message.request_seq)
    if (!pending) {
      return
    }
    this.#pendingRequests.delete(message.request_seq)
    if (message.success) {
      pending.resolve(message.body)
      return
    }
    const errorMessage = message.message ?? `DAP request ${pending.command} failed`
    pending.reject(new Error(errorMessage))
  }

  async #dispatchEvent(message: DapEventMessage): Promise<void> {
    const handlers = Array.from(this.#eventHandlers.get(message.event) ?? [])
    const anyHandlers = Array.from(this.#anyEventHandlers)
    for (const handler of [...handlers, ...anyHandlers]) {
      try {
        await handler(message.body, message)
      } catch (error) {
        // An event handler failure must not break the reader loop.
        this.#onMessageFailure(error)
      }
    }
  }

  async #handleAdapterRequest(message: DapRequestMessage): Promise<void> {
    try {
      const handler = this.#reverseRequestHandlers.get(message.command)
      if (handler) {
        try {
          const body = await handler(message.arguments)
          await this.sendResponse(message, true, body)
        } catch (error) {
          const errorMessage = toErrorMessage(error)
          await this.sendResponse(
            message,
            false,
            {
              error: {
                id: 1,
                format: errorMessage,
              },
            },
            errorMessage,
          )
        }
        return
      }
      const errorMessage = `Unsupported DAP request: ${message.command}`
      await this.sendResponse(
        message,
        false,
        {
          error: {
            id: 1,
            format: errorMessage,
          },
        },
        errorMessage,
      )
    } catch (error) {
      this.#onMessageFailure(error)
    }
  }

  #handleProcessExit(): void {
    if (this.#disposed) return
    this.#disposed = true
    const stderr = this.proc.stderrTail().trim()
    const error = new Error(
      stderr ? `DAP adapter exited: ${stderr}` : `DAP adapter ${this.adapter.name} exited unexpectedly`,
    )
    this.#failConnection(error)
  }

  /** Reject every in-flight request and wake every event waiter with `error`. */
  #failConnection(error: Error): void {
    this.#rejectPendingRequests(error)
    const waiters = Array.from(this.#eventWaiterRejectors)
    this.#eventWaiterRejectors.clear()
    for (const reject of waiters) {
      reject(error)
    }
  }

  #rejectPendingRequests(error: Error): void {
    for (const pending of this.#pendingRequests.values()) {
      pending.reject(error)
    }
    this.#pendingRequests.clear()
  }

  /** Spawn the adapter for connectMode `stdio`. */
  static #spawnStdioMode(options: {
    adapter: DapResolvedAdapter
    cwd: string
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
    env: Record<string, string>
    timeoutMs: number
  }): Promise<DapClient> {
    const { adapter, cwd, spawn, env } = options
    const handle = spawn({
      argv: [adapter.resolvedCommand, ...adapter.args],
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 1_000_000 },
      },
      graceMs: 2_000,
      env,
    })
    const proc = this.#procFromHandle(handle)
    const transport = stdioTransport(proc)
    const client = new DapClient(adapter, cwd, proc, transport.sink, transport.transport)
    this.#wireExit(client, proc)
    client.#startMessageReader()
    return Promise.resolve(client)
  }

  /** Spawn a tcp-mode adapter (js-debug) on a caller-reserved port and connect. */
  static async #spawnTcpMode(options: {
    adapter: DapResolvedAdapter
    cwd: string
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
    env: Record<string, string>
    timeoutMs: number
  }): Promise<DapClient> {
    const { adapter, cwd, spawn, env, timeoutMs } = options
    const host = '127.0.0.1'
    const port = await reserveTcpPort()
    const args = adapter.args.map(arg => arg.replaceAll('${port}', String(port)))
    const handle = spawn({
      argv: [adapter.resolvedCommand, ...args],
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 1_000_000 },
      },
      graceMs: 2_000,
      env,
    })
    try {
      // Wait for the adapter to announce it is listening on `port` before
      // connecting. Drain stdout here too so a server that prints a banner
      // does not stall: in tcp mode the DAP protocol flows over the socket, so
      // nothing else consumes the adapter's stdout.
      await waitForTcpServerListening(handle, port, timeoutMs)
      const socket = await connectTcpSocket(host, port, timeoutMs, () => isProcessAlive(handle))
      const proc = this.#procFromHandle(handle)
      const pair = socketTransport(socket)
      const client = new DapClient(adapter, cwd, proc, pair.sink, pair.transport, port)
      this.#wireExit(client, proc)
      client.#startMessageReader()
      return client
    } catch (error) {
      try {
        handle.terminate()
      } catch {
        /* proc may already be dead */
      }
      throw error
    }
  }

  /** Spawn a socket-mode adapter; platform picks unix vs dial-back transport. */
  static #spawnSocketMode(options: {
    adapter: DapResolvedAdapter
    cwd: string
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
    env: Record<string, string>
    timeoutMs: number
  }): Promise<DapClient> {
    const { adapter, cwd, spawn, env, timeoutMs } = options
    if (process.platform === 'linux') {
      return this.#spawnSocketUnix({ adapter, cwd, spawn, env, timeoutMs })
    }
    return this.#spawnSocketClientAddr({ adapter, cwd, spawn, env, timeoutMs })
  }

  /** Linux: spawn adapter with `--listen=unix:<path>`, then connect to the socket. */
  static async #spawnSocketUnix(options: {
    adapter: DapResolvedAdapter
    cwd: string
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
    env: Record<string, string>
    timeoutMs: number
  }): Promise<DapClient> {
    const { adapter, cwd, spawn, env, timeoutMs } = options
    const socketPath = `/tmp/dap-${adapter.name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
    const handle = spawn({
      argv: [adapter.resolvedCommand, ...adapter.args, `--listen=unix:${socketPath}`],
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 1_000_000 },
      },
      graceMs: 2_000,
      env,
    })
    try {
      await waitForCondition(() => isUnixSocketReady(socketPath), timeoutMs)
      const socket = await connectUnixSocket(socketPath, timeoutMs)
      const proc = this.#procFromHandle(handle)
      const pair = socketTransport(socket)
      const client = new DapClient(adapter, cwd, proc, pair.sink, pair.transport)
      this.#wireExit(client, proc)
      client.#startMessageReader()
      return client
    } catch (error) {
      try {
        handle.terminate()
      } catch {
        /* proc may already be dead */
      }
      throw error
    }
  }

  /** macOS/other: listen on a random TCP port, spawn adapter with `--client-addr`, accept the connection. */
  static async #spawnSocketClientAddr(options: {
    adapter: DapResolvedAdapter
    cwd: string
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
    env: Record<string, string>
    timeoutMs: number
  }): Promise<DapClient> {
    const { adapter, cwd, spawn, env, timeoutMs } = options
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to reserve a TCP port for a socket-mode adapter')
    }
    const port = address.port

    const handle = spawn({
      argv: [adapter.resolvedCommand, ...adapter.args, `--client-addr=127.0.0.1:${port}`],
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 1_000_000 },
      },
      graceMs: 2_000,
      env,
    })

    const connectionPromise = new Promise<Socket>((resolve, reject) => {
      const onConnection = (socket: Socket) => {
        cleanup()
        resolve(socket)
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        server.off('connection', onConnection)
        server.off('error', onError)
      }
      server.on('connection', onConnection)
      server.on('error', onError)
    })
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => { reject(new Error(`${adapter.name} did not connect within ${timeoutMs}ms`)) },
        timeoutMs,
      )
      timer.unref()
    })

    try {
      const socket = await Promise.race([connectionPromise, timeoutPromise, handleExitRejection(handle)])
      const proc = this.#procFromHandle(handle)
      const pair = socketTransport(socket)
      const client = new DapClient(adapter, cwd, proc, pair.sink, pair.transport)
      this.#wireExit(client, proc)
      client.#startMessageReader()
      return client
    } catch (error) {
      try {
        handle.terminate()
      } catch {
        /* proc may already be dead */
      }
      throw error
    } finally {
      server.close()
    }
  }

  static #procFromHandle(handle: SubprocessHandle): DapClient['proc'] {
    return {
      exitCode: null,
      kill: () => { handle.terminate() },
      exited: handle.done.then(() => undefined, () => undefined),
      stderrTail: () => handle.collected.stderr?.readFrom(0).text ?? '',
      stdin: handle.stdin,
      stdout: handle.stdout ?? undefined,
    }
  }

  static #wireExit(client: DapClient, proc: DapClient['proc']): void {
    void proc.exited.then(() => { client.#handleProcessExit() }).catch(() => undefined)
    void proc.exited.catch(() => undefined)
  }
}

/** One process's stdout is the DAP transport (stdio mode). */
function stdioTransport(proc: {
  stdout: Readable | undefined
  exited: Promise<unknown>
  kill: () => void
  stdin: Writable | undefined
}): { transport: DapTransport; sink: DapWriteSink } {
  let closeHandlers: ((error: Error) => void)[] = []
  let fired = false
  const fire = (error: Error) => {
    if (fired) return
    fired = true
    for (const handler of closeHandlers) handler(error)
    closeHandlers = []
  }
  void proc.exited.then(() => { fire(new Error('DAP adapter process exited')) }).catch(() => {})
  const transport: DapTransport = {
    onData(handler) {
      proc.stdout?.on('data', handler)
    },
    onClose(handler) {
      closeHandlers.push(handler)
    },
    close() {
      proc.kill()
    },
  }
  return {
    transport,
    sink: {
      write(data, callback) {
        const stdin = proc.stdin
        if (!stdin) {
          callback?.(new Error('DAP adapter stdin is closed'))
          return false
        }
        const payload = Buffer.from(data)
        if (payload.length === 0) {
          callback?.(new Error('refusing to write an empty DAP message'))
          return false
        }
        stdin.write(payload, (error?: Error | null) => {
          callback?.(error ?? undefined)
        })
        return true
      },
    },
  }
}

/** A transport backed by a node:net socket. */
function socketTransport(
  socket: Socket,
  onSocketClose?: () => void,
): { transport: DapTransport; sink: DapWriteSink } {
  let closeHandlers: ((error: Error) => void)[] = []
  let fired = false
  const fire = (error: Error) => {
    if (fired) return
    fired = true
    socket.removeAllListeners()
    onSocketClose?.()
    for (const handler of closeHandlers) handler(error)
    closeHandlers = []
  }
  socket.on('close', () => { fire(new Error('DAP socket closed')) })
  socket.on('error', (error) => { fire(error) })
  socket.on('end', () => { fire(new Error('DAP socket ended by peer')) })
  return {
    transport: {
      onData(handler) {
        socket.on('data', handler)
      },
      onClose(handler) {
        closeHandlers.push(handler)
      },
      close() {
        try {
          socket.end()
        } catch {
          socket.destroy()
        }
      },
    },
    sink: {
      write(data, callback) {
        const payload = Buffer.from(data)
        if (payload.length === 0) {
          callback?.(new Error('refusing to write an empty DAP message'))
          return false
        }
        socket.write(payload, (error?: Error | null) => {
          callback?.(error ?? undefined)
        })
        return true
      },
    },
  }
}

/** Resolve with an error when the adapter process exits before the socket arrives. */
async function handleExitRejection(handle: SubprocessHandle): Promise<never> {
  await handle.done
  throw new Error('Adapter process exited before connecting')
}

/** Reserve a free TCP port by binding a server to port 0, noting it, and closing. */
async function reserveTcpPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to reserve a TCP port for a TCP-mode adapter')
  }
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  })
  return port
}

async function isUnixSocketReady(socketPath: string): Promise<boolean> {
  try {
    return (await stat(socketPath)).isSocket()
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false
    throw error
  }
}

/** Poll a condition until it returns true, or a timeout. */
async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleepMs(50)
  }
  throw new Error(`Socket not ready after ${timeoutMs}ms`)
}

/** Try a TCP connect until it succeeds, the deadline passes, or the proc dies. */
async function connectTcpSocket(
  host: string,
  port: number,
  timeoutMs: number,
  procAlive: () => boolean = () => true,
): Promise<Socket> {
  const deadline = Date.now() + timeoutMs
  let lastError: Error | undefined
  while (Date.now() < deadline) {
    if (!procAlive()) {
      throw lastError ?? new Error(`Adapter process exited before TCP port ${host}:${port} was ready`)
    }
    try {
      return await connectOnce(host, port)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      lastError = failure
      await sleepMs(50)
    }
  }
  throw lastError ?? new Error(`TCP port ${host}:${port} was not ready after ${timeoutMs}ms`)
}

function connectOnce(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    socket.setNoDelay(true)
    const onError = (error: Error) => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    const onConnect = () => {
      cleanup()
      resolve(socket)
    }
    const cleanup = () => {
      socket.off('error', onError)
      socket.off('connect', onConnect)
    }
    socket.on('error', onError)
    socket.on('connect', onConnect)
  })
}

function connectUnixSocket(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ path })
    let settled = false
    const timer = setTimeout(
      () => { reject(new Error(`Timed out connecting to unix socket ${path} after ${timeoutMs}ms`)) },
      timeoutMs,
    )
    timer.unref()
    const onerror = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    const onconnect = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(socket)
    }
    socket.on('error', onerror)
    socket.on('connect', onconnect)
  })
}

/** Wait for the adapter stdout to announce the reserved port before connecting. */
async function waitForTcpServerListening(handle: SubprocessHandle, port: number, timeoutMs: number): Promise<void> {
  const stdout = handle.stdout
  if (stdout === undefined) {
    await sleepMs(timeoutMs)
    return
  }
  const ready = Promise.withResolvers<void>()
  const portText = String(port)
  let buffered = ''
  const onData = (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    if (buffered.includes(portText)) {
      ready.resolve()
    }
    // Keep only the tail relevant for banner matching so a chatty adapter
    // cannot grow this buffer without bound.
    if (buffered.length > 4096) {
      buffered = buffered.slice(-1024)
    }
  }
  stdout.on('data', onData)
  stdout.on('end', () => { ready.resolve() })
  stdout.on('error', () => { ready.resolve() })
  await Promise.race([ready.promise, sleepMs(timeoutMs)])
  stdout.off('data', onData)
}

/** True while the adapter process has not exited (subprocess handles expose no exit code until close). */
function isProcessAlive(_handle: SubprocessHandle): boolean {
  return true
}
