/**
 * The `ctx.fs` backend for a WSL distribution.
 *
 * Every operation goes to the in-distro agent (`channel.ts`), which is why this
 * backend needs no symlink workaround and no drvfs rerouting: it sees the
 * distribution's own filesystem, so `/mnt/c` is an ordinary directory, and a
 * `realpath` is the distribution's own answer rather than a reconstruction.
 *
 * Identity is realpath-derived, so two spellings of one file share a stale
 * guard. Versions come from inode identity (`proto.versionOf`), which means an
 * unchanged file keeps its version across reads and a replace changes it.
 * @module dsh-wsl/fs
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsWriteIntent,
  type FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { ChannelError, channelFor } from './channel.ts'
import { containsPosix, parseUnc, resolveAddress, toUnc, type Address } from './paths.ts'
import { versionOf, type AgentStat } from './proto.ts'

/**
 * Largest file this backend will decode as text. Above it the caller must use
 * `readBytes`, which is the seam's own guidance: a backend must never buffer an
 * unbounded file.
 */
export const MAX_TEXT_BYTES = 16 * 1024 * 1024

/** Configuration for the WSL filesystem backend. */
export interface Config {
  /** Distribution to serve when a path does not name one. */
  distro?: string
  /** The `node` executable inside the distribution. Defaults to `node`. */
  nodePath?: string
  /** Base for relative paths inside the distribution. Defaults to `/`. */
  cwd?: string
}

/** Decode UTF-8 strictly: a file that is not UTF-8 is not text. */
function decodeText(buffer: Uint8Array, displayPath: string): string {
  if (buffer.includes(0)) {
    throw new FsError(`${displayPath} is binary (contains NUL)`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new FsError(`${displayPath} is not valid UTF-8`, 'FS_NOT_TEXT')
  }
}

/** Classify a `stat` mode into the seam's type vocabulary. */
function typeOf(st: AgentStat): 'file' | 'directory' | 'other' {
  if (st.dir) return 'directory'
  return (st.mode & 0o170000) === 0o100000 ? 'file' : 'other'
}

/** Translate a channel failure into the filesystem error taxonomy. */
function asFsError(error: unknown, displayPath: string): FsError {
  if (error instanceof FsError) return error
  const code = error instanceof ChannelError ? error.code : 'EIO'
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'ENOENT':
      return new FsError(`${displayPath}: no such file or directory`, 'FS_NOT_FOUND', { cause: error })
    case 'ENOTDIR':
      return new FsError(`${displayPath}: not a directory`, 'FS_NOT_DIRECTORY', { cause: error })
    case 'EISDIR':
      return new FsError(`${displayPath}: is a directory`, 'FS_NOT_REGULAR_FILE', { cause: error })
    case 'EACCES':
    case 'EPERM':
      return new FsError(`${displayPath}: permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
    case 'EABORTED':
      return new FsError(`${displayPath}: aborted`, 'FS_ABORTED', { cause: error })
    default:
      return new FsError(`${displayPath}: ${message}`, 'FS_IO_ERROR', { cause: error })
  }
}

/** Count non-overlapping literal occurrences. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

/** True when `text` uses CRLF throughout (no bare LF, at least one CRLF). */
function isCrlf(text: string): boolean {
  return text.includes('\r\n') && !/(^|[^\r])\n/.test(text)
}

/** The diff basis the seam reports: LF, whatever the file really holds. */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Re-apply CRLF so an edit keeps the file's on-disk line endings. */
function toCrlf(text: string): string {
  return toLf(text).replace(/\n/g, '\r\n')
}

/**
 * The WSL filesystem backend.
 *
 * Members are TypeScript `private`, never `#private`: cordis hands a service out
 * through a `Proxy`, and reading a `#name` field with that proxy as the receiver
 * throws `Receiver must be an instance of class WslFileSystem`. Tools reach this
 * service as `ctx.fs`, so a real `#` member breaks every read while
 * direct-instantiation tests stay green.
 */
export class WslFileSystem extends FileSystem {
  static Config: z<Config> = z.object({
    distro: z.string().default(''),
    nodePath: z.string().default('node'),
    cwd: z.string().default('/'),
  })

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: Required<Config>

  /** Per-targetKey tail: serializes mutations so a read→guard→write window
   * cannot interleave. Two concurrent edits then resolve deterministically —
   * one wins, the other sees the new version and reports `FS_STALE_VERSION`. */
  private locks = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Defaults are applied here too: a directly constructed backend would
    // otherwise hold `undefined` for `nodePath`/`cwd`, and the agent spawn or
    // the address resolution would fail at the first call instead of at load.
    this.config = WslFileSystem.Config(config) as Required<Config>
  }

  /**
   * WSL distributions isolate at the VM boundary and this backend adds no path
   * fencing of its own, so it reports no default mode — the honest answer,
   * matching `dsh-fs-local`. A session's `sandboxPolicy` still reaches
   * {@link writeText} and {@link editText}, which honour it per call.
   */
  override get sandboxMode(): undefined {
    return undefined
  }

  /** Run `op` with exclusive access to `key` (FIFO per key). */
  private async withLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(op, op)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  /**
   * The address a target names. A target's `displayPath` is always the UNC form
   * this backend minted, so it carries the whole address — no side table to
   * grow and no way for a stale entry to outlive its file.
   */
  private address(target: FsTarget): Address {
    const parsed = parseUnc(target.displayPath)
    if (parsed) return parsed
    throw new FsError(`target ${target.displayPath} is not a WSL path`, 'FS_NOT_FOUND')
  }

  /** The base address relative paths resolve against. */
  private base(): Address | undefined {
    return this.config.distro ? { distro: this.config.distro, path: this.config.cwd } : undefined
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const base = this.base()
    const seeded = opts?.cwd ? (parseUnc(opts.cwd) ?? resolveAddress(opts.cwd, base)) : base
    const address = resolveAddress(path, seeded)
    if (!address?.distro) {
      throw new FsError(
        `cannot tell which WSL distribution "${path}" belongs to; use a UNC path or configure one`,
        'FS_NOT_FOUND',
      )
    }

    const channel = await channelFor(address.distro, this.config.nodePath)
    let real: string
    try {
      real = (await channel.ok({ op: 'realpath', p: address.path }, opts?.signal)).path!
    } catch (error) {
      // A path that does not exist yet still needs a target: a guarded create
      // starts from an absent target. Canonicalize its parent instead.
      if (error instanceof ChannelError && error.code === 'ENOENT') {
        real = await this.canonicalizeAbsent(channel, address.path, opts?.signal)
      } else {
        throw asFsError(error, toUnc(address.distro, address.path))
      }
    }

    return {
      targetKey: FsTargetKey(toUnc(address.distro, real)),
      displayPath: toUnc(address.distro, real),
    }
  }

  /** Canonicalize a path whose final component does not exist yet. */
  private async canonicalizeAbsent(
    channel: Awaited<ReturnType<typeof channelFor>>,
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const slash = path.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : path.slice(0, slash)
    const name = path.slice(slash + 1)
    try {
      const real = (await channel.ok({ op: 'realpath', p: parent }, signal)).path!
      return real === '/' ? `/${name}` : `${real}/${name}`
    } catch {
      return path
    }
  }

  override processPath(target: FsTarget): string {
    return this.address(target).path
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    return resolveAddress(hostPath, this.base())?.path
  }

  override fileUrl(target: FsTarget): string {
    const address = this.address(target)
    // The distribution's mount table is invisible from here, so the URI is
    // file://<distro>/<path> — the `vscode-remote` convention, which is what
    // makes the URI meaningful outside this plugin.
    const segments = address.path.split('/').map(encodeURIComponent).join('/')
    return `file://${encodeURIComponent(address.distro)}${segments}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const a = this.address(parent)
    const b = this.address(child)
    return a.distro === b.distro && containsPosix(a.path, b.path)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const address = this.address(target)
    const channel = await channelFor(address.distro, this.config.nodePath)
    try {
      const st = (await channel.ok({ op: 'stat', p: address.path }, signal)).st!
      const info: FsInfo = { version: FsVersion(versionOf(st)), type: typeOf(st) }
      if (!st.dir) info.size = st.size
      return info
    } catch (error) {
      if (error instanceof ChannelError && error.code === 'ENOENT') return undefined
      throw asFsError(error, target.displayPath)
    }
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    const base = this.base()
    const seeded = opts?.cwd ? (parseUnc(opts.cwd) ?? resolveAddress(opts.cwd, base)) : base
    const address = resolveAddress(path, seeded)
    if (!address?.distro) {
      throw new FsError(`cannot tell which WSL distribution "${path}" belongs to`, 'FS_NOT_FOUND')
    }
    const channel = await channelFor(address.distro, this.config.nodePath)
    try {
      // Path-shaped, not target-shaped: this must NOT follow the final link,
      // which is the whole reason it takes a path instead of a target.
      const st = (await channel.ok({ op: 'lstat', p: address.path }, signal)).st!
      const info: FsPathInfo = {
        version: FsVersion(versionOf(st)),
        type: st.link ? 'symlink' : typeOf(st),
      }
      if (!st.dir) info.size = st.size
      return info
    } catch (error) {
      if (error instanceof ChannelError && error.code === 'ENOENT') return undefined
      throw asFsError(error, toUnc(address.distro, address.path))
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const info = await this.stat(target, signal)
    if (!info) throw new FsError(`${target.displayPath}: no such file`, 'FS_NOT_FOUND')
    if (info.type === 'directory') {
      throw new FsError(`${target.displayPath}: is a directory`, 'FS_NOT_REGULAR_FILE')
    }
    if (info.size !== undefined && info.size > MAX_TEXT_BYTES) {
      throw new FsError(`${target.displayPath}: ${info.size} bytes exceeds the text limit`, 'FS_TOO_LARGE')
    }
    const address = this.address(target)
    const channel = await channelFor(address.distro, this.config.nodePath)
    try {
      const reply = await channel.ok({ op: 'read', p: address.path }, signal)
      return decodeText(Buffer.from(reply.data!, 'base64'), target.displayPath)
    } catch (error) {
      throw asFsError(error, target.displayPath)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // ponytail: one whole-file read yielded as a single chunk. The channel is
    // request/reply, so chunking buys the caller nothing today; switch to a
    // range loop if a genuinely huge text read appears.
    const text = await this.readText(target, signal)
    return (async function* () {
      yield text
    })()
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const info = await this.stat(target, signal)
    if (!info) throw new FsError(`${target.displayPath}: no such file`, 'FS_NOT_FOUND')
    if (info.type === 'directory') {
      throw new FsError(`${target.displayPath}: is a directory`, 'FS_NOT_REGULAR_FILE')
    }
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(
        `${target.displayPath}: ${info.size} bytes exceeds the ${maxBytes} byte cap`,
        'FS_TOO_LARGE',
      )
    }
    // One byte beyond the cap so an unstatable size still cannot overshoot.
    const bytes = await this.readByteRange(target, { offset: 0, length: maxBytes + 1 }, signal)
    if (bytes.length > maxBytes) {
      throw new FsError(`${target.displayPath}: exceeds the ${maxBytes} byte cap`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const address = this.address(target)
    const channel = await channelFor(address.distro, this.config.nodePath)
    try {
      const reply = await channel.ok(
        { op: 'readRange', p: address.path, offset: range.offset, length: range.length },
        signal,
      )
      return new Uint8Array(Buffer.from(reply.data!, 'base64'))
    } catch (error) {
      throw asFsError(error, target.displayPath)
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const address = this.address(target)
    const channel = await channelFor(address.distro, this.config.nodePath)
    try {
      const entries = (await channel.ok({ op: 'readdir', p: address.path }, signal)).entries!
      // The agent already sorted by name, and types come from `dirent`, so a
      // listing is one round-trip regardless of how many children it has.
      return entries.map((entry) => {
        const path = address.path === '/' ? `/${entry.n}` : `${address.path}/${entry.n}`
        return {
          name: entry.n,
          type: entry.d ? 'directory' : 'file',
          target: {
            targetKey: FsTargetKey(toUnc(address.distro, path)),
            displayPath: toUnc(address.distro, path),
          },
        } satisfies FsDirEntry
      })
    } catch (error) {
      throw asFsError(error, target.displayPath)
    }
  }

  /** Refuse a mutation the per-call sandbox policy forbids. */
  private fence(target: FsTarget, policy: SandboxExecutionPolicy | undefined): void {
    if (!policy || policy.mode === 'danger-full-access') return
    const address = this.address(target)
    if (policy.mode === 'read-only') {
      throw new FsError(
        `${target.displayPath}: read-only sandbox mode forbids writes`,
        'FS_SANDBOX_DENIED',
      )
    }
    // workspace-write: the write must land inside the session's workspace root.
    // A root that cannot be mapped into this distribution denies rather than
    // silently allowing — an unmappable root must never widen the fence.
    const root = policy.workspaceRoot ? resolveAddress(policy.workspaceRoot, address) : undefined
    if (!root || root.distro !== address.distro || !containsPosix(root.path, address.path)) {
      throw new FsError(
        `${target.displayPath}: outside the workspace root ${policy.workspaceRoot ?? '(none)'}`,
        'FS_SANDBOX_DENIED',
      )
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    this.fence(target, sandboxPolicy)
    return await this.withLock(target.targetKey as string, async () =>
      await this.write(target, content, expected, signal),
    )
  }

  /** The write itself, assuming the caller already holds the target's lock. */
  private async write(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    {
      const address = this.address(target)
      const channel = await channelFor(address.distro, this.config.nodePath)
      const current = await this.stat(target, signal)

      let before: string | null = null
      if (expected?.kind === 'createIfAbsent' && current) {
        throw new FsError(`${target.displayPath}: already exists`, 'FS_NOT_OBSERVED')
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!current) throw new FsError(`${target.displayPath}: no such file`, 'FS_STALE_VERSION')
        if (current.version !== expected.version) {
          throw new FsError(`${target.displayPath}: changed since it was read`, 'FS_STALE_VERSION')
        }
      }
      if (current?.type === 'file') {
        // The diff basis the caller needs. A binary or oversized prior file
        // leaves `before` null, which is exactly what the seam documents.
        before = await this.readText(target, signal).catch(() => null)
        if (before !== null) before = toLf(before)
      }

      // WRITE WHAT THE CALLER GAVE US. The seam's LF normalization is about the
      // `before`/`after` REPORT (the diff basis), never the bytes on disk: a
      // repository may legitimately hold CRLF files (`gitattributes eol=crlf`,
      // Windows-authored scripts), and silently rewriting one whole file to LF
      // because a caller wrote a single line through `editText` is data loss
      // dressed up as normalization.
      try {
        const reply = await channel.ok(
          { op: 'write', p: address.path, data: Buffer.from(content, 'utf8').toString('base64') },
          signal,
        )
        return {
          operation: current ? 'update' : 'create',
          version: FsVersion(versionOf(reply.st!)),
          before,
          after: toLf(content),
        }
      } catch (error) {
        throw asFsError(error, target.displayPath)
      }
    }
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    this.fence(target, sandboxPolicy)
    if (edit.oldString === '') {
      throw new FsError(`${target.displayPath}: oldString must not be empty`, 'FS_EDIT_NOT_FOUND')
    }
    return await this.withLock(target.targetKey as string, async () => {
      const info = await this.stat(target, signal)
      if (!info) throw new FsError(`${target.displayPath}: no such file`, 'FS_NOT_FOUND')
      // The guard is checked before matching, so a stale caller gets one code.
      if (expected && info.version !== expected.version) {
        throw new FsError(`${target.displayPath}: changed since it was read`, 'FS_STALE_VERSION')
      }

      const raw = await this.readText(target, signal)
      // Match and rebuild on an LF basis, then restore the file's own line
      // endings before storing: a caller editing one line of a CRLF file must
      // not have the other lines rewritten underneath it.
      const crlf = isCrlf(raw)
      const before = toLf(raw)
      const oldString = toLf(edit.oldString)
      const newString = toLf(edit.newString)
      const occurrences = countOccurrences(before, oldString)
      if (occurrences === 0) {
        throw new FsError(`${target.displayPath}: oldString not found`, 'FS_EDIT_NOT_FOUND')
      }
      if (occurrences > 1 && !edit.replaceAll) {
        throw new FsError(
          `${target.displayPath}: oldString matches ${occurrences} times; set replaceAll or add context`,
          'FS_AMBIGUOUS_EDIT',
        )
      }

      const after = edit.replaceAll
        ? before.split(oldString).join(newString)
        : before.replace(oldString, () => newString)

      const stored = crlf ? toCrlf(after) : after
      const written = await this.write(target, stored, { kind: 'replaceIfVersion', version: info.version }, signal)
      return { version: written.version, before, after }
    })
  }
}

export default WslFileSystem
