/**
 * Result formatting for the `debug` tool: one closed JSON output shape, the
 * schema that declares it, and pure formatters that project it into
 * model-facing text. All formatters are bounded by `maxResultChars`.
 * Formatting ported from oh-my-pi's `tools/debug.ts` (MIT) and adapted to the
 * DSH tool-output contract.
 * @module @hy-sde-org/dsh-tool-debug/render
 */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {
  DapBreakpointRecord,
  DapDataBreakpointInfoResponse,
  DapDataBreakpointRecord,
  DapDisassembledInstruction,
  DapEvaluateResponse,
  DapFunctionBreakpointRecord,
  DapInstructionBreakpointRecord,
  DapModule,
  DapScope,
  DapSessionSummary,
  DapSource,
  DapStackFrame,
  DapThread,
  DapVariable,
} from '@hy-sde-org/dsh-dap'
import type { DebugToolAction, DebugToolArgs } from './types.ts'

export { DEBUG_ACTIONS, isDebugAction, DEBUG_READONLY_ACTIONS } from './types.ts'
export type { DebugToolAction, DebugToolArgs } from './types.ts'

/** Cap on the total length of any rendered result. */
export const DEFAULT_MAX_RESULT_CHARS = 16_000

/** One canonical session record projected into the tool output value. */
export interface DebugOutputSession {
  id?: string
  adapter?: string
  cwd?: string
  program?: string
  status?: string
  stopReason?: string
  frameName?: string
  line?: number
  sourcePath?: string
  instructionPointerReference?: string
  needsConfigurationDone?: boolean
  exitCode?: number
}

/**
 * Project a DAP session summary into the canonical plain record.
 * @param snapshot - the DAP session summary.
 * @returns the projected plain session record.
 */
export function projectSession(snapshot: DapSessionSummary): DebugOutputSession {
  const record: DebugOutputSession = {}
  record.id = snapshot.id
  record.adapter = snapshot.adapter
  record.cwd = snapshot.cwd
  if (snapshot.program !== undefined) record.program = snapshot.program
  record.status = snapshot.status
  if (snapshot.stopReason !== undefined) record.stopReason = snapshot.stopReason
  if (snapshot.frameName !== undefined) record.frameName = snapshot.frameName
  if (snapshot.line !== undefined) record.line = snapshot.line
  if (snapshot.source?.path !== undefined) record.sourcePath = snapshot.source.path
  if (snapshot.instructionPointerReference !== undefined) {
    record.instructionPointerReference = snapshot.instructionPointerReference
  }
  record.needsConfigurationDone = snapshot.needsConfigurationDone
  if (snapshot.exitCode !== undefined) record.exitCode = snapshot.exitCode
  return record
}

/** The closed, lossless-JSON result one `debug` call produces. */
export interface DebugToolOutput {
  readonly action: DebugToolAction
  readonly success: boolean
  /** Rendered (possibly truncated) human-readable result. */
  readonly message: string
  readonly session?: DebugOutputSession
  readonly sessions?: DebugOutputSession[]
  readonly state?: string
  readonly timedOut?: boolean
  readonly output?: string
}

/** Bounded text: truncate long renderings to `maxResultChars` with a note. */
function truncate(text: string, maxResultChars: number): string {
  if (text.length <= maxResultChars) return text
  return `${text.slice(0, maxResultChars)}\n… (truncated)`
}

/**
 * Format the primary stop location of a session snapshot.
 * @param snapshot - the session snapshot.
 * @returns a `path:line:column` string, or null when the location is unknown.
 */
export function formatLocation(snapshot: DapSessionSummary | undefined): string | null {
  if (!snapshot?.source?.path || snapshot.line === undefined) {
    return null
  }
  return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ''}`
}

/**
 * Format one session snapshot into human-readable lines.
 * @param snapshot - the session snapshot.
 * @returns the rendered lines.
 */
export function formatSessionSnapshot(snapshot: DapSessionSummary): string[] {
  const lines = [
    `Session ${snapshot.id}`,
    `Adapter: ${snapshot.adapter}`,
    `Status: ${snapshot.status}`,
    `CWD: ${snapshot.cwd}`,
  ]
  if (snapshot.program) lines.push(`Program: ${snapshot.program}`)
  if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`)
  if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`)
  if (snapshot.instructionPointerReference) {
    lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`)
  }
  const location = formatLocation(snapshot)
  if (location) lines.push(`Location: ${location}`)
  if (snapshot.needsConfigurationDone) {
    lines.push('Configuration: pending configurationDone; set breakpoints, then continue.')
  }
  if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`)
  return lines
}

/**
 * Format source breakpoints registered for a file.
 * @param filePath - the source file path.
 * @param breakpoints - the source breakpoint records.
 * @returns the rendered breakpoint text.
 */
export function formatBreakpoints(filePath: string, breakpoints: DapBreakpointRecord[]): string {
  const lines = [`Breakpoints for ${filePath}:`]
  if (breakpoints.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const breakpoint of breakpoints) {
    lines.push(
      `- line ${breakpoint.line}: ${breakpoint.verified ? 'verified' : 'pending'}${breakpoint.condition ? ` if ${breakpoint.condition}` : ''}${breakpoint.message ? ` (${breakpoint.message})` : ''}`,
    )
  }
  return lines.join('\n')
}

/**
 * Format function breakpoints registered for the session.
 * @param breakpoints - the function breakpoint records.
 * @returns the rendered breakpoint text.
 */
export function formatFunctionBreakpoints(breakpoints: DapFunctionBreakpointRecord[]): string {
  const lines = ['Function breakpoints:']
  if (breakpoints.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const breakpoint of breakpoints) {
    lines.push(
      `- ${breakpoint.name}: ${breakpoint.verified ? 'verified' : 'pending'}${breakpoint.condition ? ` if ${breakpoint.condition}` : ''}${breakpoint.message ? ` (${breakpoint.message})` : ''}`,
    )
  }
  return lines.join('\n')
}

/**
 * Format the current stack frames.
 * @param frames - the stack frames.
 * @returns the rendered stack trace text.
 */
export function formatStackFrames(frames: DapStackFrame[]): string {
  const lines = ['Stack trace:']
  if (frames.length === 0) {
    lines.push('(empty)')
    return lines.join('\n')
  }
  for (const frame of frames) {
    const location = frame.source?.path
      ? `${frame.source.path}:${frame.line}:${frame.column}`
      : `<unknown>:${frame.line}:${frame.column}`
    lines.push(`- #${frame.id} ${frame.name} @ ${location}`)
  }
  return lines.join('\n')
}

/**
 * Format the debuggee's threads.
 * @param threads - the DAP threads.
 * @returns the rendered thread list text.
 */
export function formatThreads(threads: DapThread[]): string {
  const lines = ['Threads:']
  if (threads.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const thread of threads) {
    lines.push(`- ${thread.id}: ${thread.name}`)
  }
  return lines.join('\n')
}

/**
 * Format the scopes of a stack frame.
 * @param scopes - the DAP scopes.
 * @returns the rendered scope list text.
 */
export function formatScopes(scopes: DapScope[]): string {
  const lines = ['Scopes:']
  if (scopes.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const scope of scopes) {
    lines.push(
      `- ${scope.name}: ref=${scope.variablesReference}, expensive=${scope.expensive ? 'yes' : 'no'}${scope.presentationHint ? `, hint=${scope.presentationHint}` : ''}`,
    )
  }
  return lines.join('\n')
}

/**
 * Format the variables of a variable reference.
 * @param variables - the DAP variables.
 * @returns the rendered variable list text.
 */
export function formatVariables(variables: DapVariable[]): string {
  const lines = ['Variables:']
  if (variables.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const variable of variables) {
    lines.push(
      `- ${variable.name} = ${variable.value}${variable.type ? ` (${variable.type})` : ''}${variable.variablesReference > 0 ? ` [ref=${variable.variablesReference}]` : ''}`,
    )
  }
  return lines.join('\n')
}

/**
 * Format a source label, optionally with line and column.
 * @param source - the DAP source, or undefined.
 * @param line - optional source line.
 * @param column - optional source column.
 * @returns the formatted `base:line:column` label, or null when unknown.
 */
export function formatSourceLabel(source: DapSource | undefined, line?: number, column?: number): string | null {
  if (!source?.path && !source?.name) {
    return null
  }
  const base = source.path ?? source.name ?? '<unknown>'
  if (line === undefined) {
    return base
  }
  return `${base}:${line}${column !== undefined ? `:${column}` : ''}`
}

/**
 * Format disassembled instructions.
 * @param instructions - the disassembled instructions.
 * @returns the rendered disassembly text.
 */
export function formatDisassembly(instructions: DapDisassembledInstruction[]): string {
  const lines = ['Disassembly:']
  if (instructions.length === 0) {
    lines.push('(empty)')
    return lines.join('\n')
  }
  const addressWidth = Math.max(...instructions.map(instruction => instruction.address.length))
  const bytesWidth = Math.max(...instructions.map(instruction => instruction.instructionBytes?.length ?? 0), 2)
  for (const instruction of instructions) {
    const location = formatSourceLabel(instruction.location, instruction.line, instruction.column)
    const parts = [
      instruction.address.padEnd(addressWidth),
      (instruction.instructionBytes ?? '').padEnd(bytesWidth),
      instruction.instruction,
    ]
    if (instruction.symbol) {
      parts.push(`<${instruction.symbol}>`)
    }
    if (location) {
      parts.push(`[${location}]`)
    }
    lines.push(
      parts
        .filter(part => part.length > 0)
        .join('  ')
        .trimEnd(),
    )
  }
  return lines.join('\n')
}

/**
 * Format a memory read result as a hex/ascii dump.
 * @param address - the memory address read.
 * @param data - the base64-encoded buffer string, or undefined.
 * @param unreadableBytes - optional count of unreadable bytes.
 * @returns the rendered memory dump text.
 */
export function formatMemoryRead(address: string, data: string | undefined, unreadableBytes?: number): string {
  const lines = [`Memory at ${address}:`]
  const buffer = data ? Buffer.from(data, 'base64') : Buffer.alloc(0)
  if (buffer.length === 0) {
    lines.push('(no readable bytes)')
  } else {
    for (let offset = 0; offset < buffer.length; offset += 16) {
      const chunk = buffer.subarray(offset, offset + 16)
      const hex = Array.from(chunk, byte => byte.toString(16).padStart(2, '0')).join(' ')
      const ascii = Array.from(chunk, byte => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('')
      lines.push(
        `${(offset === 0 ? address : `+0x${offset.toString(16)}`).padEnd(18)} ${hex.padEnd(47)} |${ascii}|`,
      )
    }
  }
  if (unreadableBytes !== undefined && unreadableBytes > 0) {
    lines.push(`Unreadable bytes: ${unreadableBytes}`)
  }
  return lines.join('\n')
}

/**
 * Render a simple aligned text table.
 * @param headers - the column headers.
 * @param rows - the table rows.
 * @returns the rendered table text.
 */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => (row[index] ?? '').length)),
  )
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ')
  return [formatRow(headers), formatRow(widths.map(width => '-'.repeat(width))), ...rows.map(formatRow)].join('\n')
}

/**
 * Format loaded modules of the debuggee as a table.
 * @param modules - the DAP modules.
 * @returns the rendered module table text.
 */
export function formatModules(modules: DapModule[]): string {
  if (modules.length === 0) {
    return 'Modules:\n(none)'
  }
  return [
    'Modules:',
    formatTable(
      ['ID', 'Name', 'Path', 'Symbols', 'Range'],
      modules.map(module => [
        String(module.id),
        module.name,
        module.path ?? '',
        module.symbolStatus ?? '',
        module.addressRange ?? '',
      ]),
    ),
  ].join('\n')
}

/**
 * Format source files loaded by the debuggee.
 * @param sources - the DAP sources.
 * @returns the rendered loaded-sources text.
 */
export function formatLoadedSources(sources: DapSource[]): string {
  const lines = ['Loaded sources:']
  if (sources.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const source of sources) {
    const label = source.path ?? source.name ?? '<unknown>'
    lines.push(`- ${label}${source.sourceReference !== undefined ? ` [ref=${source.sourceReference}]` : ''}`)
  }
  return lines.join('\n')
}

/**
 * Format instruction breakpoints.
 * @param breakpoints - the instruction breakpoint records.
 * @returns the rendered breakpoint text.
 */
export function formatInstructionBreakpoints(breakpoints: DapInstructionBreakpointRecord[]): string {
  const lines = ['Instruction breakpoints:']
  if (breakpoints.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const breakpoint of breakpoints) {
    const location = `${breakpoint.instructionReference}${breakpoint.offset !== undefined ? `+${breakpoint.offset}` : ''}`
    lines.push(
      `- ${location}: ${breakpoint.verified ? 'verified' : 'pending'}${breakpoint.condition ? ` if ${breakpoint.condition}` : ''}${breakpoint.hitCondition ? ` after ${breakpoint.hitCondition}` : ''}${breakpoint.message ? ` (${breakpoint.message})` : ''}`,
    )
  }
  return lines.join('\n')
}

/**
 * Format data-breakpoint availability info.
 * @param info - the data-breakpoint info response.
 * @returns the rendered info text.
 */
export function formatDataBreakpointInfo(info: DapDataBreakpointInfoResponse): string {
  const lines = [`Data breakpoint info: ${info.description}`]
  lines.push(`Data ID: ${info.dataId ?? '(not available)'}`)
  if (info.accessTypes && info.accessTypes.length > 0) {
    lines.push(`Access types: ${info.accessTypes.join(', ')}`)
  }
  if (info.canPersist !== undefined) {
    lines.push(`Persistent: ${info.canPersist ? 'yes' : 'no'}`)
  }
  return lines.join('\n')
}

/**
 * Format data breakpoints.
 * @param breakpoints - the data breakpoint records.
 * @returns the rendered breakpoint text.
 */
export function formatDataBreakpoints(breakpoints: DapDataBreakpointRecord[]): string {
  const lines = ['Data breakpoints:']
  if (breakpoints.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const breakpoint of breakpoints) {
    lines.push(
      `- ${breakpoint.dataId}: ${breakpoint.verified ? 'verified' : 'pending'}${breakpoint.accessType ? ` (${breakpoint.accessType})` : ''}${breakpoint.condition ? ` if ${breakpoint.condition}` : ''}${breakpoint.hitCondition ? ` after ${breakpoint.hitCondition}` : ''}${breakpoint.message ? ` (${breakpoint.message})` : ''}`,
    )
  }
  return lines.join('\n')
}

/** JSON.stringify is typed as returning string but returns undefined for
 *  undefined/function/symbol inputs; keep the 'null' fallback explicit. */
function stringifyForDisplay(value: unknown): string | undefined {
  return JSON.stringify(value, null, 2)
}

/**
 * Format a custom DAP request response.
 * @param command - the custom request command name.
 * @param body - the response body.
 * @returns the rendered serialized response text.
 */
export function formatCustomResponse(command: string, body: unknown): string {
  let serialized = ''
  try {
    serialized = stringifyForDisplay(body) ?? 'null'
  } catch {
    serialized = String(body)
  }
  return `${command} response:\n${serialized}`
}

/**
 * Format all sessions under the manager.
 * @param sessions - the session summaries.
 * @returns the rendered session list text.
 */
export function formatSessions(sessions: DapSessionSummary[]): string {
  if (sessions.length === 0) {
    return 'No debug sessions.'
  }
  return sessions
    .map((session) => {
      const location = formatLocation(session)
      return [
        `${session.id}: ${session.status}`,
        `  adapter=${session.adapter}`,
        `  cwd=${session.cwd}`,
        ...(session.program ? [`  program=${session.program}`] : []),
        ...(location ? [`  location=${location}`] : []),
        ...(session.stopReason ? [`  reason=${session.stopReason}`] : []),
      ].join('\n')
    })
    .join('\n\n')
}

/**
 * Format an evaluation result.
 * @param evaluation - the picked evaluation fields.
 * @returns the rendered evaluation text.
 */
export function formatEvaluation(evaluation: Pick<DapEvaluateResponse, 'result' | 'type' | 'variablesReference'>): string {
  const lines = [`Result: ${evaluation.result}`]
  if (evaluation.type) lines.push(`Type: ${evaluation.type}`)
  if (evaluation.variablesReference > 0) {
    lines.push(`Variables ref: ${evaluation.variablesReference}`)
  }
  return lines.join('\n')
}

/** Canonical session-record property specs (all optional on purpose). */
const SESSION_PROPERTIES = {
  id: { type: 'string' },
  adapter: { type: 'string' },
  cwd: { type: 'string' },
  program: { type: 'string' },
  status: { type: 'string' },
  stopReason: { type: 'string' },
  frameName: { type: 'string' },
  line: { type: 'number' },
  sourcePath: { type: 'string' },
  instructionPointerReference: { type: 'string' },
  needsConfigurationDone: { type: 'boolean' },
  exitCode: { type: 'number' },
} as const

/** Schema declaring the closed `debug` tool output value shape. */
export const DEBUG_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true },
    success: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
    session: {
      type: 'object',
      additionalProperties: false,
      properties: SESSION_PROPERTIES,
    },
    sessions: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: SESSION_PROPERTIES },
    },
    state: { type: 'string' },
    timedOut: { type: 'boolean' },
    output: { type: 'string' },
  },
} as const

/**
 * Compose a message from the durable value; callers pre-set `message`.
 * @param _args - the debug tool arguments (unused).
 * @param value - the durable tool output value.
 * @returns the message text.
 */
export function renderDebugCall(_args: DebugToolArgs, value: DebugToolOutput): string {
  return value.message
}

/**
 * Deterministic one-line summary of a `debug` call for UIs.
 * @param args - the debug tool arguments.
 * @returns the one-line summary text.
 */
export function summarizeDebugCall(args: Partial<DebugToolArgs>): string {
  const action = args.action ? args.action.replaceAll('_', ' ') : 'request'
  if (args.program) return `${action} ${args.program}`
  if (args.file && args.line !== undefined) return `${action} ${args.file}:${args.line}`
  if (args.function) return `${action} ${args.function}`
  if (args.expression) return `${action} ${args.expression}`
  if (args.command) return `${action} ${args.command}`
  if (args.memory_reference) return `${action} ${args.memory_reference}`
  if (args.instruction_reference) return `${action} ${args.instruction_reference}`
  if (args.data_id) return `${action} ${args.data_id}`
  if (args.name) return `${action} ${args.name}`
  return action
}

/**
 * Pure, side-effect-free pending-call view for UIs (softly typed for replay).
 * @param args - the debug tool arguments.
 * @returns the generic pending-call view.
 */
export function presentDebugCall(args: Partial<DebugToolArgs>): GenericCallView {
  const action = args.action ?? 'request'
  return {
    card: 'generic',
    title: `debug ${action}`,
    kind: 'execute',
    rawInput: { action: args.action, program: args.program },
  }
}

/**
 * Project a rendered result into a {message} + detail value.
 * @param action - the debug action performed.
 * @param text - the rendered result text.
 * @param extra - additional fields to include in the output value.
 * @param maxResultChars - cap on the total rendered message length.
 * @returns the constructed tool output value.
 */
export function makeDebugOutput(
  action: DebugToolAction,
  text: string,
  extra: Omit<DebugToolOutput, 'action' | 'success' | 'message'>,
  maxResultChars: number,
): DebugToolOutput {
  return {
    action,
    success: true,
    message: truncate(text, maxResultChars),
    ...extra,
  }
}
