import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import Dap, { type DapResolvedAdapter } from '../src/index.ts'

/**
 * Real-debugger round trip over `debugpy` (the DAP adapter shipped inside the
 * `debugpy` PyPI package). `python -m debugpy.adapter --port N` runs the
 * adapter in TCP server mode — exactly the connectMode the manager reserves
 * ports for — and accepts a `launch` request with `program`, booting the
 * debuggee internally. Skips when no python module `debugpy` is importable
 * (e.g. CI without the extra), so the plain unit suite stays hermetic.
 */
function findDebugpyPython(): string | null {
  const candidates = process.env.DSH_DEBUGPY_PYTHON?.split(':').filter(Boolean) ?? ['python3', 'python']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import debugpy'], { timeout: 10_000 })
    if (probe.status === 0) return candidate
  }
  return null
}

const debugpyPython = findDebugpyPython()

describe
  .runIf(debugpyPython !== null)('dap live round trip over debugpy', () => {
    let dir: string
    let programPath: string
    let ctx: Context
    let dap: Dap

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'dsh-dap-live-'))
      programPath = join(dir, 'live_prog.py')
      writeFileSync(
        programPath,
        [
          'import time',
          '',
          'x = 41',
          "print('live-start', flush=True)",
          'time.sleep(0.05)',
          'x += 1',
          'y = [1, 2, 3]',
          'print("x =", x, "y =", y, flush=True)',
          'time.sleep(0.05)',
          'x += 1',
          "print('done x =', x, flush=True)",
          '',
        ].join('\n'),
      )
      ctx = new Context()
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(Dap)
      dap = ctx.get('dap') as Dap
    })

    afterAll(async () => {
      try {
        await dap.terminate(undefined, 5_000)
      } catch {
        // session may already be gone
      }
      rmSync(dir, { recursive: true, force: true })
    })

    function adapter(): DapResolvedAdapter {
      return {
        name: 'debugpy',
        command: debugpyPython!,
        args: ['-m', 'debugpy.adapter', '--port', '${port}'],
        resolvedCommand: debugpyPython!,
        languages: ['python'],
        fileTypes: ['.py'],
        rootMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'],
        launchDefaults: { request: 'launch', justMyCode: false, stopOnEntry: true },
        attachDefaults: { request: 'attach', justMyCode: false },
        connectMode: 'tcp',
        acceptsDirectoryProgram: false,
      }
    }

    it(
      'launches, breaks, steps through frames/locals, evaluates, and terminates',
      { timeout: 90_000 },
      async () => {
        const summary = await dap.launch(
          { adapter: adapter(), program: programPath, cwd: dir },
          undefined,
          30_000,
        )
        expect(summary.id).toBeTruthy()
        await new Promise(resolve => setTimeout(resolve, 400))
        expect(dap.getActiveSession()?.status).toBe('stopped') // stopOnEntry

        const bp = await dap.setBreakpoint(programPath, 8)
        expect(bp.breakpoints[0]!.verified).toBe(true)
        expect(bp.breakpoints[0]!.line).toBe(8)

        const go = await dap.continue(undefined, 20_000)
        expect(go.state).toBe('stopped')
        expect(go.snapshot.stopReason).toBe('breakpoint')
        expect(go.snapshot.source?.path).toBe(programPath)
        expect(go.snapshot.line).toBe(8)

        const frames = await dap.stackTrace(undefined, undefined, 20_000)
        expect(frames.stackFrames.length).toBeGreaterThan(0)

        const scopes = await dap.scopes(frames.stackFrames[0]!.id, undefined, 20_000)
        const locals = scopes.scopes.find(s => s.name === 'Locals') ?? scopes.scopes[0]!
        const vars = await dap.variables(locals.variablesReference, undefined, 20_000)
        const x = vars.variables.find(v => v.name === 'x')
        expect(x).toBeDefined()
        expect(x!.value).toBe('42')
        const y = vars.variables.find(v => v.name === 'y')
        expect(y?.value).toContain('1, 2, 3')

        const evaluation = await dap.evaluate('x + 1', undefined, frames.stackFrames[0]!.id, undefined, 20_000)
        expect(evaluation.evaluation?.result).toBe('43')

        const output = dap.getOutput(0)
        expect(output.output).toContain('live-start')

        const final = await dap.terminate(undefined, 20_000)
        expect(final).not.toBeNull()
      },
    )
  })
