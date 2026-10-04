<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-dap`](https://www.npmjs.com/package/@hy-sde-org/dsh-dap) · [`@hy-sde-org/dsh-tool-debug`](https://www.npmjs.com/package/@hy-sde-org/dsh-tool-debug)
<!-- MIRROR-NOTE:END -->

# dsh-tool-debug — a real DAP debugger for DeepSeek Harness

Two standalone packages, installable as **one plugin** for the DeepSeek
Harness CLI:

| package | role | installed by users? |
|---|---|---|
| `@hy-sde-org/dsh-dap` | standalone Debug Adapter Protocol seam: DAP client + session manager (launch/attach, breakpoints, stepping, frames/scopes/variables, evaluate, memory, modules, output, terminate) | no — transitive |
| `@hy-sde-org/dsh-tool-debug` | the plugin: the model-facing `debug` tool (28 operations) rendered as launch/breakpoint/step/stack/evaluate results | yes |

The `debug` tool is a parity port of oh-my-pi's coding-agent debug tool onto
the harness tool contract (`ctx.tools`, `ctx.dap`, `ctx.systemPrompt`). The
DAP seam spawns real debugger adapters (debugpy, lldb-dap, gdb, dlv,
js-debug, ...) as local binaries over stdio or a reserved TCP port, resolves
adapter availability into structured "unavailable" errors that name the
install command, and returns a session snapshot from every operation so the
agent always sees consistent debugger state. Everything works on stock
DeepSeek Harness releases with **zero upstream changes**.

## Why

Coding-agent debugging is mostly harness: a real stepping/breakpoints debugger —
versus "insert print statements and rerun" — is the difference between interrogating
a fault and instrumenting around it. This plugin ports a proven DAP debugger into the
model's tool surface and ships it as an installable plugin.

## Prerequisites

- Node.js 22.19 or newer (the packages' `engines` floor) with npm and pnpm on `PATH`;
- a DeepSeek Harness installation including the standard `dsh` CLI — the peer baseline
  is `@deepseek-ai/cordis ~4.0.4` and `@deepseek-ai/dsh-tools`/`dsh-system-prompt`/
  `dsh-timeout`/`dsh-invariants` `^0.2.0-rc.2`;
- at least one debugger adapter for the languages you want to debug, discovered at
  runtime via `PATH` (debugpy also via `DSH_DEBUGPY_PYTHON`): debugpy
  (`pip install debugpy`) for Python, lldb-dap or gdb for C/C++/Rust, dlv
  (`go install github.com/go-delve/delve/cmd/dlv@latest`) for Go, vscode-js-debug for
  JavaScript/TypeScript. An unavailable adapter is a structured error naming the
  install command, not a crash.

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Route A — published npm package (recommended)

Both packages are published on the npm registry under the `hy-sde-org`
organization (`@hy-sde-org/dsh-dap` and `@hy-sde-org/dsh-tool-debug`,
version `0.2.0-rc.2`). Install the plugin straight from npm — the registry
resolves the dap library dependency and the DeepSeek Harness peer packages
automatically:

```bash
# one command; @hy-sde-org/dsh-dap comes in as a transitive dependency
dsh plugin --profile web add @hy-sde-org/dsh-tool-debug
```

Installing the bundle alone never breaks boot and never claims any name on
the host plane — the harness has no stock `debug` tool to shadow. The tool
becomes available when you mount the provided
[agent preset](#giving-agents-the-debug-tool) row.

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install

DEBUG_TGZ="$(cd dsh-tool-debug/packages/tool-debug && pnpm pack --silent --pack-destination /tmp)"
dsh plugin --profile web add "$DEBUG_TGZ"
cd ..
```

`prepack` runs the package's clean + build, so the tarball always carries current
`dist/` for both the dap seam and the tool.

### Verify

```bash
dsh web --dump-config
```

The bundle's patch is a documented no-op — it inserts no rows and disables nothing —
so installation changes nothing in the composed tree, and nothing `debug`-named
appears on the host plane; boot is unaffected. The tool exists only for agents whose
preset mounts the dap + tool-debug rows (see *Giving agents the `debug` tool* below):
with the preset selected, ask the agent to run `debug` with `action: "sessions"` — an
empty session list, or a structured "no debugger adapter available" error naming the
install command, confirms the seam resolves.

### Run

Give agents the preset row (see *Giving agents the `debug` tool* below), then ask the
agent to debug. One grounded round trip against a Python program with `debugpy`:

```text
debug { "action": "launch", "program": "server.py", "adapter": "debugpy" }
debug { "action": "set_breakpoint", "file": "server.py", "line": 42 }
debug { "action": "continue" }
debug { "action": "stack_trace" }
debug { "action": "evaluate", "expression": "len(rows)" }
debug { "action": "terminate" }
```

One active session at a time — terminate before launching another. Breakpoints must
be set before continuing after a stop; an unavailable adapter is a structured error
that names the install command, not a crash.

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-tool-debug
```

## Giving agents the `debug` tool

`packages/tool-debug/examples/agent-preset/` contains a ready-to-copy user
preset. Copy `agent.cordis.yml` and `preset.yml` to
`~/.dsh/.agent-presets/<id>/`, select the preset in the Web UI preset picker
(or `dsh agent` CLI), and agents in that preset get the `debug` tool. The
preset mounts the `dap` service in its own isolated realm so each agent owns
its adapter processes and breakpoint state, with `tool-debug` beside it:

```yaml
- id: debug
  name: cordis:group
  group: true
  isolate:
    dap: true
  config:
    - id: dap
      name: '@hy-sde-org/dsh-dap'
    - id: tool-debug
      name: '@hy-sde-org/dsh-tool-debug'
```

## What the bundle does

- **Inserts no rows and disables nothing.** The official harness has no
  `debug` tool, so there is no collision to manage — the bundle's patch is a
  documented no-op that keeps the package installable as a normal plugin.
- **Mounts at the agent plane.** The preset row above is the only surface the
  model sees; it is scoped per session.
- **Adapters are local binaries.** debugpy (`pip install debugpy`), gdb,
  lldb-dap, dlv, and vscode-js-debugger are discovered at runtime via the
  `PATH`/`DSH_DEBUGPY_PYTHON` environment; unavailability is a structured
  error, not a crash.

## Tool operations

launch · attach · set_breakpoint · remove_breakpoint ·
set_function_breakpoint · remove_function_breakpoint ·
set_instruction_breakpoint · remove_instruction_breakpoint ·
data_breakpoint_info · set_data_breakpoint · remove_data_breakpoint ·
disassemble · read_memory · write_memory · modules · loaded_sources ·
custom_request · continue · pause · step_in · step_out · step_over ·
threads · stack_trace · scopes · variables · evaluate · get_output ·
terminate · sessions · capabilities

## Development

```bash
pnpm install
pnpm -r check   # typecheck both packages
pnpm -r test    # framing + session specs + the opt-in live debugpy round trip
pnpm -r build   # tsc -> dist for both
bash scripts/release-public.sh --check   # clean tree + checks + tests + pack
```

For the live debugger round trip, point the suite at a Python with `debugpy` installed:

```bash
DSH_DEBUGPY_PYTHON=/path/to/python pnpm --filter @hy-sde-org/dsh-dap test
```

## Layout

```
packages/dap/          @hy-sde-org/dsh-dap        (the DAP seam/engine)
  src/client.ts        DAP client + Content-Length framing
  src/session.ts       DapSessionManager
  src/config.ts        adapter resolution + launch defaults
  src/defaults.ts      omp default adapter configuration
  src/env.ts           python/debugpy probing
  tests/               framing + session specs + live debugpy round trip
packages/tool-debug/   @hy-sde-org/dsh-tool-debug (the `debug` tool plugin)
  src/index.ts         tool plugin entry (schema, config, dispatch)
  src/render.ts        result rendering the model reads
  src/session.ts       per-call dispatch over ctx.dap
  cordis.patch.yml     zero-effect install patch
  examples/agent-preset/ ready-to-copy user preset
```

See `THIRD-PARTY-NOTICES.md` for provenance, `CONTRIBUTING.md` for the
contribution and release flow.

## License and attribution

This package is licensed MIT — the same license as its upstream oh-my-pi
(https://github.com/can1357/oh-my-pi). The DAP seam and the `debug` tool are
ported from oh-my-pi's coding-agent debug tooling (MIT License, © Mario Zechner 2025,
© Can Bölük 2025-2026); the upstream copyright holders are recorded in LICENSE next to
this package's own notice, and the upstream notice text is reproduced in full in
THIRD-PARTY-NOTICES.md.
