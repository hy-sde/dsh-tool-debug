/**
 * Debug Adapter Protocol vocabulary: the typed surface the DAP seam speaks
 * (requests, responses, events, sessions, and adapter configuration). Ported
 * from oh-my-pi's `coding-agent/src/dap/types.ts` (MIT), stripped of
 * its Bun/ptree dependencies so the same shapes work over the DSH subprocess
 * and node:net transports.
 * @module @hy-sde-org/dsh-dap/types
 */

/** One framed DAP message (request, response, or event). */
export type DapMessage = DapRequestMessage | DapResponseMessage | DapEventMessage

/** Lifecycle status of one debug session. */
export type DapSessionStatus = 'launching' | 'configuring' | 'stopped' | 'running' | 'terminated'

/** Common fields shared by every DAP protocol message. */
export interface DapProtocolMessage {
  seq: number
  type: 'request' | 'response' | 'event'
}

/** A request from client to adapter. */
export interface DapRequestMessage extends DapProtocolMessage {
  type: 'request'
  command: string
  arguments?: unknown
}

/** A response from adapter to client. */
export interface DapResponseMessage extends DapProtocolMessage {
  type: 'response'
  request_seq: number
  success: boolean
  command: string
  message?: string
  body?: unknown
}

/** An event from adapter to client. */
export interface DapEventMessage extends DapProtocolMessage {
  type: 'event'
  event: string
  body?: unknown
}

/** Error body payload of a failed response. */
export interface DapErrorBody {
  id?: number
  format: string
  variables?: Record<string, string>
  showUser?: boolean
  sendTelemetry?: boolean
  url?: string
  urlLabel?: string
}

/** A source location reference. */
export interface DapSource {
  name?: string
  path?: string
  sourceReference?: number
  presentationHint?: 'normal' | 'emphasize' | 'deemphasize'
  origin?: string
  adapterData?: unknown
}

/** A breakpoint as reported by the adapter. */
export interface DapBreakpoint {
  id?: number
  verified: boolean
  message?: string
  source?: DapSource
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  instructionReference?: string
  offset?: number
}

/** A breakpoint request entry on a source line. */
export interface DapSourceBreakpoint {
  line: number
  column?: number
  condition?: string
  hitCondition?: string
  logMessage?: string
}

/** A breakpoint request entry on a function. */
export interface DapFunctionBreakpoint {
  name: string
  condition?: string
  hitCondition?: string
}

/** Arguments for the `initialize` request. */
export interface DapInitializeArguments {
  clientID?: string
  clientName?: string
  adapterID?: string
  locale?: string
  linesStartAt1?: boolean
  columnsStartAt1?: boolean
  pathFormat?: 'path' | 'uri'
  supportsVariableType?: boolean
  supportsVariablePaging?: boolean
  supportsRunInTerminalRequest?: boolean
  supportsStartDebuggingRequest?: boolean
  supportsMemoryReferences?: boolean
  supportsProgressReporting?: boolean
  supportsInvalidatedEvent?: boolean
  supportsArgsCanBeInterpretedByShell?: boolean
}

/** Adapter capabilities from the `initialize` response. */
export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean
  supportsFunctionBreakpoints?: boolean
  supportsConditionalBreakpoints?: boolean
  supportsTerminateRequest?: boolean
  supportsTerminateThreadsRequest?: boolean
  supportsEvaluateForHovers?: boolean
  supportsSetVariable?: boolean
  supportsRestartRequest?: boolean
  supportsCompletionsRequest?: boolean
  supportsLogPoints?: boolean
  supportsDisassembleRequest?: boolean
  supportsReadMemoryRequest?: boolean
  supportsWriteMemoryRequest?: boolean
  supportsModulesRequest?: boolean
  supportsLoadedSourcesRequest?: boolean
  supportsExceptionInfoRequest?: boolean
  supportsInstructionBreakpoints?: boolean
  supportsDataBreakpoints?: boolean
  supportsSteppingGranularity?: boolean
  supportsClipboardContext?: boolean
  [key: string]: unknown
}

/** Arguments for a `launch` request. */
export interface DapLaunchArguments {
  program: string
  args?: string[]
  cwd?: string
  stopOnEntry?: boolean
  stopAtBeginningOfMainSubprogram?: boolean
  request?: 'launch'
  [key: string]: unknown
}

/** Arguments for an `attach` request. */
export interface DapAttachArguments {
  pid?: number
  processId?: number
  port?: number
  host?: string
  cwd?: string
  request?: 'attach'
  [key: string]: unknown
}

/** Arguments for a `configurationDone` request. */
export interface DapConfigurationDoneArguments {
  threadId?: number
}

/** Arguments for a `setBreakpoints` request. */
export interface DapSetBreakpointsArguments {
  source: DapSource
  breakpoints: DapSourceBreakpoint[]
  sourceModified?: boolean
}

/** Response body for a `setBreakpoints` request. */
export interface DapSetBreakpointsResponse {
  breakpoints: DapBreakpoint[]
}

/** Arguments for a `setFunctionBreakpoints` request. */
export interface DapSetFunctionBreakpointsArguments {
  breakpoints: DapFunctionBreakpoint[]
}

/** Response body for a `setFunctionBreakpoints` request. */
export interface DapSetFunctionBreakpointsResponse {
  breakpoints: DapBreakpoint[]
}

/** An instruction breakpoint. */
export interface DapInstructionBreakpoint {
  instructionReference: string
  offset?: number
  condition?: string
  hitCondition?: string
}

/** Arguments for a `setInstructionBreakpoints` request. */
export interface DapSetInstructionBreakpointsArguments {
  breakpoints: DapInstructionBreakpoint[]
}

/** Arguments for a `dataBreakpointInfo` request. */
export interface DapDataBreakpointInfoArguments {
  variablesReference?: number
  name: string
  frameId?: number
}

/** Response body for a `dataBreakpointInfo` request. */
export interface DapDataBreakpointInfoResponse {
  dataId: string | null
  description: string
  accessTypes?: Array<'read' | 'write' | 'readWrite'>
  canPersist?: boolean
}

/** A data breakpoint. */
export interface DapDataBreakpoint {
  dataId: string
  accessType?: 'read' | 'write' | 'readWrite'
  condition?: string
  hitCondition?: string
}

/** Arguments for a `setDataBreakpoints` request. */
export interface DapSetDataBreakpointsArguments {
  breakpoints: DapDataBreakpoint[]
}

/** Arguments for a `continue` request. */
export interface DapContinueArguments {
  threadId: number
  singleThread?: boolean
}

/** Response body for a `continue` request. */
export interface DapContinueResponse {
  allThreadsContinued?: boolean
}

/** Arguments for a `pause` request. */
export interface DapPauseArguments {
  threadId: number
}

/** Arguments for `next`/`stepIn`/`stepOut` requests. */
export interface DapStepArguments {
  threadId: number
  singleThread?: boolean
  granularity?: 'statement' | 'line' | 'instruction'
}

/** Arguments for a `terminate` request. */
export interface DapTerminateArguments {
  restart?: boolean
}

/** Arguments for a `disconnect` request. */
export interface DapDisconnectArguments {
  restart?: boolean
  terminateDebuggee?: boolean
  suspendDebuggee?: boolean
}

/** Arguments for a `stackTrace` request. */
export interface DapStackTraceArguments {
  threadId: number
  startFrame?: number
  levels?: number
  format?: Record<string, unknown>
}

/** A stack frame. */
export interface DapStackFrame {
  id: number
  name: string
  source?: DapSource
  line: number
  column: number
  endLine?: number
  endColumn?: number
  instructionPointerReference?: string
  moduleId?: number | string
  presentationHint?: 'normal' | 'label' | 'subtle'
}

/** Response body for a `stackTrace` request. */
export interface DapStackTraceResponse {
  stackFrames: DapStackFrame[]
  totalFrames?: number
}

/** Arguments for a `scopes` request. */
export interface DapScopesArguments {
  frameId: number
}

/** A variable scope of a stack frame. */
export interface DapScope {
  name: string
  /** DAP scope presentation hint (`arguments` | `locals` | `registers`, or adapter-specific). */
  presentationHint?: string
  variablesReference: number
  expensive: boolean
  source?: DapSource
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
}

/** Response body for a `scopes` request. */
export interface DapScopesResponse {
  scopes: DapScope[]
}

/** Arguments for a `variables` request. */
export interface DapVariablesArguments {
  variablesReference: number
  filter?: 'indexed' | 'named'
  start?: number
  count?: number
  format?: Record<string, unknown>
}

/** A variable. */
export interface DapVariable {
  name: string
  value: string
  type?: string
  presentationHint?: {
    kind?: string
    attributes?: string[]
    visibility?: string
    lazy?: boolean
  }
  evaluateName?: string
  variablesReference: number
  namedVariables?: number
  indexedVariables?: number
  memoryReference?: string
}

/** Response body for a `variables` request. */
export interface DapVariablesResponse {
  variables: DapVariable[]
}

/** Arguments for a `disassemble` request. */
export interface DapDisassembleArguments {
  memoryReference: string
  offset?: number
  instructionOffset?: number
  instructionCount: number
  resolveSymbols?: boolean
}

/** One disassembled instruction. */
export interface DapDisassembledInstruction {
  address: string
  instructionBytes?: string
  instruction: string
  symbol?: string
  location?: DapSource
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
}

/** Response body for a `disassemble` request. */
export interface DapDisassembleResponse {
  instructions: DapDisassembledInstruction[]
}

/** Arguments for a `readMemory` request. */
export interface DapReadMemoryArguments {
  memoryReference: string
  offset?: number
  count: number
}

/** Response body for a `readMemory` request. */
export interface DapReadMemoryResponse {
  address: string
  unreadableBytes?: number
  data?: string
}

/** Arguments for a `writeMemory` request. */
export interface DapWriteMemoryArguments {
  memoryReference: string
  offset?: number
  data: string
  allowPartial?: boolean
}

/** Response body for a `writeMemory` request. */
export interface DapWriteMemoryResponse {
  offset?: number
  bytesWritten?: number
}

/** A loaded module. */
export interface DapModule {
  id: number | string
  name: string
  path?: string
  isOptimized?: boolean
  isUserCode?: boolean
  version?: string
  symbolStatus?: string
  symbolFilePath?: string
  dateTimeStamp?: string
  addressRange?: string
}

/** Arguments for a `modules` request. */
export interface DapModulesArguments {
  startModule?: number
  moduleCount?: number
}

/** Response body for a `modules` request. */
export interface DapModulesResponse {
  modules: DapModule[]
  totalModules?: number
}

/** Response body for a `loadedSources` request. */
export interface DapLoadedSourcesResponse {
  sources: DapSource[]
}

/** Arguments for an `evaluate` request. */
export interface DapEvaluateArguments {
  expression: string
  frameId?: number
  context?: 'watch' | 'repl' | 'hover' | 'clipboard' | 'variables'
  format?: Record<string, unknown>
}

/** Response body for an `evaluate` request. */
export interface DapEvaluateResponse {
  result: string
  type?: string
  presentationHint?: {
    kind?: string
    attributes?: string[]
    visibility?: string
    lazy?: boolean
  }
  variablesReference: number
  namedVariables?: number
  indexedVariables?: number
  memoryReference?: string
}

/** A thread. */
export interface DapThread {
  id: number
  name: string
}

/** Response body for a `threads` request. */
export interface DapThreadsResponse {
  threads: DapThread[]
}

/** Body of the `output` event. */
export interface DapOutputEventBody {
  /** DAP output category (`console` | `important` | `stdout` | `stderr` | `telemetry`, or adapter-specific). */
  category?: string
  output: string
  group?: 'start' | 'startCollapsed' | 'end'
  variablesReference?: number
  source?: DapSource
  line?: number
  column?: number
  data?: unknown
}

/** Body of the `stopped` event. */
export interface DapStoppedEventBody {
  reason: string
  description?: string
  threadId?: number
  preserveFocusHint?: boolean
  text?: string
  allThreadsStopped?: boolean
  hitBreakpointIds?: number[]
}

/** Body of the `continued` event. */
export interface DapContinuedEventBody {
  threadId: number
  allThreadsContinued?: boolean
}

/** Body of the `exited` event. */
export interface DapExitedEventBody {
  exitCode?: number
}

/** Body of the `terminated` event. */
export interface DapTerminatedEventBody {
  restart?: boolean | Record<string, unknown>
}

/** Body of the `initialized` event (always empty). */
export interface DapInitializedEventBody {}

/** Arguments for the `runInTerminal` reverse request. */
export interface DapRunInTerminalArguments {
  kind?: 'integrated' | 'external'
  title?: string
  cwd?: string
  args: string[]
  env?: Record<string, string | null>
}

/** Response body for a `runInTerminal` reverse request. */
export interface DapRunInTerminalResponse {
  processId?: number
  shellProcessId?: number
}

/** Arguments for a `startDebugging` request. */
export interface DapStartDebuggingArguments {
  request: 'launch' | 'attach'
  configuration: Record<string, unknown>
}

/** Correlation entry for one in-flight request. */
export interface DapPendingRequest {
  resolve: (body: unknown) => void
  reject: (error: Error) => void
  command: string
}

/** Adapter configuration: how to launch one DAP adapter executable. */
export interface DapAdapterConfig {
  command: string
  args?: string[]
  languages?: string[]
  fileTypes?: string[]
  rootMarkers?: string[]
  launchDefaults?: Record<string, unknown>
  attachDefaults?: Record<string, unknown>
  /** 'stdio' (default): DAP flows over stdin/stdout pipes. 'socket': the
   *  adapter opens a unix socket (Linux) or dials back into our TCP listener
   *  (macOS/others) — currently Delve. 'tcp': spawn a DAP server with
   *  `${port}` substituted in `args`, then connect to it (js-debug). */
  connectMode?: 'stdio' | 'socket' | 'tcp'
  /** When true, the adapter accepts a directory as the launch `program`
   *  (dlv treats it as a Go package path). When false/undefined, debug
   *  rejects directory programs upfront. */
  acceptsDirectoryProgram?: boolean
}

/** A fully resolved adapter: command, args, and selection metadata. */
export interface DapResolvedAdapter {
  name: string
  command: string
  args: string[]
  resolvedCommand: string
  languages: string[]
  fileTypes: string[]
  rootMarkers: string[]
  launchDefaults: Record<string, unknown>
  attachDefaults: Record<string, unknown>
  connectMode: 'stdio' | 'socket' | 'tcp'
  acceptsDirectoryProgram: boolean
}

/** Persisted state of one source breakpoint. */
export interface DapBreakpointRecord {
  id: number | undefined
  verified: boolean
  line: number
  condition: string | undefined
  message: string | undefined
}

/** Persisted state of one instruction breakpoint. */
export interface DapInstructionBreakpointRecord {
  id: number | undefined
  verified: boolean
  instructionReference: string
  offset: number | undefined
  condition: string | undefined
  hitCondition: string | undefined
  message: string | undefined
}

/** Persisted state of one data breakpoint. */
export interface DapDataBreakpointRecord {
  id: number | undefined
  verified: boolean
  dataId: string
  accessType: 'read' | 'write' | 'readWrite' | undefined
  condition: string | undefined
  hitCondition: string | undefined
  message: string | undefined
}

/** Persisted state of one function breakpoint. */
export interface DapFunctionBreakpointRecord {
  id: number | undefined
  verified: boolean
  name: string
  condition: string | undefined
  message: string | undefined
}

/** Current stop location of a session's focused thread. */
export interface DapStopLocation {
  threadId: number | undefined
  frameId: number | undefined
  reason: string | undefined
  description: string | undefined
  text: string | undefined
  frameName: string | undefined
  instructionPointerReference: string | undefined
  source: DapSource | undefined
  line: number | undefined
  column: number | undefined
}

/** Snapshot summary of a debug session's state. */
export interface DapSessionSummary {
  id: string
  adapter: string
  cwd: string
  program: string | undefined
  status: DapSessionStatus
  launchedAt: string
  lastUsedAt: string
  threadId: number | undefined
  frameId: number | undefined
  stopReason: string | undefined
  stopDescription: string | undefined
  frameName: string | undefined
  instructionPointerReference: string | undefined
  source: DapSource | undefined
  line: number | undefined
  column: number | undefined
  breakpointFiles: number
  breakpointCount: number
  functionBreakpointCount: number
  outputBytes: number
  outputTruncated: boolean
  exitCode: number | undefined
  needsConfigurationDone: boolean
  parentSessionId: string | undefined
  childSessionIds: string[] | undefined
}

/** Outcome of a `continue` call. */
export interface DapContinueOutcome {
  snapshot: DapSessionSummary
  state: 'running' | 'stopped' | 'terminated'
  timedOut: boolean
}

/** Options for launching a debug session. */
export interface DapLaunchSessionOptions {
  adapter: DapResolvedAdapter
  program: string
  args?: string[]
  cwd: string
  /** Per-launch overrides merged over `adapter.launchDefaults` — used to
   *  inject adapter-specific values that depend on the resolved program
   *  (e.g. dlv's `mode` switches between `debug`/`exec`). */
  extraLaunchArguments?: Record<string, unknown>
}

/** Options for attaching a debug session. */
export interface DapAttachSessionOptions {
  adapter: DapResolvedAdapter
  cwd: string
  pid?: number
  port?: number
  host?: string
}

/** Captured output of a debug session with its summary snapshot. */
export interface DapOutputSnapshot {
  snapshot: DapSessionSummary
  output: string
}
