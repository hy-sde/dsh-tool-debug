import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  DapCapabilities,
  DapResolvedAdapter,
  DapSessionSummary,
  LaunchAdapterSelection,
} from '@hy-sde-org/dsh-dap'
import * as ToolDebug from '../src/index.ts'
import {
  DEBUG_ACTIONS,
  DEBUG_PROMPT_TEXT,
  DEFAULT_DEBUG_TOOL_TIMEOUT_MS,
  makeDebugOutput,
  parseDebugArgs,
  summarizeDebugCall,
} from '../src/index.ts'

const WORKSPACE = resolve('/virtual/debug-workspace')
const PROGRAM = resolve(WORKSPACE, 'prog.py')

function makeSnapshot(overrides: Partial<DapSessionSummary> = {}): DapSessionSummary {
  return {
    id: 's1',
    adapter: 'stub-node',
    cwd: WORKSPACE,
    program: PROGRAM,
    status: 'stopped',
    launchedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    threadId: 1,
    frameId: 1,
    stopReason: 'breakpoint',
    stopDescription: undefined,
    frameName: 'main',
    instructionPointerReference: '0x1000',
    source: { name: 'prog.py', path: PROGRAM },
    line: 7,
    column: 1,
    breakpointFiles: 1,
    breakpointCount: 1,
    functionBreakpointCount: 0,
    outputBytes: 0,
    outputTruncated: false,
    exitCode: undefined,
    needsConfigurationDone: true,
    parentSessionId: undefined,
    childSessionIds: undefined,
    ...overrides,
  }
}

const STUB_ADAPTER: DapResolvedAdapter = {
  name: 'stub-node',
  command: 'does-not-exist-stub',
  args: [],
  resolvedCommand: 'does-not-exist-stub',
  languages: ['javascript', 'typescript'],
  fileTypes: ['.ts', '.js'],
  rootMarkers: ['package.json', 'tsconfig.json'],
  launchDefaults: { type: 'node' },
  attachDefaults: {},
  connectMode: 'stdio',
  acceptsDirectoryProgram: false,
}

const ALL_CAPABILITIES: DapCapabilities = {
  supportsConfigurationDoneRequest: true,
  supportsFunctionBreakpoints: true,
  supportsInstructionBreakpoints: true,
  supportsDataBreakpoints: true,
  supportsReadMemoryRequest: true,
  supportsWriteMemoryRequest: true,
  supportsModulesRequest: true,
  supportsLoadedSourcesRequest: true,
  supportsDisassembleRequest: true,
  supportsEvaluateForHovers: true,
  supportsEvaluateForContexts: true,
  supportsStepBack: false,
  supportsRestartFrame: false,
  supportsResumeStateSupport: false,
  supportsRestartRequest: false,
  supportTerminateRequest: true,
  supportSuspendDebuggee: true,
  supportSetVariable: false,
  supportValueFormattingOptions: true,
}

/** Minimal `ctx.dap` double: enough state machine to satisfy the dispatch table. */
class StubDap extends Service {
  active: DapSessionSummary
  capabilities: DapCapabilities
  outputText: string

  constructor(ctx: Context, capabilities: DapCapabilities = ALL_CAPABILITIES) {
    super(ctx, 'dap')
    this.active = makeSnapshot()
    this.capabilities = capabilities
    this.outputText = 'hello from the stub debuggee\n'
  }

  getCapabilities(): DapCapabilities | null {
    return this.capabilities
  }

  getActiveSession(): DapSessionSummary | null {
    return this.active
  }

  listSessions(): DapSessionSummary[] {
    return [this.active]
  }

  getOutput(): { snapshot: DapSessionSummary; output: string } {
    return { snapshot: this.active, output: this.outputText }
  }

  async classifyProgram(): Promise<'file' | 'directory' | 'unknown'> {
    return 'file'
  }

  async selectLaunchAdapter(): Promise<LaunchAdapterSelection> {
    return { kind: 'adapter', adapter: STUB_ADAPTER }
  }

  async selectAttachAdapter(): Promise<DapResolvedAdapter | null> {
    return STUB_ADAPTER
  }

  async listAdapters(): Promise<string[]> {
    return ['stub-node']
  }

  async resolveAdapter(): Promise<DapResolvedAdapter | null> {
    return STUB_ADAPTER
  }

  resolveLaunchOverrides(): Record<string, unknown> {
    return {}
  }

  async launch(): Promise<DapSessionSummary> {
    return this.active
  }

  async attach(): Promise<DapSessionSummary> {
    return this.active
  }

  async setBreakpoint(
    file: string,
    line: number,
  ): Promise<{
    snapshot: DapSessionSummary
    breakpoints: { id: number | undefined; verified: boolean; line: number; condition: string | undefined; message: string | undefined }[]
    sourcePath: string
  }> {
    this.active = makeSnapshot({ source: { name: 'prog.py', path: file }, line })
    return {
      snapshot: this.active,
      breakpoints: [{ id: 1, verified: true, line, condition: undefined, message: undefined }],
      sourcePath: file,
    }
  }

  async removeBreakpoint(): Promise<{
    snapshot: DapSessionSummary
    breakpoints: { id: number | undefined; verified: boolean; line: number; condition: string | undefined; message: string | undefined }[]
  }> {
    return { snapshot: this.active, breakpoints: [] }
  }

  async setFunctionBreakpoint(name: string): Promise<{
    snapshot: DapSessionSummary
    breakpoints: { name: string; verified: boolean; id: number | undefined }[]
  }> {
    return { snapshot: this.active, breakpoints: [{ name, verified: true, id: 1 }] }
  }

  async removeFunctionBreakpoint(): Promise<{
    snapshot: DapSessionSummary
    breakpoints: { name: string; verified: boolean; id: number | undefined }[]
  }> {
    return { snapshot: this.active, breakpoints: [] }
  }

  async setInstructionBreakpoint(instructionReference: string): Promise<{
    snapshot: DapSessionSummary
    breakpoints: {
      id: number | undefined
      verified: boolean
      instructionReference: string
      offset: number | undefined
      condition: string | undefined
      hitCondition: string | undefined
      message: string | undefined
    }[]
  }> {
    return {
      snapshot: this.active,
      breakpoints: [
        {
          id: 1,
          verified: true,
          instructionReference,
          offset: undefined,
          condition: undefined,
          hitCondition: undefined,
          message: undefined,
        },
      ],
    }
  }

  async removeInstructionBreakpoint(): Promise<{
    snapshot: DapSessionSummary
    breakpoints: {
      id: number | undefined
      verified: boolean
      instructionReference: string
      offset: number | undefined
      condition: string | undefined
      hitCondition: string | undefined
      message: string | undefined
    }[]
  }> {
    return { snapshot: this.active, breakpoints: [] }
  }

  async dataBreakpointInfo(): Promise<{
    snapshot: DapSessionSummary
    info: { dataId: string; description: string; breakpoints: { verified: boolean }[] }
  }> {
    return { snapshot: this.active, info: { dataId: 'x', description: 'field x', breakpoints: [{ verified: true }] } }
  }

  async setDataBreakpoint(): Promise<{
    snapshot: DapSessionSummary
    breakpoints: {
      id: number | undefined
      verified: boolean
      dataId: string
      accessType: string | undefined
      condition: string | undefined
      hitCondition: string | undefined
      message: string | undefined
    }[]
  }> {
    return { snapshot: this.active, breakpoints: [{ id: 1, verified: true, dataId: 'x', accessType: undefined, condition: undefined, hitCondition: undefined, message: undefined }] }
  }

  async removeDataBreakpoint(): Promise<{
    snapshot: DapSessionSummary
    breakpoints: {
      id: number | undefined
      verified: boolean
      dataId: string
      accessType: string | undefined
      condition: string | undefined
      hitCondition: string | undefined
      message: string | undefined
    }[]
  }> {
    return { snapshot: this.active, breakpoints: [] }
  }

  async continue(): Promise<{ snapshot: DapSessionSummary; state: 'running' | 'stopped' | 'terminated'; timedOut: boolean }> {
    return { snapshot: this.active, state: 'stopped', timedOut: false }
  }

  async pause(): Promise<DapSessionSummary> {
    return this.active
  }

  async stepOver(): Promise<{ snapshot: DapSessionSummary; state: 'running' | 'stopped' | 'terminated'; timedOut: boolean }> {
    return { snapshot: this.active, state: 'stopped', timedOut: false }
  }

  async stepIn(): Promise<{ snapshot: DapSessionSummary; state: 'running' | 'stopped' | 'terminated'; timedOut: boolean }> {
    return { snapshot: this.active, state: 'stopped', timedOut: false }
  }

  async stepOut(): Promise<{ snapshot: DapSessionSummary; state: 'running' | 'stopped' | 'terminated'; timedOut: boolean }> {
    return { snapshot: this.active, state: 'stopped', timedOut: false }
  }

  async threads(): Promise<{ snapshot: DapSessionSummary; threads: { id: number; name: string }[] }> {
    return { snapshot: this.active, threads: [{ id: 1, name: 'main' }, { id: 2, name: 'worker' }] }
  }

  async stackTrace(): Promise<{
    snapshot: DapSessionSummary
    stackFrames: { id: number; name: string; line: number; column: number; source?: { name: string; path: string } }[]
    totalFrames: number | undefined
  }> {
    return { snapshot: this.active, stackFrames: [{ id: 1, name: 'main', line: 7, column: 1, source: { name: 'prog.py', path: PROGRAM } }, { id: 2, name: '<module>', line: 3, column: 1, source: { name: 'prog.py', path: PROGRAM } }], totalFrames: 2 }
  }

  async scopes(): Promise<{
    snapshot: DapSessionSummary
    scopes: {
      name: string
      variablesReference: number
      expensive: boolean
      source?: { name: string; path: string }
      line?: number
      column?: number
    }[]
  }> {
    return { snapshot: this.active, scopes: [{ name: 'Local', variablesReference: 11, expensive: false, source: { name: 'prog.py', path: PROGRAM } }] }
  }

  async variables(variableReference: number): Promise<{
    snapshot: DapSessionSummary
    variables: { name: string; value: string; type?: string; variablesReference: number }[]
  }> {
    void variableReference
    return { snapshot: this.active, variables: [{ name: 'x', value: '42', type: 'int', variablesReference: 0 }] }
  }

  async evaluate(): Promise<{
    snapshot: DapSessionSummary
    evaluation: { result: string; type?: string; variablesReference: number } | undefined
  }> {
    return { snapshot: this.active, evaluation: { result: 'stub-eval', type: 'string', variablesReference: 0 } }
  }

  async disassemble(): Promise<{ snapshot: DapSessionSummary; instructions: { address: string; instruction: string; line: number }[] }> {
    return { snapshot: this.active, instructions: [{ address: '0x1000', instruction: 'mov rax, rbx', line: 7 }] }
  }

  async readMemory(): Promise<{
    snapshot: DapSessionSummary
    address: string
    data: string | undefined
    unreadableBytes: number | undefined
  }> {
    return { snapshot: this.active, address: '0x1000', data: 'AAEC', unreadableBytes: undefined }
  }

  async writeMemory(): Promise<{ snapshot: DapSessionSummary; offset: number | undefined; bytesWritten: number | undefined }> {
    return { snapshot: this.active, offset: 0, bytesWritten: 4 }
  }

  async modules(): Promise<{ snapshot: DapSessionSummary; modules: { id: number | string; name: string }[] }> {
    return { snapshot: this.active, modules: [{ id: 1, name: 'main' }] }
  }

  async loadedSources(): Promise<{ snapshot: DapSessionSummary; sources: { name: string; path: string }[] }> {
    return { snapshot: this.active, sources: [{ name: 'prog.py', path: PROGRAM }] }
  }

  async customRequest(): Promise<{ snapshot: DapSessionSummary; body: unknown }> {
    return { snapshot: this.active, body: { ok: true } }
  }

  async terminate(): Promise<DapSessionSummary | null> {
    return makeSnapshot({ status: 'terminated', exitCode: 0 })
  }
}

let seq = 0
const testSignal = new AbortController().signal

async function mount(capabilities: DapCapabilities = ALL_CAPABILITIES, config: ToolDebug.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubDap, capabilities)
  await ctx.plugin(ToolDebug, config)
  return { ctx, dap: ctx.get('dap') as unknown as StubDap }
}

function call(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: `d-${++seq}` as never,
    name: 'debug',
    arguments: args,
    agent: { session: { header: { cwd: WORKSPACE } } } as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('tool-debug registration', () => {
  it('registers the debug tool, its prompt section, and the default timeout', async () => {
    const { ctx } = await mount()
    expect(ctx.tools.get('debug')).toBeDefined()
    expect(ctx.tools.get('debug')?.timeoutMs).toBe(DEFAULT_DEBUG_TOOL_TIMEOUT_MS)
    const prompt = await ctx.systemPrompt.assemble()
    expect(prompt.sections.map(s => s.text).join('\n')).toContain(DEBUG_PROMPT_TEXT)
  })

  it('exposes exactly the 28 operations in the schema enum', async () => {
    const { ctx } = await mount()
    const schema = ctx.tools.get('debug')?.parameters as { properties: { action: { enum: string[] } } }
    expect(schema.properties.action.enum).toEqual(DEBUG_ACTIONS)
    expect(DEBUG_ACTIONS.length).toBe(28)
  })

  it('has no default export (namespace plugin shape)', () => {
    expect((ToolDebug as { default?: unknown }).default).toBeUndefined()
  })

  it('rejects a non-positive request timeout config at load', async () => {
    await expect(mount(undefined, { requestTimeoutSec: 0 })).rejects.toThrow(/requestTimeoutSec/)
  })

  it('rejects a tool timeout above the Node timer range at load', async () => {
    await expect(mount(undefined, { timeoutMs: MAX_TIMER_DELAY_MS + 1 })).rejects.toThrow(/timeoutMs/)
  })
})

describe('tool-debug execution over the dispatch table', () => {
  it('launches a program and reports the stopped location', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, { action: 'launch', program: 'prog.py' })
    expect(result.isError).toBe(false)
    const out = text(result)
    expect(out).toContain('stub-node')
    expect(out).toContain('stopped')
    expect(out).toContain('main')
  })

  it('sets a source breakpoint and verifies it', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, { action: 'set_breakpoint', file: 'prog.py', line: 7 })
    expect(result.isError).toBe(false)
    expect(text(result)).toMatch(/verified/i)
  })

  it('reports an adapter-unavailable launch with the debugpy install hint', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const stub = new StubDap(ctx)
    // Override just the selection for this test.
    stub.selectLaunchAdapter = async () => ({ kind: 'unavailable', adapterName: 'debugpy', command: 'debugpy' }) as never
    await ctx.plugin(ToolDebug, {})
    const result = await call(ctx, { action: 'launch', program: 'prog.py', adapter: 'debugpy' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('pip install debugpy')
  })

  it('steps and continue report the stop outcome', async () => {
    const { ctx } = await mount()
    const step = await call(ctx, { action: 'step_over' })
    expect(step.isError, JSON.stringify(step)).toBe(false)
    expect(text(step)).toContain('Step over stopped at')
    const go = await call(ctx, { action: 'continue' })
    expect(go.isError).toBe(false)
    expect(text(go)).toContain('Continue stopped at')
  })

  it('inspects threads, frames, scopes, variables, and evaluates', async () => {
    const { ctx } = await mount()
    const threads = await call(ctx, { action: 'threads' })
    const out = text(threads)
    expect(out).toContain('main')
    expect(out).toContain('worker')

    const frames = await call(ctx, { action: 'stack_trace' })
    expect(text(frames)).toContain('main')

    const scopes = await call(ctx, { action: 'scopes' })
    expect(text(scopes)).toContain('Local')

    const vars = await call(ctx, { action: 'variables', variable_ref: 11 })
    expect(text(vars)).toContain('42')

    const evalResult = await call(ctx, { action: 'evaluate', expression: 'x' })
    expect(text(evalResult)).toContain('stub-eval')
    expect(evalResult.isError).toBe(false)
  })

  it('guards capability-gated operations', async () => {
    const none: DapCapabilities = {}
    const { ctx } = await mount(none)
    const result = await call(ctx, { action: 'read_memory', memory_reference: '0x1000', count: 8 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support memory reads')
  })

  it('covers modules, loaded_sources, memory, custom requests and sessions', async () => {
    const { ctx } = await mount()
    expect(text(await call(ctx, { action: 'modules' }))).toContain('main')
    expect(text(await call(ctx, { action: 'loaded_sources' }))).toContain('prog.py')
    expect(text(await call(ctx, { action: 'read_memory', memory_reference: '0x1000', count: 4 }))).toContain('Memory at 0x1000')
    expect(text(await call(ctx, { action: 'read_memory', memory_reference: '0x1000', count: 4 }))).toContain('00 01 02')
    expect(text(await call(ctx, { action: 'write_memory', memory_reference: '0x1000', data: 'AAEC' }))).toContain('Bytes written: 4')
    expect(text(await call(ctx, { action: 'custom_request', command: 'custom/foo' }))).toContain('"ok": true')
    expect(text(await call(ctx, { action: 'output' }))).toContain('hello from the stub debuggee')
    expect(text(await call(ctx, { action: 'sessions' }))).toContain('stub-node')
    const terminated = await call(ctx, { action: 'terminate' })
    expect(terminated.isError).toBe(false)
    expect(text(terminated)).toContain('terminated')
  })

  it('requires an active session for session-bound reads', async () => {
    const { ctx } = await mount()
;(ctx.get('dap') as unknown as StubDap).active = null as never
    const result = await call(ctx, { action: 'read_memory', memory_reference: '0x1000', count: 4 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('No active debug session')
  })
})

describe('pure helpers', () => {
  it('parseDebugArgs rejects unknown actions and keeps snake_case args', () => {
    expect(() => parseDebugArgs({ action: 'nope' })).toThrow(/action must be one of/)
    expect(() => parseDebugArgs(null)).toThrow(/must be an object/)
    const parsed = parseDebugArgs({ action: 'set_breakpoint', file: 'a.py', line: 3 })
    expect(parsed.file).toBe('a.py')
    expect(parsed.line).toBe(3)
  })

  it('summarizeDebugCall renders an action + target', () => {
    expect(summarizeDebugCall({ action: 'launch', program: '/x/main.py' })).toBe('launch /x/main.py')
    expect(summarizeDebugCall({ action: 'evaluate', expression: 'x' })).toBe('evaluate x')
    expect(summarizeDebugCall({ action: 'continue' })).toBe('continue')
  })

  it('makeDebugOutput truncates long messages and embeds extras', () => {
    const out = makeDebugOutput('launch', 'a'.repeat(10_000), {}, 200)
    expect(out.message.startsWith('a'.repeat(200))).toBe(true)
    expect(out.message.endsWith('\n… (truncated)')).toBe(true)
    expect(out.message.length).toBe(214)
    expect(out.action).toBe('launch')
    expect(out.success).toBe(true)
  })
})
