import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  DapSessionManager,
  type DapResolvedAdapter,
  type DapSpawner,
} from '../src/index.ts'

/**
 * A tiny scripted DAP adapter subprocess. It accepts framing on stdin, answers
 * every request the manager sends, and fires the events that drive the
 * stop-state machine (initialized, stopped after configurationDone and after
 * every continue/step/pause, output on launch).
 */
const ADAPTER_SCRIPT = `
const path = require('node:path')
let buf = Buffer.alloc(0)
let seq = 0
function encode(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n', 'ascii'), body])
}
function parse(b) {
  const headerEnd = b.indexOf('\\r\\n\\r\\n')
  if (headerEnd === -1) return null
  const header = b.subarray(0, headerEnd).toString('utf8')
  const m = /Content-Length: (\\d+)/i.exec(header)
  if (!m) return null
  const len = Number(m[1])
  if (b.length < headerEnd + 4 + len) return null
  return { rest: b.subarray(headerEnd + 4 + len), body: JSON.parse(b.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8')) }
}
let state = { line: 1, sourcePath: 'prog.py' }
function stopped(extra) {
  process.stdout.write(encode({ seq: ++seq, type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1, allThreadsStopped: true, ...(extra || {}) } }))
}
function respond(req, body, success = true) {
  process.stdout.write(encode({ seq: ++seq, type: 'response', request_seq: req.seq, success, command: req.command, body }))
}
function handle(req) {
  const a = req.arguments || {}
  let body
  switch (req.command) {
    case 'initialize':
      body = { supportsConfigurationDoneRequest: true, supportsStepping: true, supportsEvaluateForHovers: true, supportsTerminateRequest: true, supportsFunctionBreakpoints: true, supportsInstructionBreakpoints: true, supportsDataBreakpoints: true, supportsReadMemoryRequest: false, supportsWriteMemoryRequest: false, supportValueFormattingOptions: true, exceptionBreakpointFilters: [], supportsDisassembleRequest: true }
      respond(req, body)
      process.stdout.write(encode({ seq: ++seq, type: 'event', event: 'initialized', body: {} }))
      return
    case 'launch':
      process.stdout.write(encode({ seq: ++seq, type: 'event', event: 'output', body: { category: 'console', output: 'hello from debuggee\\n', source: { path: a.program } } }))
      respond(req, {})
      return
    case 'attach':
      respond(req, {})
      return
    case 'setBreakpoints':
      state.line = a.breakpoints?.[0]?.line ?? state.line
      state.sourcePath = a.source?.path ?? state.sourcePath
      body = { breakpoints: (a.breakpoints || []).map((b, i) => ({ id: i + 1, verified: true, line: b.line })) }
      break
    case 'setFunctionBreakpoints':
      body = { breakpoints: (a.breakpoints || []).map((b, i) => ({ name: b.name, verified: true, id: i + 1 })) }
      break
    case 'setInstructionBreakpoints':
      body = { breakpoints: (a.instructions || []).map((x, i) => ({ id: i + 1, verified: true, instructionReference: x.instructionReference })) }
      break
    case 'dataBreakpointInfo':
      body = { dataId: a.dataId, description: 'field x', breakpoints: [{ verified: true }] }
      break
    case 'setDataBreakpoints':
      body = { breakpoints: (a.breakpoints || []).map((x, i) => ({ id: i + 1, verified: true, dataId: x.dataId })) }
      break
    case 'configurationDone':
      respond(req, {})
      setTimeout(() => stopped({ reason: 'breakpoint', description: 'Hit breakpoint at line ' + state.line }), 5)
      return
    case 'continue':
      body = { allThreadsContinued: true }
      respond(req, body)
      setTimeout(() => stopped(), 5)
      return
    case 'next':
    case 'stepIn':
    case 'stepOut':
      body = { allThreadsContinued: true }
      respond(req, body)
      setTimeout(() => stopped({ reason: 'step' }), 5)
      return
    case 'pause':
      respond(req, {})
      setTimeout(() => stopped({ reason: 'pause' }), 5)
      return
    case 'threads':
      body = { threads: [{ id: 1, name: 'main' }, { id: 2, name: 'worker' }] }
      break
    case 'stackTrace':
      body = {
        stackFrames: [
          { id: 1, name: 'main', line: state.line, column: 1, source: { name: path.basename(state.sourcePath), path: state.sourcePath } },
          { id: 2, name: '<module>', line: 3, column: 1, source: { name: path.basename(state.sourcePath), path: state.sourcePath } },
        ],
        totalFrames: 2,
      }
      break
    case 'scopes':
      body = { scopes: [{ name: 'Local', variablesReference: 11, expensive: false }, { name: 'Global', variablesReference: 12, expensive: true }] }
      break
    case 'variables':
      if (a.variablesReference === 11) body = { variables: [{ name: 'x', value: '42', type: 'int', variablesReference: 0 }, { name: 'items', value: '[1, 2, 3]', type: 'list', variablesReference: 13 }] }
      else if (a.variablesReference === 13) body = { variables: [{ name: '0', value: '1', type: 'int', variablesReference: 0 }, { name: '1', value: '2', type: 'int', variablesReference: 0 }] }
      else body = { variables: [] }
      break
    case 'evaluate':
      body = { result: a.expression === 'boom' ? undefined : 'eval-result', type: 'string' }
      break
    case 'disassemble':
      body = { instructions: [{ address: '0x1000', instruction: 'mov rax, rbx', line: state.line }] }
      break
    case 'modules':
      body = { modules: [{ id: 1, name: 'main' }] }
      break
    case 'loadedSources':
      body = { sources: [{ name: path.basename(state.sourcePath), path: state.sourcePath }] }
      break
    case 'custom/foo':
      body = { ok: true }
      break
    case 'disconnect':
      respond(req, {})
      setTimeout(() => process.exit(0), 5)
      return
    case 'terminate':
      respond(req, {})
      setTimeout(() => process.exit(0), 5)
      return
    default:
      body = { error: { id: -32601, message: 'not implemented: ' + req.command } }
  }
  respond(req, body)
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const frame = parse(buf)
    if (!frame) break
    buf = frame.rest
    if (frame.body.type === 'request') handle(frame.body)
  }
})
`.trim() + '\n'

const SCRIPTS: Record<string, string> = {}

let scriptFile: string

function spawnHandle(spec: SubprocessSpawnSpec, scriptPath: string): SubprocessHandle {
  // `spec.argv` is [resolvedCommand, ...args]; we force the node binary so the
  // test needs no adapter install.
  const child: ChildProcess = nodeSpawn(
    process.execPath,
    [scriptPath, ...spec.argv.slice(1)],
    { cwd: spec.cwd, env: { ...(spec.env ?? {}), DAP_SCRIPT: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stderrText = ''
  child.stderr!.on('data', (c: Buffer) => {
    stderrText += c.toString('utf8')
  })
  const done = new Promise<SubprocessOutcome>((resolve) => {
    child.on('close', (code, signal) => { resolve({ exitCode: code ?? 0, signal: signal ?? null }) })
  })
  return {
    pid: child.pid ?? -1,
    stdin: child.stdin ?? undefined,
    stdout: child.stdout ?? undefined,
    stderr: child.stderr ?? undefined,
    collected: {
      stderr: {
        readFrom(fromByte: number) {
          const text = stderrText.slice(fromByte)
          return { text, nextOffset: stderrText.length, lossy: false }
        },
      },
    },
    done,
    terminate() {
      child.kill('SIGTERM')
    },
    waitForExit(signal?: AbortSignal) {
      return new Promise((resolve) => {
        if (signal?.aborted) {  resolve(false); return }
        child.once('close', () => { resolve(true) })
        signal?.addEventListener('abort', () => { resolve(false) }, { once: true })
      })
    },
  }
}

function makeManager(scriptPath: string): DapSessionManager {
  const spawner: DapSpawner = spec => spawnHandle(spec, scriptPath)
  return new DapSessionManager({
    spawn: spawner,
    idleTimeoutMs: 60_000,
    cleanupIntervalMs: 1_000,
    maxOutputBytes: 4096,
  })
}

function adapterFor(scriptPath: string): DapResolvedAdapter {
  return {
    name: 'test-node',
    command: process.execPath,
    args: [scriptPath],
    resolvedCommand: process.execPath,
    languages: ['javascript', 'typescript'],
    fileTypes: ['.ts', '.js'],
    rootMarkers: ['package.json', 'tsconfig.json'],
    launchDefaults: { type: 'node' },
    attachDefaults: {},
    connectMode: 'stdio',
    acceptsDirectoryProgram: false,
  }
}

const SESSION_POLL_MS = 5_000

async function waitFor(predicate: () => boolean, description: string, timeoutMs = SESSION_POLL_MS): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('DapSessionManager with a scripted adapter', () => {
  let dir: string
  let programPath: string
  let scriptManager: DapSessionManager

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-dap-test-'))
    writeFileSync(join(dir, 'prog.py'), 'x = 42\nitems = [1, 2, 3]\nprint(x)\n')
    const script = SCRIPTS.adapter ?? ADAPTER_SCRIPT
    scriptFile = join(dir, 'adapter.cjs')
    writeFileSync(scriptFile, script)
    programPath = join(dir, 'prog.py')
    scriptManager = makeManager(scriptFile)
  })

  afterAll(() => {
    scriptManager.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('launches, sets breakpoints, stops, inspects frames and variables, evaluates, and terminates', async () => {
    const adapter = adapterFor(scriptFile)
    const summary = await scriptManager.launch(
      { adapter, program: programPath, cwd: dir },
      undefined,
      10_000,
    )
    expect(summary.adapter).toBe('test-node')
    expect(summary.id).toBeTruthy()
    // The adapter can stop (or stay running) by the time launch settles; the
    // deterministic signal is the stopped state below.

    // The adapter fires stopped right after configurationDone; wait for it.
    await waitFor(() => scriptManager.getActiveSession()?.status === 'stopped', 'stopped state after launch')

    const stopped = scriptManager.getActiveSession()!
    expect(stopped.threadId).toBe(1)
    expect(stopped.frameName).toBe('main')
    expect(stopped.line).toBeTruthy()

    // Breakpoint at line 3 of prog.py.
    const bp = await scriptManager.setBreakpoint(programPath, 3)
    expect(bp.sourcePath).toBe(programPath)
    expect(bp.breakpoints[0]!.verified).toBe(true)
    expect(bp.breakpoints[0]!.line).toBe(3)

    // Continue (the scripted adapter re-stops immediately).
    const go = await scriptManager.continue(undefined, 10_000)
    expect(go.state).toBe('stopped')
    expect(go.snapshot.threadId).toBe(1)
    expect(go.snapshot.stopReason).toBe('breakpoint')

    // Threads.
    const threads = await scriptManager.threads()
    expect(threads.threads.map(t => t.name)).toEqual(['main', 'worker'])

    // Stack trace.
    const frames = await scriptManager.stackTrace(undefined, undefined, 10_000)
    expect(frames.stackFrames.length).toBe(2)
    const top = frames.stackFrames[0]!
    expect(top.name).toBe('main')
    expect(top.line).toBe(3)
    expect(top.source?.path).toBe(programPath)

    // Scopes then variables.
    const scopes = await scriptManager.scopes(top.id, undefined, 10_000)
    expect(scopes.scopes[0]!.name).toBe('Local')
    expect(scopes.scopes[1]!.name).toBe('Global')

    const vars = await scriptManager.variables(scopes.scopes[0]!.variablesReference, undefined, 10_000)
    expect(vars.variables.map(v => v.name)).toEqual(['x', 'items'])
    expect(vars.variables[0]!.value).toBe('42')

    // Nested variablesReference.
    const items = await scriptManager.variables(vars.variables[1]!.variablesReference, undefined, 10_000)
    expect(items.variables.map(v => v.value)).toEqual(['1', '2'])

    // Evaluate in the top frame.
    const evalResult = await scriptManager.evaluate('x', undefined, top.id, undefined, 10_000)
    expect(evalResult.evaluation?.result).toBe('eval-result')

    // Disassemble + modules + loaded sources.
    const disasm = await scriptManager.disassemble('0x1000', 2, undefined, undefined, undefined, undefined, 10_000)
    expect(disasm.instructions.length).toBeGreaterThan(0)
    const mods = await scriptManager.modules(undefined, undefined, undefined, 10_000)
    expect(mods.modules[0]!.name).toBe('main')
    const loaded = await scriptManager.loadedSources()
    expect(loaded.sources.some(s => s.path === programPath)).toBe(true)

    // Output captured from the launch event.
    const outputSnapshot = scriptManager.getOutput(0)
    expect(outputSnapshot.output).toContain('hello from debuggee')

    // Custom request passthrough.
    const custom = await scriptManager.customRequest('custom/foo', { marker: 1 }, undefined, 10_000)
    expect(custom.body).toEqual({ ok: true })

    // Step to verify stepping support keeps the state machine live.
    const step = await scriptManager.stepOver(undefined, 10_000)
    expect(step.state).toBe('stopped')

    // Terminate closes the adapter process.
    const final = await scriptManager.terminate(undefined, 10_000)
    expect(final).not.toBeNull()
    await waitFor(
      () => scriptManager.listSessions().every(s => s.status === 'terminated'),
      'sessions settled after terminate',
    )
  })
})
