/**
 * Adapter configuration and selection for the DAP capability seam: the
 * defaults table, per-workspace and per-user `dap.json` overlays, executable
 * resolution through the subprocess seam, and launch/attach adapter selection
 * by file extension, root markers, and program kind. Ported from oh-my-pi's
 * `coding-agent/src/dap/config.ts` (MIT) with the omp-specific config
 * directories and which-cache replaced by deterministic JSON sources and
 * `ctx.subprocess.resolveExecutable`.
 * @module @hy-sde-org/dsh-dap/config
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_ADAPTERS } from './defaults.ts'
import type { DapAdapterConfig, DapResolvedAdapter } from './types.ts'

/** `hasRootMarkers` matches globs (e.g. `*.sln`); root markers can be any basename. */
const GLOB_MARKER_RE = /[*?[\]{}!]/

/** How the launch `program` resolves on disk. `"missing"` is reserved for
 *  programs the adapter creates on demand (rare); we treat them like files. */
export type LaunchProgramKind = 'file' | 'directory' | 'missing'

const EXTENSIONLESS_DEBUGGER_ORDER: readonly string[] = ['gdb', 'lldb-dap']
const JS_DEBUG_SERVER_ENV = 'JS_DEBUG_DAP_SERVER'
const DAP_PORT_ARGUMENT = '${port}'

/** A resolved adapter + why it could not run (unavailable vs absent). */
export type LaunchAdapterSelection =
  | { kind: 'adapter'; adapter: DapResolvedAdapter }
  | { kind: 'unavailable'; adapterName: string; command: string }
  | { kind: 'none' }

interface DapResolveContext {
  cwd: string
  resolveExecutable: (command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) => Promise<string>
  signal: AbortSignal | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

function normalizeAdapterConfig(config: unknown): DapAdapterConfig | null {
  if (!isRecord(config)) return null
  if (typeof config.command !== 'string' || config.command.length === 0) return null
  const connectMode = config.connectMode === 'socket' || config.connectMode === 'tcp' ? config.connectMode : undefined
  return {
    command: config.command,
    args: normalizeStringArray(config.args),
    languages: normalizeStringArray(config.languages),
    fileTypes: normalizeStringArray(config.fileTypes).map(entry => entry.toLowerCase()),
    rootMarkers: normalizeStringArray(config.rootMarkers),
    launchDefaults: normalizeObject(config.launchDefaults),
    attachDefaults: normalizeObject(config.attachDefaults),
    acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
    ...(connectMode ? { connectMode } : {}),
  }
}

function normalizeConfig(value: unknown): { adapters: Record<string, unknown> } | null {
  if (!isRecord(value)) return null
  if (isRecord(value.adapters)) return { adapters: value.adapters }
  return { adapters: value }
}

function mergeAdapters(
  base: Record<string, DapAdapterConfig>,
  overrides: Record<string, unknown>,
): Record<string, DapAdapterConfig> {
  const merged: Record<string, DapAdapterConfig> = { ...base }
  for (const [name, config] of Object.entries(overrides)) {
    const existing = merged[name]
    const candidate = isRecord(config)
      ? {
        ...existing,
        ...config,
        launchDefaults: isRecord((config).launchDefaults)
          ? {
            ...(existing?.launchDefaults ?? {}),
            ...normalizeObject((config).launchDefaults),
          }
          : existing?.launchDefaults,
        attachDefaults: isRecord((config).attachDefaults)
          ? {
            ...(existing?.attachDefaults ?? {}),
            ...normalizeObject((config).attachDefaults),
          }
          : existing?.attachDefaults,
      }
      : config
    const normalized = normalizeAdapterConfig(candidate)
    if (normalized) {
      merged[name] = normalized
    }
  }
  return merged
}

/** One config file to try; read lazily so missing files never error. */
interface ConfigSource {
  read(): Promise<Record<string, unknown> | null>
}

function fileConfigSource(filePath: string, readFile: (p: string) => Promise<string | null>): ConfigSource {
  return {
    read: async () => {
      const content = await readFile(filePath)
      if (content === null) return null
      try {
        return normalizeConfig(JSON.parse(content))
      } catch {
        // A non-JSON file (e.g. a YAML `.dap.yaml`) is currently unsupported;
        // JSON is the documented format. Skip silently so one bad file does
        // not break every debug call.
        return null
      }
    },
  }
}

/**
 * Config sources in increasing precedence order (later sources win via
 * {@link loadAdapterConfigs}'s reverse loop): cwd files, the deployment data
 * dir, and the home dir root.
 */
function getConfigSources(
  cwd: string,
  readFile: (p: string) => Promise<string | null>,
): ConfigSource[] {
  const filenames = ['dap.json', '.dap.json', 'dap.yaml', '.dap.yaml', 'dap.yml', '.dap.yml']
  const sources: ConfigSource[] = []

  for (const filename of filenames) {
    sources.push(fileConfigSource(path.join(cwd, filename), readFile))
  }

  // Per-user overlay: the harness home when set (defaults to ~/.dsh), then the
  // bare home directory.
  const userDirs = [process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), os.homedir()]
  for (const dir of userDirs) {
    for (const filename of filenames) {
      sources.push(fileConfigSource(path.join(dir, filename), readFile))
    }
  }

  return sources
}

async function loadAdapterConfigs(
  cwd: string,
  readFile: (p: string) => Promise<string | null>,
): Promise<Record<string, DapAdapterConfig>> {
  let adapters = { ...DEFAULT_ADAPTERS }
  for (const source of getConfigSources(cwd, readFile).reverse()) {
    const parsed = await source.read()
    if (!parsed) continue
    // normalizeConfig guarantees an `adapters` record; cast for the merger.
    adapters = mergeAdapters(adapters, parsed.adapters as Record<string, unknown>)
  }
  return adapters
}

/** Read one config file as text, or null when it does not exist / is unreadable. */
const readConfigFile: (p: string) => Promise<string | null> = async (p) => {
  try {
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

/** Merge defaults with any config overlays under `cwd`.
 * @param cwd - the working directory to scan for config files.
 * @param readFile - read a file path as text, or null when missing/unreadable.
 * @returns the merged adapter config table.
 */
export async function getAdapterConfigs(
  cwd: string,
  readFile: (p: string) => Promise<string | null> = readConfigFile,
): Promise<Record<string, DapAdapterConfig>> {
  return loadAdapterConfigs(cwd, readFile)
}

/** Resolve a command to a canonical executable inside a workspace. */
async function resolveDapAdapterCommand(
  command: string,
  cwd: string,
  resolveExecutable: DapResolveContext['resolveExecutable'],
  signal?: AbortSignal,
): Promise<string | null> {
  const normalized = normalizeCommandForCwd(command, cwd)
  const commandIsBare =
    !path.isAbsolute(command) && !command.includes('/') && !command.includes('\\')
  if (commandIsBare) {
    try {
      return await resolveExecutable(normalized, undefined, signal)
    } catch {
      return null
    }
  }
  // Absolute or cwd-relative path: verify existence through the fs provider.
  try {
    await fs.stat(normalized)
    return normalized
  } catch {
    return null
  }
}

function normalizeCommandForCwd(command: string, cwd: string): string {
  if (path.isAbsolute(command)) return command
  if (command.startsWith('./') || command.startsWith('../') || command.startsWith('.\\') || command.startsWith('..\\')) {
    return path.resolve(cwd, command)
  }
  return command
}

/** The js-debug adapter runs `node <dapDebugServer.js> <port> 127.0.0.1`. */
async function resolveDefaultJsDebugAdapter(
  ctx: DapResolveContext,
  adapterName: string,
  config: DapAdapterConfig,
): Promise<DapResolvedAdapter | null | undefined> {
  if (adapterName !== 'js-debug-adapter' || config.command !== 'js-debug-adapter') {
    return undefined
  }
  const serverPath = await resolveJsDebugServerPath(ctx.cwd)
  if (!serverPath) return null
  const nodeCommand = await ctx.resolveExecutable('node', undefined, ctx.signal).catch(() => null)
  const resolvedCommand = nodeCommand ?? process.execPath
  return {
    name: adapterName,
    command: 'node',
    args: [serverPath, DAP_PORT_ARGUMENT, '127.0.0.1'],
    resolvedCommand,
    languages: config.languages ?? [],
    fileTypes: config.fileTypes ?? [],
    rootMarkers: config.rootMarkers ?? [],
    launchDefaults: config.launchDefaults ?? {},
    attachDefaults: config.attachDefaults ?? {},
    connectMode: 'tcp',
    acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
  }
}

/** Locate the installed js-debug dapDebugServer entry point. */
async function resolveJsDebugServerPath(cwd: string): Promise<string | null> {
  const configured = process.env[JS_DEBUG_SERVER_ENV]
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share')
  const candidates = [
    ...(configured ? [path.resolve(cwd, configured)] : []),
    path.join(dataHome, 'nvim', 'mason', 'packages', 'js-debug-adapter', 'js-debug', 'src', 'dapDebugServer.js'),
    path.join(os.homedir(), '.local', 'opt', 'js-debug', 'src', 'dapDebugServer.js'),
  ]
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate
    } catch {
      /* not present */
    }
  }
  return null
}

async function resolveAdapterFromConfig(
  ctx: DapResolveContext,
  adapterName: string,
  configs: Record<string, DapAdapterConfig>,
): Promise<DapResolvedAdapter | null> {
  const config = configs[adapterName]
  if (!config) return null
  const jsDebugAdapter = await resolveDefaultJsDebugAdapter(ctx, adapterName, config)
  if (jsDebugAdapter !== undefined) return jsDebugAdapter
  const resolvedCommand = await resolveDapAdapterCommand(config.command, ctx.cwd, ctx.resolveExecutable, ctx.signal)
  if (!resolvedCommand) return null
  return {
    name: adapterName,
    command: config.command,
    args: config.args ?? [],
    resolvedCommand,
    languages: config.languages ?? [],
    fileTypes: config.fileTypes ?? [],
    rootMarkers: config.rootMarkers ?? [],
    launchDefaults: config.launchDefaults ?? {},
    attachDefaults: config.attachDefaults ?? {},
    connectMode: config.connectMode ?? 'stdio',
    acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
  }
}

/** Resolve one named adapter, or null when it is not configured/executable.
 * @param adapterName - the adapter to resolve.
 * @param cwd - the working directory to scan for config files.
 * @param ctx - resolution context (resolveExecutable + signal).
 * @returns the resolved adapter, or null.
 */
export async function resolveAdapter(
  adapterName: string,
  cwd: string,
  ctx: Pick<DapResolveContext, 'resolveExecutable' | 'signal'>,
): Promise<DapResolvedAdapter | null> {
  const configs = await getAdapterConfigs(cwd)
  return resolveAdapterFromConfig({ cwd, resolveExecutable: ctx.resolveExecutable, signal: ctx.signal }, adapterName, configs)
}

/** Every configured adapter whose command resolves in this workspace.
 * @param cwd - the working directory to scan for config files.
 * @param ctx - resolution context (resolveExecutable + signal).
 * @returns the list of available, resolved adapters.
 */
export async function getAvailableAdapters(
  cwd: string,
  ctx: Pick<DapResolveContext, 'resolveExecutable' | 'signal'>,
): Promise<DapResolvedAdapter[]> {
  const configs = await getAdapterConfigs(cwd)
  const results = await Promise.all(
    Object.keys(configs).map(name =>
      resolveAdapterFromConfig({ cwd, resolveExecutable: ctx.resolveExecutable, signal: ctx.signal }, name, configs),
    ),
  )
  return results.filter((adapter): adapter is DapResolvedAdapter => adapter !== null)
}

/** True when `dir` (or an ancestor-walk root) contains one of `markers`.
 * @param dir - the directory to check.
 * @param markers - basenames or globs to look for.
 * @param listDir - list a directory's entries (used only for glob markers).
 * @returns true when any marker is present.
 */
export async function hasRootMarkers(
  dir: string,
  markers: string[],
  listDir: (p: string) => Promise<string[]>,
): Promise<boolean> {
  if (markers.length === 0) return false
  let entries: string[] | null = null
  for (const marker of markers) {
    if (GLOB_MARKER_RE.test(marker)) {
      entries ??= await listDir(dir).catch(() => null)
      if (entries === null) return false
      if (entries.some(entry => globMatch(marker, entry))) return true
    } else {
      try {
        if ((await fs.stat(path.join(dir, marker))).isFile() || (await fs.stat(path.join(dir, marker))).isDirectory()) {
          return true
        }
      } catch {
        /* keep scanning */
      }
    }
  }
  return false
}

/** Minimal glob: `*` matches any run of non-separator chars; `?` one char. */
function globMatch(pattern: string, value: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regex}$`).test(value)
}

interface LaunchAdapterCandidate {
  name: string
  rootDir: string | null
}

async function findRootMarkerInLaunchAncestry(
  program: string,
  cwd: string,
  markers: string[],
  programKind: LaunchProgramKind,
  listDir: (p: string) => Promise<string[]>,
): Promise<string | null> {
  if (markers.length === 0) return null
  let dir =
    programKind === 'directory' ? path.resolve(cwd, program) : path.dirname(path.resolve(cwd, program))
  while (true) {
    if (await hasRootMarkers(dir, markers, listDir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function resolveAdapterForLaunch(
  adapterName: string,
  configs: Record<string, DapAdapterConfig>,
  cwd: string,
  ctx: Pick<DapResolveContext, 'resolveExecutable' | 'signal'>,
): Promise<DapResolvedAdapter | null> {
  return resolveAdapterFromConfig(
    { cwd, resolveExecutable: ctx.resolveExecutable, signal: ctx.signal },
    adapterName,
    configs,
  )
}

function unavailableAdapter(
  candidate: LaunchAdapterCandidate,
  configs: Record<string, DapAdapterConfig>,
): LaunchAdapterSelection {
  const config = configs[candidate.name]
  if (!config) return { kind: 'none' }
  return { kind: 'unavailable', adapterName: candidate.name, command: config.command }
}

async function selectAutomaticLaunchAdapter(
  program: string,
  cwd: string,
  programKind: LaunchProgramKind,
  configs: Record<string, DapAdapterConfig>,
  ctx: Pick<DapResolveContext, 'resolveExecutable' | 'signal'>,
  listDir: (p: string) => Promise<string[]>,
): Promise<LaunchAdapterSelection> {
  const extension = path.extname(program).toLowerCase()
  if (extension) {
    const configured: LaunchAdapterCandidate[] = []
    const available: DapResolvedAdapter[] = []
    for (const name in configs) {
      const config = configs[name]
      if (!config || !(config.fileTypes ?? []).includes(extension)) continue
      const rootDir = await findRootMarkerInLaunchAncestry(program, cwd, config.rootMarkers ?? [], programKind, listDir)
      configured.push({ name, rootDir })
      const adapter = await resolveAdapterForLaunch(name, configs, cwd, ctx)
      if (adapter) available.push(adapter)
    }
    const selected = sortAdaptersForLaunch(program, available)[0]
    if (selected) return { kind: 'adapter', adapter: selected }
    const rootMatch = configured.find(candidate => candidate.rootDir !== null)
    const unavailable = rootMatch ?? configured[0]
    if (unavailable) return unavailableAdapter(unavailable, configs)
  }

  const available: DapResolvedAdapter[] = []
  const rootMatches: LaunchAdapterCandidate[] = []
  const directoryMatches: LaunchAdapterCandidate[] = []
  for (const name in configs) {
    const config = configs[name]
    if (!config) continue
    const rootDir = await findRootMarkerInLaunchAncestry(program, cwd, config.rootMarkers ?? [], programKind, listDir)
    const candidate = { name, rootDir }
    if (rootDir) {
      rootMatches.push(candidate)
      if (config.acceptsDirectoryProgram === true) directoryMatches.push(candidate)
    }
    if (!EXTENSIONLESS_DEBUGGER_ORDER.includes(name) && !rootDir) continue
    const adapter = await resolveAdapterForLaunch(name, configs, cwd, ctx)
    if (adapter) available.push(adapter)
  }

  if (programKind === 'directory' && directoryMatches.length > 0) {
    const matchingNames = new Set(directoryMatches.map(candidate => candidate.name))
    const directoryAdapters = available.filter(
      adapter => adapter.acceptsDirectoryProgram && matchingNames.has(adapter.name),
    )
    const selected = sortAdaptersForLaunch(program, directoryAdapters)[0]
    if (selected) return { kind: 'adapter', adapter: selected }
    const unavailable = directoryMatches[0]
    return unavailable ? unavailableAdapter(unavailable, configs) : { kind: 'none' }
  }

  const directoryAdapters =
    programKind === 'directory' ? available.filter(adapter => adapter.acceptsDirectoryProgram) : available
  const candidates = directoryAdapters.length > 0 ? directoryAdapters : available
  const selected = sortAdaptersForLaunch(program, candidates)[0]
  if (selected) return { kind: 'adapter', adapter: selected }
  const unavailable = rootMatches[0]
  return unavailable ? unavailableAdapter(unavailable, configs) : { kind: 'none' }
}

function sortAdaptersForLaunch(
  program: string,
  adapters: DapResolvedAdapter[],
): DapResolvedAdapter[] {
  const extension = path.extname(program).toLowerCase()
  return adapters
    .map(adapter => ({
      adapter,
      hasExtensionMatch: extension.length > 0 && adapter.fileTypes.includes(extension),
      hasRootMatch: adapter.rootMarkers.length > 0,
    }))
    .sort((left, right) => {
      if (left.hasExtensionMatch !== right.hasExtensionMatch) {
        return left.hasExtensionMatch ? -1 : 1
      }
      if (left.hasRootMatch !== right.hasRootMatch) {
        return left.hasRootMatch ? -1 : 1
      }
      const leftRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(left.adapter.name)
      const rightRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(right.adapter.name)
      const normalizedLeftRank = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank
      const normalizedRightRank = rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank
      const rankDelta = normalizedLeftRank - normalizedRightRank
      if (rankDelta !== 0) return rankDelta
      return left.adapter.name.localeCompare(right.adapter.name)
    })
    .map(entry => entry.adapter)
}

/** Selects a launch adapter or reports why matching configuration cannot run.
 * @param program - the launch program path (or name).
 * @param cwd - the working directory to resolve against.
 * @param ctx - resolution context (resolveExecutable + signal).
 * @param listDir - list a directory's entries (for root-marker scans).
 * @param adapterName - optional explicit adapter name to use.
 * @param programKind - the program kind (file/directory/missing).
 * @returns the launch selection.
 */
export async function selectLaunchAdapter(
  program: string,
  cwd: string,
  ctx: Pick<DapResolveContext, 'resolveExecutable' | 'signal'>,
  listDir: (p: string) => Promise<string[]>,
  adapterName?: string,
  programKind: LaunchProgramKind = 'file',
): Promise<LaunchAdapterSelection> {
  const configs = await getAdapterConfigs(cwd)
  if (adapterName) {
    const config = configs[adapterName]
    if (!config) return { kind: 'none' }
    const adapter = await resolveAdapterForLaunch(adapterName, configs, cwd, ctx)
    return adapter ? { kind: 'adapter', adapter } : { kind: 'unavailable', adapterName, command: config.command }
  }
  return selectAutomaticLaunchAdapter(program, cwd, programKind, configs, ctx, listDir)
}

/** Selects an attach adapter: explicit name, or the first installed default.
 * @param cwd - the working directory to scan for config files.
 * @param ctx - resolution context (resolveExecutable + signal).
 * @param adapterName - optional explicit adapter name.
 * @param port - optional TCP port (biases toward debugpy).
 * @returns the resolved adapter, or null.
 */
export async function selectAttachAdapter(
  cwd: string,
  ctx: Pick<DapResolveContext, 'resolveExecutable' | 'signal'>,
  adapterName?: string,
  port?: number,
): Promise<DapResolvedAdapter | null> {
  if (adapterName) {
    return resolveAdapter(adapterName, cwd, ctx)
  }
  const available = await getAvailableAdapters(cwd, ctx)
  if (port !== undefined) {
    const debugpy = available.find(adapter => adapter.name === 'debugpy')
    if (debugpy) return debugpy
  }
  for (const preferred of EXTENSIONLESS_DEBUGGER_ORDER) {
    const match = available.find(adapter => adapter.name === preferred)
    if (match) return match
  }
  return available[0] ?? null
}

/** Best-effort classification of a launch program as a file or directory.
 * @param program - the launch program path (or name).
 * @param cwd - the working directory to resolve against.
 * @param lstat - stat a path, or null when it does not exist.
 * @returns the coarse program kind.
 */
export async function classifyProgram(
  program: string,
  cwd: string,
  lstat: (p: string) => Promise<{ isDirectory(): boolean } | null>,
): Promise<LaunchProgramKind> {
  const resolved = path.resolve(cwd, program)
  try {
    const entry = await lstat(resolved)
    if (entry !== null && entry.isDirectory()) return 'directory'
  } catch {
    /* treat unresolvable/missing as a file */
  }
  return 'file'
}

/**
 * Compute adapter-specific launch arguments that depend on the resolved
 * program. Returned values are spread over `adapter.launchDefaults` so they
 * take precedence over the static defaults but can still be overridden by the
 * fields `DapSessionManager.launch` sets explicitly (program, cwd, args).
 *
 * Currently scoped to dlv, where `mode` selects how the program path is
 * interpreted: directories and `.go` source files debug as a Go package
 * (`mode=debug`), anything else is treated as a compiled binary (`mode=exec`).
 * @param adapter - the resolved adapter.
 * @param program - the launch program path.
 * @param programKind - the program kind.
 * @returns adapter-specific launch overrides keyed by argument name.
 */
export function resolveLaunchOverrides(
  adapter: DapResolvedAdapter,
  program: string,
  programKind: LaunchProgramKind,
): Record<string, unknown> {
  if (adapter.name === 'dlv') {
    const extension = path.extname(program).toLowerCase()
    if (programKind === 'directory' || extension === '.go') {
      return { mode: 'debug' }
    }
    if (programKind === 'file') {
      return { mode: 'exec' }
    }
  }
  return {}
}
