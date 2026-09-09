# @hy-sde-org/dsh-tool-debug

The `debug` tool plugin for DeepSeek Harness, built on the standalone DAP
seam from the sibling package [`@hy-sde-org/dsh-dap`](../dap/): one tool, 28
operations — launch/attach, source/function/instruction/data breakpoints,
continue/pause/step, threads/stackTrace/scopes/variables/evaluate,
disassembly, memory access, modules, loaded sources, custom requests,
captured output, and termination.

```bash
dsh plugin --profile web add @hy-sde-org/dsh-tool-debug
```

The npm package installs a zero-effect bundle patch (nothing on the official
harness collides with the `debug` name, so there is nothing to disable or
shadow); the tool itself is mounted by adding the provided
[agent preset row](./examples/agent-preset) to a user preset. Installing the
bundle alone never breaks boot. After mounting the preset, agents get the
`debug` tool and can launch/attach real debuggers (debugpy, lldb-dap, gdb,
dlv, js-debug, ...) through the mounted DAP provider.

## Tool surface

- `name`: `tool-debug`, `inject`: `['tools', 'dap', 'systemPrompt']`
- Config: `maxResultChars` (16000), `requestTimeoutSec` (30), `timeoutMs`
  (120000, enforced by `dsh-tool-call-timeout-policy`).
- Requires a session workspace cwd (`exec.agent.session.header.cwd`) and is
  not concurrency-safe: debug sessions are exclusive.

## Behavior notes

- One active session: an active session must be terminated (or has
  terminated/exited) before another launch/attach.
- Paths resolve against the session workspace; `cwd` overrides per call.
- Per-request timeout aborts via a combined `AbortSignal` (call + timeout).
- Adapter selection errors name the missing adapter and the install command
  (`pip install debugpy`, `apt install gdb`, ...).
- Breakpoint mutations are serialized per session, and propagated to every
  live session when an adapter reports a session tree.

## Example preset

`examples/agent-preset/` contains a ready-to-copy user preset
(`agent.cordis.yml` + `preset.yml`) that mounts the debug group (the `dap`
service in its own isolated realm so each agent owns its adapter processes)
plus the `tool-debug` row beside it. Copy the directory to
`~/.dsh/.agent-presets/<id>/`, select the preset in the Web UI preset picker
(or `dsh agent` CLI), and agents in that preset can call `debug`.

## Testing

`pnpm --filter @hy-sde-org/dsh-tool-debug test` (vitest) covers argument
parsing, rendering, and an end-to-end launch/breakpoint/step/evaluate flow
through a scripted DAP adapter.
