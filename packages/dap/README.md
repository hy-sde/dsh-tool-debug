# @hy-sde-org/dsh-dap

The standalone Debug Adapter Protocol (DAP) seam for DeepSeek Harness: a
DAP client and session manager that launches/attaches real debuggers
(debugpy, lldb-dap, gdb, dlv, js-debug, ...) and drives them end-to-end —
source/function/instruction/data breakpoints, continue/pause/step,
threads, stack traces, scopes, variables, evaluate, disassembly, memory
reads/writes, modules, loaded sources, custom requests, captured output, and
termination.

Consumers either take the `ctx.dap` service (this package exports a
`Dap`-shaped Cordis service) or use the session manager directly as a
library. The model-facing agent tool lives in
[`@hy-sde-org/dsh-tool-debug`](../tool-debug); this package is the seam it
delegates to, and is useful on its own for IDE/debugger integrations that
want a DAP client without the agent tool surface.

Ported from [oh-my-pi](https://github.com/oh-my-pi/oh-my-pi)'s
`coding-agent/src/dap/{client,session,config}.ts` (MIT) and reworked onto the
harness subprocess contract.

## Seam

- `name`: `dap`, `inject`: `['subprocess']`
- `Dap extends Service` — one session manager per isolated realm; lifecycle
  is fiber-scoped (disposal terminates every live adapter and stops the
  idle-cleanup timer).
- Adapter resolution: named adapters with launch defaults, env-var override
  (`DSH_DEBUGPY_PYTHON` for the python probing order), and structured
  "unavailable" outcomes that name the install command.

## Adapters

| name | engine | connect | extras |
|---|---|---|---|
| `debugpy` | Python (`pip install debugpy`) | TCP server on a reserved port | `justMyCode`, stopOnEntry; standalone stdio mode has no launch |
| `node` / `js-debug` | vscode-js-debugger | stdio | session trees |
| `dlv` | Delve | stdio / socket (`--headless`) | function/instruction breakpoints |
| `lldb-dap` | LLDB | stdio | disassembly, memory |
| `gdb` | gdb | stdio (mi) | ... |

## Session manager

The manager owns the active-session pointer, adapter processes, breakpoint
state, and captured output. Every operation returns the updated session
snapshot plus its result, so consumers can render state without racing:
`launch`, `attach`, breakpoint mutations, `continue`/`pause`/`stepIn`/
`stepOut`/`stepOver`, `threads`, `stackTrace`, `scopes`, `variables`,
`evaluate`, `disassemble`, `readMemory`/`writeMemory`, `modules`,
`loadedSources`, `customRequest`, `getOutput`, `terminate`, `listSessions`,
`getActiveSession`, `getCapabilities`.

## Testing

`pnpm --filter @hy-sde-org/dsh-dap test` (vitest) covers framing round-trips
and the session manager against a scripted adapter. With a Python env that
has `debugpy` importable (set `DSH_DEBUGPY_PYTHON=/path/to/python`, or have
`python3`/`python` with the package), the live spec additionally runs a real
launch → stop → breakpoint → continue → frames/locals → evaluate →
terminate round trip over `python -m debugpy.adapter --port N`.
