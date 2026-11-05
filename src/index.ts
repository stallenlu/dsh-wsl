/**
 * Host half of dsh-wsl.
 *
 * Three responsibilities, each one seam the host already publishes:
 *
 * 1. **Preset variants.** For every healthy roster preset, publish a
 *    `wsl-<mode>` variant whose `shell` and `fs` services are this plugin's
 *    in-distro implementations. The transform edits the parsed entry list, so
 *    it is blind to YAML indentation — the reference implementation matched row
 *    headers with `/^  name: (.+)$/` and therefore missed a delegation row
 *    nested six spaces deep inside a `cordis:group`, which is
 *    dsh-wsl-workspace#132.
 *
 * 2. **One browser route**, loopback-only, serving what the host's own remote
 *    surface does not: distribution discovery and Linux directory listing.
 *    Workspace creation goes through the host's durable `workspaceRegistry`, so
 *    there is no second store to drift out of sync.
 *
 * 3. **A `shellEnv` contributor** publishing `DSH_WSL_DISTRO` for a session
 *    whose cwd is a WSL path, so a plain Linux `workdir` reaches the right
 *    distribution.
 *
 * There is no poller anywhere in this file. The reference swept the UNC share
 * every 3 s and re-walked discovery every 30 s; each sweep is ~200 ms of 9P
 * traffic and, with WSLg enabled, resurrects the distribution and steals
 * foreground focus (dsh-wsl-workspace#130). Everything here is demand-driven
 * over the in-distro agent instead.
 *
 * @module dsh-wsl
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ChannelError, channelFor, closeAll } from './channel.ts'
import { clearHostGate, isWslVariantId, parseRows, transformVariant, variantIdFor } from './host/variants.ts'
import { parseUnc, resolveAddress, toUnc } from './paths.ts'
import { wslWorldGroup, type Row } from './rows.ts'
import { applyTerminal } from './terminal.ts'

export const name = 'dsh-wsl'

/**
 * `webServer` is required: the route is the browser's only channel to Linux
 * directory data. Everything else is looked up optionally through `ctx.get`,
 * because a degraded host (no presets, no workspace registry) must still load.
 */
export const inject = ['webServer']

/** Validated plugin config. */
export interface Config {
  /** HTTP path the browser dialog calls. */
  route: string
}

export const Config: z<Config> = z.object({
  route: z.string().default('/dsh-wsl/api'),
})

const DEFAULT_ROUTE = '/dsh-wsl/api'
const MAX_BODY_BYTES = 64 * 1024
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** `wsl.exe` writes UTF-16LE; decoding as UTF-8 yields NUL-interleaved garbage. */

// --- host seams this plugin consumes -------------------------------------
// Neither shape is published by the installed packages, so they are declared
// here against the live service. `ctx.get` returns `any`; these keep the
// structural checks honest at that one boundary and nowhere else.

interface WebServerRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

interface WebServerService {
  register(route: WebServerRoute): () => void
}

interface PresetsService {
  list(): Promise<{ id: string; name?: string; description?: string; order?: number; broken?: string }[]>
  readDocument(id: string): Promise<{ content: string; name?: string }>
  register(definition: PresetDefinition): Promise<() => Promise<void>>
}

interface ShellEnvContributor {
  name: string
  variables: Record<string, { description: string }>
  resolve(execution: { agent?: { session: { header: { cwd?: string } } } }): Record<string, string>
}

interface ShellEnvService {
  register(contributor: ShellEnvContributor): () => void
}

/**
 * The registry returns `WorkspaceEntity` instances whose readable fields are
 * GETTERS (`lib/index.js:76-100` in `@deepseek-ai/dsh-workspace`), so a raw
 * entity crossing this route's `JSON.stringify` boundary serializes only its
 * own data properties (`host`, `id`, `record`) and the client read
 * `workspace.title` as `undefined` — the "Added undefined" the dialog showed.
 * Every value is read on this side and returned as a plain object.
 */
function plainWorkspace(workspace: { id: unknown; path: unknown; title: unknown; createdAt?: unknown; updatedAt?: unknown }): {
  id: string
  path: string
  title: string
  createdAt?: string
  updatedAt?: string
} {
  return {
    id: String(workspace.id),
    path: String(workspace.path),
    title: String(workspace.title),
    ...(typeof workspace.createdAt === 'string' ? { createdAt: workspace.createdAt } : {}),
    ...(typeof workspace.updatedAt === 'string' ? { updatedAt: workspace.updatedAt } : {}),
  }
}

interface WorkspaceRegistryService {
  create(path: string, title?: string): Promise<{ id: string; path: string; title: string }>
  resolveByPath(path: string): Promise<{ id: string; path: string; title: string } | undefined>
}

// --- distribution discovery ----------------------------------------------

/** One installed distribution. */
export interface Distro {
  name: string
  default: boolean
}

/**
 * Decode `wsl.exe` stdout. The tool writes UTF-16LE by default, but honors
 * `WSL_UTF8=1` (Microsoft's documented switch) by writing UTF-8 instead —
 * including `-l -q`/`-l -v`, so `listDistros` must follow it. The environment
 * at THIS call decides, because `execFileSync` hands our own environment to
 * wsl.exe, so the same process that spawned the tool decodes it correctly.
 * Byte sniffing is not sound here: UTF-16LE of a non-ASCII name (`Ubuntu-测试`)
 * has non-zero high bytes and reads as plausible UTF-8.
 */
export function decodeWslOut(raw: Buffer): string {
  return process.env.WSL_UTF8 === '1' ? raw.toString('utf8') : raw.toString('utf16le')
}

function wsl(args: readonly string[]): string {
  return decodeWslOut(execFileSync('wsl.exe', args as string[], { windowsHide: true }))
}

/**
 * Installed distributions, default first.
 *
 * `-l -q` names them one per line; `-l -v` marks the default with `*`. The two
 * are joined by name rather than by column because a distribution name may
 * contain spaces (`Ubuntu 22.04`), which makes whitespace splitting unsafe.
 */
export function listDistros(): Distro[] {
  let quiet: string
  try {
    quiet = wsl(['-l', '-q'])
  } catch {
    // No WSL installed, or the optional component is off: an empty list is the
    // truthful answer, not a route failure.
    return []
  }
  const names = quiet
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  let verbatim = ''
  try {
    verbatim = wsl(['-l', '-v'])
  } catch {
    /* the default marker is a nicety; every distro is still listed */
  }
  const marked = verbatim
    .split(/\r?\n/)
    .filter((line) => /^\s*\*/.test(line))
    .map((line) => line.replace(/^\s*\*\s*/, ''))
  const isDefault = (distro: string): boolean => marked.some((rest) => rest === distro || rest.startsWith(`${distro} `))
  const distros = names.map((distro) => ({ name: distro, default: isDefault(distro) }))
  const first = distros.findIndex((distro) => distro.default)
  if (first > 0) distros.unshift(...distros.splice(first, 1))
  return distros
}

// --- route ---------------------------------------------------------------

/** One directory entry as the browser dialog reads it. */
interface DirEntry {
  name: string
  dir: boolean
  link: boolean
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function hostOf(req: IncomingMessage): string {
  const header = req.headers.host
  if (typeof header !== 'string') return ''
  const colon = header.lastIndexOf(':')
  return (colon === -1 ? header : header.slice(0, colon)).replace(/^\[|\]$/g, '').toLowerCase()
}

/** The route reads privileged configuration, so it stays on loopback. */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = (req.socket.remoteAddress ?? '').toLowerCase()
  return LOOPBACK.has(address) && LOOPBACK.has(hostOf(req))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function messageOf(error: unknown): string {
  if (error instanceof ChannelError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value === '') throw new Error(`"${field}" must be a non-empty string`)
  return value
}

/**
 * The dialog's operations.
 *
 * `listDir` and `check` go through the in-distro agent (~0.2 ms per call)
 * rather than the 9P share (~4 ms), and `/mnt/<drive>` therefore needs no
 * special case: drvfs is an ordinary mounted filesystem from inside the
 * distribution and invisible from the Windows side.
 */
async function dispatch(ctx: Context, method: string, body: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'listDistros':
      return { distros: listDistros() }

    case 'listDir': {
      const distro = requireString(body, 'distro')
      const path = requireString(body, 'path')
      const channel = await channelFor(distro)
      const entries = (await channel.ok({ op: 'readdir', p: path })).entries ?? []
      const list: DirEntry[] = entries.map((entry) => ({ name: entry.n, dir: entry.d, link: entry.l }))
      list.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      return { path, entries: list }
    }

    case 'check': {
      const distro = requireString(body, 'distro')
      const path = requireString(body, 'path')
      const channel = await channelFor(distro)
      try {
        const stat = (await channel.ok({ op: 'stat', p: path })).st
        return { exists: true, dir: stat?.dir === true }
      } catch (error) {
        if (error instanceof ChannelError && error.code === 'ENOENT') return { exists: false, dir: false }
        // Anything else (EACCES, EIO, channel death) is a real failure and must
        // not be reported as "absent" — that would hide a broken distribution.
        throw error
      }
    }

    case 'createWorkspace': {
      const distro = requireString(body, 'distro')
      const path = requireString(body, 'path')
      const unc = toUnc(distro, path)
      const registry = ctx.get('workspaceRegistry') as unknown as WorkspaceRegistryService | undefined
      if (registry === undefined) throw new Error('this host exposes no workspace registry')
      const existing = await registry.resolveByPath(unc)
      if (existing !== undefined) return { workspace: plainWorkspace(existing), created: false }
      return { workspace: plainWorkspace(await registry.create(unc)), created: true }
    }

    default:
      throw new Error(`unknown method "${method}"`)
  }
}

// --- preset variants -----------------------------------------------------

/**
 * Rows that must move INSIDE the world group.
 *
 * This is the point of the group: a row that consumes `shell` or `fs` and
 * stays outside it keeps resolving the host's Windows services. PowerShell
 * rows are left out — there is no `pwsh` inside the distribution — and so is
 * `tool-fs-search`: it spawns the PACKAGED Windows ripgrep binary, which over
 * 9P took 44 s where the in-distro binary took 0.29 s and silently missed
 * roughly half a large tree. `search-wsl` registers `grep`/`glob` in the world
 * group instead.
 */
const CONSUMER_ROWS: ReadonlySet<string> = new Set([
  'tool-bash',
  'tool-fs',
  'str-replace-editor',
  'tool-str-replace-editor',
])

/** Collect the consumer rows a preset declares, in order, wherever they sit. */
function consumersOf(rows: readonly Row[]): Row[] {
  const found: Row[] = []
  const walk = (list: readonly Row[]): void => {
    for (const row of list) {
      const id = row['id']
      if (typeof id === 'string' && CONSUMER_ROWS.has(id)) {
        // The gate tests the platform the loader runs on — Windows — not the world
        // the row is about to live in. Left in place it would disable the tool.
        clearHostGate(row)
        found.push(row)
        continue
      }
      const config = row['config']
      if (Array.isArray(config)) walk(config as Row[])
    }
  }
  walk(rows)
  return found
}

/**
 * Whether the plugin's fiber is still alive.
 *
 * cordis clears `fiber.uid` to `null` on disposal and every lifecycle call
 * (`ctx.effect`, `ctx.on`, …) throws once that happened. A detached async task
 * cannot assume otherwise: `materialize()` awaits the preset registry, and the
 * fiber can be disposed while those awaits are in flight.
 * @param ctx - the plugin's context.
 * @returns `true` while effects may still be created on it.
 */
function stillActive(ctx: Context): boolean {
  const fiber = (ctx as { fiber?: { uid: number | null } }).fiber
  // A context without a fiber is a caller's stub, not a disposed plugin: the
  // only question worth asking is whether a REAL fiber has been torn down.
  return fiber === undefined ? true : fiber.uid !== null
}

/**
 * Publish one variant per healthy preset.
 *
 * Failures are per-preset and non-fatal: a single unreadable composition must
 * not cost every other mode its WSL world.
 */
export async function materialize(
  ctx: Context,
  presets: PresetsService,
): Promise<{ produced: string[]; failed: { id: string; reason: string }[] }> {
  const produced: string[] = []
  const failed: { id: string; reason: string }[] = []
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  // The loader hands a non-relative module name straight to `import()`, and a
  // bare Windows path (`C:/…/lib/shell.js`) has no URL scheme to accept —
  // `ERR_UNSUPPORTED_ESM_URL_SCHEME`. A `file://` href is the form that loads.
  const entry = (name: string): string => pathToFileURL(join(packageRoot, 'lib', name)).href
  const world = (consumers: Row[]): Row => {
    const group = wslWorldGroup({
      shell: entry('shell.js'),
      fs: entry('fs.js'),
      search: entry('search.js'),
    })
    // The group serves whichever distribution the path names, so ONE variant
    // covers every distro — adding a distro needs no republish.
    ;(group['config'] as Row[]).push(...consumers)
    return group
  }

  for (const preset of await presets.list()) {
    if (preset.broken !== undefined || isWslVariantId(preset.id)) continue
    // This runs detached from the plugin's lifecycle, so the fiber can be gone
    // by now — a boot-time HMR reload or a profile rewrite disposes it while
    // the awaits above are still in flight. Registering more presets then only
    // creates rows nothing will ever retire.
    if (!stillActive(ctx)) break
    const id = variantIdFor(preset.id)
    try {
      const document = await presets.readDocument(preset.id)
      const rows = parseRows(document.content)
      const transformed = transformVariant(document.content, { world: [world(consumersOf(rows))] })
      const problem = entryListProblem(transformed.rows)
      if (problem !== undefined) throw new Error(`invalid composition: ${problem}`)
      const definition: PresetDefinition = {
        id,
        name: document.name ?? preset.name ?? preset.id,
        description: 'The same agent, with its shell and file tools running inside WSL.',
        ...(preset.order === undefined ? {} : { order: preset.order }),
        plugins: transformed.rows as unknown as PresetDefinition['plugins'],
      }
      const dispose = await presets.register(definition)
      // `ctx.effect` throws INACTIVE_EFFECT once the fiber is disposed. Catching
      // it as a preset failure would be a lie — the preset IS registered — and
      // would leak it, because the disposer is the effect's cleanup. Retire it
      // here instead and stop.
      try {
        ctx.effect(() => () => void dispose(), `dsh-wsl: retire preset ${id}`)
      } catch (error) {
        await dispose()
        console.warn(`dsh-wsl: preset ${id} retired unreachable: ${messageOf(error)}`)
        break
      }
      produced.push(id)
    } catch (error) {
      failed.push({ id, reason: messageOf(error) })
    }
  }
  if (failed.length > 0) {
    console.warn(`dsh-wsl: ${failed.length} preset variant(s) not published`)
    for (const entry of failed) console.warn(`dsh-wsl:   ${entry.id}: ${entry.reason}`)
  }
  return { produced, failed }
}

// --- plugin entry --------------------------------------------------------

export function apply(ctx: Context, config: Config): void {
  const route = config.route === '' ? DEFAULT_ROUTE : config.route

  ctx.effect(() => {
    const server = ctx.get('webServer') as unknown as WebServerService | undefined
    if (server === undefined) return () => {}
    return server.register({
      kind: 'exact',
      path: route,
      async handler(req, res) {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'use POST' })
          return
        }
        if (!isLoopbackRequest(req)) {
          json(res, 403, { ok: false, error: 'loopback only' })
          return
        }
        let body: Record<string, unknown>
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>
        } catch (error) {
          json(res, 400, { ok: false, error: messageOf(error) })
          return
        }
        const method = typeof body['method'] === 'string' ? body['method'] : ''
        try {
          json(res, 200, { ok: true, value: await dispatch(ctx, method, body) })
        } catch (error) {
          json(res, 200, { ok: false, error: messageOf(error) })
        }
      },
    })
  }, 'dsh-wsl: browser route')

  const presets = ctx.get('agentPresets') as unknown as PresetsService | undefined
  if (presets !== undefined && typeof presets.readDocument === 'function') {
    ctx.effect(() => {
      void materialize(ctx, presets).catch((error: unknown) => {
        console.error(`dsh-wsl: preset variants failed: ${messageOf(error)}`)
      })
      return () => {}
    }, 'dsh-wsl: preset variants')
  }

  const shellEnv = ctx.get('shellEnv') as unknown as ShellEnvService | undefined
  if (shellEnv !== undefined && typeof shellEnv.register === 'function') {
    ctx.effect(
      () =>
        shellEnv.register({
          name: 'dsh-wsl',
          variables: {
            DSH_WSL_DISTRO: {
              description: 'The WSL distribution behind the calling session workspace, when its cwd is a WSL path.',
            },
          },
          resolve(execution) {
            const cwd = execution.agent?.session.header.cwd
            if (cwd === undefined) return {}
            const address = parseUnc(cwd) ?? resolveAddress(cwd)
            return address === undefined ? {} : { DSH_WSL_DISTRO: address.distro }
          },
        }),
      'dsh-wsl: DSH_WSL_DISTRO',
    )
  }

  applyTerminal(ctx)

  ctx.effect(() => () => void closeAll(), 'dsh-wsl: close agent channels')
}
