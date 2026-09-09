/**
 * Model-facing `debug` tool over `ctx.dap`. One tool, 28 operations: launch/
 * attach, source/function/instruction/data breakpoints, continue/pause/step,
 * threads/stackTrace/scopes/variables/evaluate, disassembly, memory access,
 * modules, captured output, termination, and session listing. It resolves
 * paths against the session workspace, requires an active session for stateful
 * operations, converts request timeouts into abort signals, and renders every
 * result through `render.ts`. It runtime-injects `tools`, `dap`, and
 * `systemPrompt`, and imports no provider.
 *
 * Namespace plugin (named exports, no default export).
 * @module @hy-sde-org/dsh-tool-debug
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  DapCapabilities,
  DapEvaluateArguments,
  DapResolvedAdapter,
  DapSessionSummary,
} from '@hy-sde-org/dsh-dap'
import {
  formatBreakpoints,
  formatCustomResponse,
  formatDataBreakpointInfo,
  formatDataBreakpoints,
  formatDisassembly,
  formatEvaluation,
  formatFunctionBreakpoints,
  formatInstructionBreakpoints,
  formatLoadedSources,
  formatMemoryRead,
  formatModules,
  formatScopes,
  formatSessionSnapshot,
  formatSessions,
  formatStackFrames,
  formatThreads,
  formatVariables,
  makeDebugOutput,
  presentDebugCall,
  projectSession,
  DEBUG_OUTPUT_SCHEMA,
  DEBUG_ACTIONS,
} from './render.ts'
import { resolveToCwd, resolveCallCwd, sessionCwd } from './session.ts'
import { isDebugAction } from './types.ts'
import type { DebugToolArgs } from './types.ts'
import type { DebugOutputSession } from './render.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-debug'

/** Services required by this plugin. */
export const inject = ['tools', 'dap', 'systemPrompt']

/** Default per-request timeout (seconds) when the model omits `timeout`. */
export const DEFAULT_DEBUG_REQUEST_TIMEOUT_SEC = 30

/** Default whole-tool-call timeout budget (ms) for `dsh-tool-call-timeout-policy`. */
export const DEFAULT_DEBUG_TOOL_TIMEOUT_MS = 120_000

/** The stable system-prompt guidance positioning the debug tool. */
export const DEBUG_PROMPT_TEXT =
  'Use debug to attach a real debugger (gdb/lldb-dap/debugpy/dlv/...) to a process: launch or attach, set breakpoints, then continue/step, inspect threads/stack/scopes/variables, evaluate expressions, read memory, and terminate. Debug sessions are exclusive — terminate a session before launching another. Breakpoints must be set before continuing after a stop.'

/** Plugin configuration: result caps and timeout budgets. */
export interface Config {
  /** Largest complete rendered result in characters (default 16000). */
  maxResultChars?: number
  /** Default per-request timeout in seconds (default 30). */
  requestTimeoutSec?: number
  /** Whole-tool-call timeout budget in ms (default 120000). */
  timeoutMs?: number
}

const DEFAULT_MAX_RESULT_CHARS = 16_000

export const Config: z<Config> = z.object({
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  requestTimeoutSec: z.number().default(DEFAULT_DEBUG_REQUEST_TIMEOUT_SEC),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_DEBUG_TOOL_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

/**
 * Register the `debug` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `dap`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxResultChars', resolved.maxResultChars)
  assertPositiveInteger('requestTimeoutSec', resolved.requestTimeoutSec)
  assertTimer('timeoutMs', resolved.timeoutMs)

  ctx.systemPrompt.section({ name: 'tool:debug', order: 128, text: DEBUG_PROMPT_TEXT })

  ctx.tools.register(defineTool({
    name: 'debug',
    description:
      'Attach a real debugger to a running or launched process through the Debug Adapter Protocol (DAP). 28 operations: launch, attach, set/remove_breakpoint (source or function), set/remove_instruction_breakpoint, data_breakpoint_info, set/remove_data_breakpoint, continue, step_over, step_in, step_out, pause, evaluate, stack_trace, threads, scopes, variables, disassemble, read_memory, write_memory, modules, loaded_sources, custom_request, output, terminate, sessions. One active session at a time — terminate before launching another.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...DEBUG_ACTIONS],
        description: 'The debug operation to perform.',
      },
      program: { type: 'string', description: 'Debug target path; Delve accepts Go package directories.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Program arguments for launch.' },
      adapter: { type: 'string', description: 'Configured adapter id (gdb, lldb-dap, debugpy, dlv, ... or a dap.json entry).' },
      cwd: { type: 'string', description: 'Call working directory; defaults to the session workspace.' },
      file: { type: 'string', description: 'Source file (breakpoint operations).' },
      line: { type: 'number', description: 'Source line (breakpoint operations).' },
      function: { type: 'string', description: 'Function name (breakpoint operations).' },
      name: { type: 'string', description: 'Variable or data name (data_breakpoint_info).' },
      condition: { type: 'string', description: 'Breakpoint condition expression.' },
      hit_condition: { type: 'string', description: 'Breakpoint hit count condition.' },
      expression: { type: 'string', description: 'Expression to evaluate.' },
      context: { type: 'string', enum: ['watch', 'repl', 'hover', 'variables', 'clipboard'], description: 'Evaluate context (default repl).' },
      frame_id: { type: 'number', description: 'Stack frame id (scopes/evaluate).' },
      scope_id: { type: 'number', description: 'Scope variables reference (variables).' },
      variable_ref: { type: 'number', description: 'Variable reference (variables).' },
      pid: { type: 'number', description: 'Process id for attach.' },
      port: { type: 'number', description: 'Remote attach port.' },
      host: { type: 'string', description: 'Remote attach host (default localhost).' },
      levels: { type: 'number', description: 'Max stack frames for stack_trace.' },
      memory_reference: { type: 'string', description: 'Memory reference or address.' },
      instruction_reference: { type: 'string', description: 'Instruction reference for set_instruction_breakpoint.' },
      instruction_count: { type: 'number', description: 'Instructions to disassemble.' },
      instruction_offset: { type: 'number' },
      count: { type: 'number', description: 'Bytes to read for read_memory.' },
      data: { type: 'string', description: 'Base64 memory payload for write_memory.' },
      data_id: { type: 'string', description: 'Data breakpoint id.' },
      access_type: { type: 'string', enum: ['read', 'write', 'readWrite'], description: 'Data breakpoint access type.' },
      command: { type: 'string', description: 'Custom DAP request command.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Custom request arguments.' },
      offset: { type: 'number', description: 'Byte offset for memory operations.' },
      resolve_symbols: { type: 'boolean' },
      allow_partial: { type: 'boolean' },
      start_module: { type: 'number' },
      module_count: { type: 'number' },
      timeout: { type: 'number', description: 'Per-request timeout in seconds (default 30).' },
    },
    output: {
      schema: DEBUG_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const output = value as DebugToolOutputLike
        return [{ type: 'text', text: output.message ?? '(no output)' }]
      },
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const input = parseDebugArgs(args)
      const workspace = sessionCwd(exec)
      if (workspace === undefined) {
        throw new Error('the debug tool requires a session workspace cwd')
      }
      const requestTimeoutMs = (input.timeout ?? resolved.requestTimeoutSec) * 1000
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
      const combinedSignal = AbortSignal.any([exec.signal, timeoutSignal])

      const dap = ctx.dap
      return dispatchDebugAction(dap, input, workspace, combinedSignal, requestTimeoutMs, resolved.maxResultChars)
    },
    presentCall: presentDebugCall,
  }))
}

/** Narrow name for the render closure (the schema rejects extra fields at runtime anyway). */
type DebugToolOutputLike = { readonly message?: string }

/**
 * Validate and normalize raw model arguments into `DebugToolArgs`.
 * @param args - the raw model arguments.
 * @returns the normalized debug tool arguments.
 */
export function parseDebugArgs(args: unknown): DebugToolArgs {
  if (args === null || typeof args !== 'object') {
    throw new Error('debug arguments must be an object')
  }
  const raw = args as Record<string, unknown>
  if (!isDebugAction(raw.action)) {
    throw new Error(`action must be one of ${DEBUG_ACTIONS.join(', ')}`)
  }
  return { ...raw, action: raw.action }
}

/** Adapter-unavailable hints keyed by well-known adapter ids. */
const ADAPTER_UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
  debugpy: "adapter 'debugpy' is not available: install with 'pip install debugpy'",
  dlv: "adapter 'dlv' is not available: install with 'go install github.com/go-delve/delve/cmd/dlv@latest'",
  rdbg: "adapter 'rdbg' is not available: install with 'gem install debug'",
  'js-debug-adapter':
    "adapter 'js-debug-adapter' is not available: download it from https://github.com/microsoft/vscode-js-debug",
}

async function requireAdapter(adapter: DapResolvedAdapter | null, name: string | undefined, cwd: string, dap: Context['dap']): Promise<DapResolvedAdapter> {
  if (adapter !== null) return adapter
  const available = await dap.listAdapters(cwd)
  const names = available.length > 0 ? available.join(', ') : 'none'
  if (name) {
    const hint = ADAPTER_UNAVAILABLE_MESSAGES[name]
    throw new Error(
      hint ?? `adapter '${name}' is not available. Installed adapters: ${names}`,
    )
  }
  throw new Error(`No debugger adapter available. Installed adapters: ${names}`)
}

function requireSession(dap: Context['dap']): DapSessionSummary {
  const snapshot = dap.getActiveSession()
  if (!snapshot) {
    throw new Error('No active debug session. Launch or attach first.')
  }
  return snapshot
}

function requireCapability(dap: Context['dap'], capability: keyof DapCapabilities, description: string): void {
  requireSession(dap)
  if (dap.getCapabilities()?.[capability] !== true) {
    throw new Error(`Current adapter does not support ${description}`)
  }
}

function resolveDisassemblyReference(dap: Context['dap'], memoryReference: string | undefined): string {
  if (memoryReference) return memoryReference
  const snapshot = requireSession(dap)
  if (snapshot.instructionPointerReference) {
    return snapshot.instructionPointerReference
  }
  throw new Error(
    'disassemble requires memory_reference unless the current stop location has an instruction pointer reference',
  )
}

/** Validate breakpoint references used by instruction/data breakpoint ops. */
function requireBreakpointInput(kind: 'instruction' | 'data-id', input: DebugToolArgs): string {
  if (kind === 'instruction') {
    const reference = input.instruction_reference
    if (!reference) {
      throw new Error('instruction_reference is required for instruction breakpoint operations')
    }
    return reference
  }
  const dataId = input.data_id
  if (!dataId) {
    throw new Error('data_id is required for data breakpoint operations')
  }
  return dataId
}


/** Project a session summary into the canonical plain session record. */
function acc(snapshot: DapSessionSummary): { session: DebugOutputSession } {
  return { session: projectSession(snapshot) }
}

async function dispatchDebugAction(
  dap: Context['dap'],
  input: DebugToolArgs,
  workspace: string,
  signal: AbortSignal,
  requestTimeoutMs: number,
  maxResultChars: number,
) {
  switch (input.action) {
    case 'launch': {
      if (!input.program) throw new Error('program is required for launch')
      const cwd = resolveCallCwd(input, workspace)
      const program = resolveToCwd(input.program, cwd)
      const programKind = await dap.classifyProgram(program, cwd)
      const selection = await dap.selectLaunchAdapter(program, cwd, {
        ...(input.adapter ? { adapter: input.adapter } : {}),
        programKind,
        signal,
      })
      if (selection.kind === 'unavailable') {
        const hint = ADAPTER_UNAVAILABLE_MESSAGES[selection.adapterName]
        throw new Error(
          hint ??
            `adapter '${selection.adapterName}' is not available: configured command '${selection.command}' did not resolve. Check the DAP adapter config for this workspace.`,
        )
      }
      if (selection.kind === 'none') {
        const available = await dap.listAdapters(cwd)
        throw new Error(
          `No debugger adapter available. Installed adapters: ${available.length > 0 ? available.join(', ') : 'none'}`,
        )
      }
      const { adapter } = selection
      if (programKind === 'directory' && !adapter.acceptsDirectoryProgram) {
        throw new Error(
          `launch program resolves to a directory: ${program}. Pass an executable file path or choose an adapter that supports package directories.`,
        )
      }
      const extraLaunchArguments = dap.resolveLaunchOverrides(adapter, program, programKind)
      const snapshot = await dap.launch(
        { adapter, program, ...(input.args ? { args: input.args } : {}), cwd, extraLaunchArguments },
        signal,
        requestTimeoutMs,
      )
      const text = formatSessionSnapshot(snapshot).join('\n')
      return makeDebugOutput('launch', text, acc(snapshot), maxResultChars)
    }
    case 'attach': {
      if (input.pid === undefined && input.port === undefined) {
        throw new Error('attach requires pid or port')
      }
      const cwd = resolveCallCwd(input, workspace)
      const adapter = await requireAdapter(
        await dap.selectAttachAdapter(cwd, {
          ...(input.adapter ? { adapter: input.adapter } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          signal,
        }),
        input.adapter,
        cwd,
        dap,
      )
      const snapshot = await dap.attach(
        {
          adapter,
          cwd,
          ...(input.pid !== undefined ? { pid: input.pid } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.host ? { host: input.host } : {}),
        },
        signal,
        requestTimeoutMs,
      )
      const text = formatSessionSnapshot(snapshot).join('\n')
      return makeDebugOutput('attach', text, acc(snapshot), maxResultChars)
    }
    case 'set_breakpoint': {
      if (input.function) {
        const response = await dap.setFunctionBreakpoint(input.function, input.condition, signal, requestTimeoutMs)
        const text = formatFunctionBreakpoints(response.breakpoints)
        return makeDebugOutput('set_breakpoint', text, acc(response.snapshot), maxResultChars)
      }
      if (!input.file || input.line === undefined) {
        throw new Error('set_breakpoint requires file+line or function')
      }
      const file = resolveToCwd(input.file, workspace)
      const response = await dap.setBreakpoint(file, input.line, input.condition, signal, requestTimeoutMs)
      const text = formatBreakpoints(file, response.breakpoints)
      return makeDebugOutput('set_breakpoint', text, acc(response.snapshot), maxResultChars)
    }
    case 'remove_breakpoint': {
      if (input.function) {
        const response = await dap.removeFunctionBreakpoint(input.function, signal, requestTimeoutMs)
        const text = formatFunctionBreakpoints(response.breakpoints)
        return makeDebugOutput('remove_breakpoint', text, acc(response.snapshot), maxResultChars)
      }
      if (!input.file || input.line === undefined) {
        throw new Error('remove_breakpoint requires file+line or function')
      }
      const file = resolveToCwd(input.file, workspace)
      const response = await dap.removeBreakpoint(file, input.line, signal, requestTimeoutMs)
      const text = formatBreakpoints(file, response.breakpoints)
      return makeDebugOutput('remove_breakpoint', text, acc(response.snapshot), maxResultChars)
    }
    case 'set_instruction_breakpoint': {
      requireCapability(dap, 'supportsInstructionBreakpoints', 'instruction breakpoints')
      const instructionReference = requireBreakpointInput('instruction', input)
      const response = await dap.setInstructionBreakpoint(
        instructionReference,
        input.offset,
        input.condition,
        input.hit_condition,
        signal,
        requestTimeoutMs,
      )
      const text = formatInstructionBreakpoints(response.breakpoints)
      return makeDebugOutput('set_instruction_breakpoint', text, acc(response.snapshot), maxResultChars)
    }
    case 'remove_instruction_breakpoint': {
      requireCapability(dap, 'supportsInstructionBreakpoints', 'instruction breakpoints')
      const instructionReference = requireBreakpointInput('instruction', input)
      const response = await dap.removeInstructionBreakpoint(
        instructionReference,
        input.offset,
        signal,
        requestTimeoutMs,
      )
      const text = formatInstructionBreakpoints(response.breakpoints)
      return makeDebugOutput('remove_instruction_breakpoint', text, acc(response.snapshot), maxResultChars)
    }
    case 'data_breakpoint_info': {
      requireCapability(dap, 'supportsDataBreakpoints', 'data breakpoints')
      if (!input.name) throw new Error('name is required for data_breakpoint_info')
      const response = await dap.dataBreakpointInfo(
        input.name,
        input.variable_ref ?? input.scope_id,
        input.frame_id,
        signal,
        requestTimeoutMs,
      )
      const text = formatDataBreakpointInfo(response.info)
      return makeDebugOutput('data_breakpoint_info', text, acc(response.snapshot), maxResultChars)
    }
    case 'set_data_breakpoint': {
      requireCapability(dap, 'supportsDataBreakpoints', 'data breakpoints')
      const dataId = requireBreakpointInput('data-id', input)
      const response = await dap.setDataBreakpoint(
        dataId,
        input.access_type,
        input.condition,
        input.hit_condition,
        signal,
        requestTimeoutMs,
      )
      const text = formatDataBreakpoints(response.breakpoints)
      return makeDebugOutput('set_data_breakpoint', text, acc(response.snapshot), maxResultChars)
    }
    case 'remove_data_breakpoint': {
      requireCapability(dap, 'supportsDataBreakpoints', 'data breakpoints')
      const dataId = requireBreakpointInput('data-id', input)
      const response = await dap.removeDataBreakpoint(dataId, signal, requestTimeoutMs)
      const text = formatDataBreakpoints(response.breakpoints)
      return makeDebugOutput('remove_data_breakpoint', text, acc(response.snapshot), maxResultChars)
    }
    case 'continue':
    case 'step_over':
    case 'step_in':
    case 'step_out': {
      // Call through the service object (never a detached reference, which
      // would lose `this` on the prototype-backed delegating service).
      const outcome =
        input.action === 'continue'
          ? await dap.continue(signal, requestTimeoutMs)
          : input.action === 'step_over'
            ? await dap.stepOver(signal, requestTimeoutMs)
            : input.action === 'step_in'
              ? await dap.stepIn(signal, requestTimeoutMs)
              : await dap.stepOut(signal, requestTimeoutMs)
      const verb =
        input.action === 'continue'
          ? 'Continue'
          : input.action === 'step_over'
            ? 'Step over'
            : input.action === 'step_in'
              ? 'Step in'
              : 'Step out'
      const lines = formatSessionSnapshot(outcome.snapshot)
      if (outcome.timedOut) {
        lines.push(
          `Program is still running after ${Math.round(requestTimeoutMs / 1000)}s. Use pause to interrupt and inspect state.`,
        )
      } else if (outcome.state === 'stopped') {
        const location =
          outcome.snapshot.source?.path && outcome.snapshot.line !== undefined
            ? `${outcome.snapshot.source.path}:${outcome.snapshot.line}`
            : 'unknown location'
        lines.push(`${verb} stopped at ${location}.`)
      } else if (outcome.state === 'terminated') {
        lines.push(
          `Program terminated${outcome.snapshot.exitCode !== undefined ? ` with exit code ${outcome.snapshot.exitCode}` : ''}.`,
        )
      } else {
        lines.push('Program is running.')
      }
      const text = lines.join('\n')
      return makeDebugOutput(
        input.action,
        text,
        { ...acc(outcome.snapshot), state: outcome.state, timedOut: outcome.timedOut },
        maxResultChars,
      )
    }
    case 'pause': {
      const snapshot = await dap.pause(signal, requestTimeoutMs)
      const text = [...formatSessionSnapshot(snapshot), 'Program paused.'].join('\n')
      return makeDebugOutput('pause', text, acc(snapshot), maxResultChars)
    }
    case 'evaluate': {
      if (!input.expression) throw new Error('expression is required for evaluate')
      const evaluationContext: DapEvaluateArguments['context'] =
        (input.context as DapEvaluateArguments['context']) ?? 'repl'
      const response = await dap.evaluate(input.expression, evaluationContext, input.frame_id, signal, requestTimeoutMs)
      const text = formatEvaluation(response.evaluation ?? { result: '', variablesReference: 0 })
      return makeDebugOutput('evaluate', text, acc(response.snapshot), maxResultChars)
    }
    case 'stack_trace': {
      const response = await dap.stackTrace(input.levels, signal, requestTimeoutMs)
      const text = formatStackFrames(response.stackFrames)
      return makeDebugOutput('stack_trace', text, acc(response.snapshot), maxResultChars)
    }
    case 'threads': {
      const response = await dap.threads(signal, requestTimeoutMs)
      const text = formatThreads(response.threads)
      return makeDebugOutput('threads', text, acc(response.snapshot), maxResultChars)
    }
    case 'scopes': {
      const response = await dap.scopes(input.frame_id, signal, requestTimeoutMs)
      const text = formatScopes(response.scopes)
      return makeDebugOutput('scopes', text, acc(response.snapshot), maxResultChars)
    }
    case 'variables': {
      const variableReference = input.variable_ref ?? input.scope_id
      if (variableReference === undefined) {
        throw new Error('variables requires variable_ref or scope_id')
      }
      const response = await dap.variables(variableReference, signal, requestTimeoutMs)
      const text = formatVariables(response.variables)
      return makeDebugOutput('variables', text, acc(response.snapshot), maxResultChars)
    }
    case 'disassemble': {
      requireCapability(dap, 'supportsDisassembleRequest', 'disassembly')
      if (input.instruction_count === undefined) throw new Error('instruction_count is required for disassemble')
      const response = await dap.disassemble(
        resolveDisassemblyReference(dap, input.memory_reference),
        input.instruction_count,
        input.offset,
        input.instruction_offset,
        input.resolve_symbols,
        signal,
        requestTimeoutMs,
      )
      const text = formatDisassembly(response.instructions)
      return makeDebugOutput('disassemble', text, acc(response.snapshot), maxResultChars)
    }
    case 'read_memory': {
      requireCapability(dap, 'supportsReadMemoryRequest', 'memory reads')
      if (!input.memory_reference) throw new Error('memory_reference is required for read_memory')
      if (input.count === undefined) throw new Error('count is required for read_memory')
      const response = await dap.readMemory(input.memory_reference, input.count, input.offset, signal, requestTimeoutMs)
      const text = formatMemoryRead(response.address, response.data, response.unreadableBytes)
      return makeDebugOutput('read_memory', text, acc(response.snapshot), maxResultChars)
    }
    case 'write_memory': {
      requireCapability(dap, 'supportsWriteMemoryRequest', 'memory writes')
      if (!input.memory_reference) throw new Error('memory_reference is required for write_memory')
      if (!input.data) throw new Error('data is required for write_memory')
      const response = await dap.writeMemory(
        input.memory_reference,
        input.data,
        input.offset,
        input.allow_partial,
        signal,
        requestTimeoutMs,
      )
      const text = [
        'Memory write completed.',
        ...(response.bytesWritten !== undefined ? [`Bytes written: ${response.bytesWritten}`] : []),
        ...(response.offset !== undefined ? [`Offset: ${response.offset}`] : []),
      ].join('\n')
      return makeDebugOutput('write_memory', text, acc(response.snapshot), maxResultChars)
    }
    case 'modules': {
      requireCapability(dap, 'supportsModulesRequest', 'module introspection')
      const response = await dap.modules(input.start_module, input.module_count, signal, requestTimeoutMs)
      const text = formatModules(response.modules)
      return makeDebugOutput('modules', text, acc(response.snapshot), maxResultChars)
    }
    case 'loaded_sources': {
      requireCapability(dap, 'supportsLoadedSourcesRequest', 'loaded sources')
      const response = await dap.loadedSources(signal, requestTimeoutMs)
      const text = formatLoadedSources(response.sources)
      return makeDebugOutput('loaded_sources', text, acc(response.snapshot), maxResultChars)
    }
    case 'custom_request': {
      if (!input.command) throw new Error('command is required for custom_request')
      const response = await dap.customRequest(input.command, input.arguments, signal, requestTimeoutMs)
      const text = formatCustomResponse(input.command, response.body)
      return makeDebugOutput('custom_request', text, acc(response.snapshot), maxResultChars)
    }
    case 'output': {
      const response = dap.getOutput()
      const text = response.output.length > 0 ? response.output : '(no output captured)'
      return makeDebugOutput('output', text, { ...acc(response.snapshot), output: response.output }, maxResultChars)
    }
    case 'terminate': {
      const snapshot = await dap.terminate(signal, requestTimeoutMs)
      if (!snapshot) {
        return makeDebugOutput('terminate', 'No debug session to terminate.', {}, maxResultChars)
      }
      const text = [...formatSessionSnapshot(snapshot), 'Debug session terminated.'].join('\n')
      return makeDebugOutput('terminate', text, acc(snapshot), maxResultChars)
    }
    case 'sessions': {
      const sessions = dap.listSessions()
      const text = formatSessions(sessions)
      return makeDebugOutput('sessions', text, { sessions: sessions.map(projectSession) }, maxResultChars)
    }
    default: {
      // exhaustive over the union; unreachable after parseDebugArgs validation
      throw new Error(`Unsupported debug action: ${String(input.action)}`)
    }
  }
}
/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-debug: ${name} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-debug: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

// Internal helper kept exported for tests and derived packages.
export { ADAPTER_UNAVAILABLE_MESSAGES }
export type { DebugToolArgs } from './types.ts'
export {
  DEBUG_ACTIONS,
  DEBUG_OUTPUT_SCHEMA,
  formatBreakpoints,
  formatCustomResponse,
  formatDataBreakpointInfo,
  formatDataBreakpoints,
  formatDisassembly,
  formatEvaluation,
  formatFunctionBreakpoints,
  formatInstructionBreakpoints,
  formatLoadedSources,
  formatMemoryRead,
  formatModules,
  formatScopes,
  formatSessionSnapshot,
  formatSessions,
  formatStackFrames,
  formatThreads,
  formatVariables,
  makeDebugOutput,
  presentDebugCall,
  summarizeDebugCall,
} from './render.ts'
export type { GenericCallView } from '@deepseek-ai/dsh-tools'
