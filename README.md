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

**Why this exists.** Coding-agent debugging is mostly harness: a real
stepping/breakpoints debugger — versus "insert print statements and rerun" —
is the difference between interrogating a fault and instrumenting around it.
This plugin ports a proven DAP debugger into the model's tool surface and
ships it as an installable plugin.

## Install

```bash
pnpm install --global @deepseek-ai/dsh
```

### Direct from npm (published)

Both packages are published on the npm registry under the `hy-sde-org`
organization (`@hy-sde-org/dsh-dap` and `@hy-sde-org/dsh-tool-debug`,
version `0.1.2-rc.1`). Install the plugin straight from npm — the registry
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

### From the git checkout (pre-publish / development)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins
pnpm install
pnpm --filter @hy-sde-org/dsh-tool-debug build
# symlink both packages into your harness's plugin lookup
dsh plugin --profile web link ../dsh-tool-debug/packages/tool-debug
```

### Verify

```bash
pnpm -r check && pnpm -r test && pnpm -r build
bash scripts/release-public.sh --check   # clean tree + checks + tests + pack
```

For the live debugger round trip, point the suite at a Python with
`debugpy` installed:

```bash
DSH_DEBUGPY_PYTHON=/path/to/python pnpm --filter @hy-sde-org/dsh-dap test
```

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
pnpm -r build   # tsc -> dist for both
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
