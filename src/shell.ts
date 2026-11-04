/**
 * The `ctx.shell` implementation for a WSL distribution.
 *
 * A command runs inside the already-running in-distro agent (`channel.ts`), so
 * the whole Windows-side spawn problem disappears: no `wsl.exe` per command, no
 * relay interpreter, no ConPTY, no login-shell argv mangling. `wsl.exe --exec
 * <node> agent.mjs` is spawned once and every later command is a JSON line.
 *
 * That is also why there is no PTY tier: a pipe into `bash -c` inside the
 * distribution is already the real thing, and the reference plugin's ~1,700
 * lines of relay/PTY/readiness machinery existed only to serve a ConPTY through
 * an Electron binary that writes nothing.
 * @module dsh-wsl/shell
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import {
  ShellExecutor,
  type CollectedOutput,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellExecution,
  type ShellProcessRead,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { channelFor, ChannelError, type Channel } from './channel.ts'
import { parseUnc, resolveAddress, type Address } from './paths.ts'

/** Default command timeout, matching the host's bash tool default. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Hard ceiling on a caller's timeout. */
export const MAX_TIMEOUT_MS = 600_000

/** Default stdout capture budget for a foreground command. */
export const DEFAULT_OUTPUT_BYTES = 64_000

/**
 * Environment entries forced on every command. A dumb terminal keeps tools from
 * emitting escape sequences the transcript cannot show, and the pagers are
 * pinned so a paging tool can never block a captured pipe.
 */
const ENV_OVERRIDES: Readonly<Record<string, string>> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

/** Configuration for the WSL shell executor. */
export interface Config {
  /** Distribution to run in when a workdir does not name one. */
  distro?: string
  /** The `node` executable inside the distribution. Defaults to `node`. */
  nodePath?: string
  /** Default working directory inside the distribution. Defaults to `/`. */
  cwd?: string
  /** Default command timeout in milliseconds. */
  timeoutMs?: number
  /** Hard ceiling on a request timeout in milliseconds. */
  maxTimeoutMs?: number
  /** Default stdout capture budget in bytes. */
  maxOutputBytes?: number
}

/** One command's captured output, reassembled from the agent's chunks. */
class Capture {
  #chunks: string[] = []
  #bytes = 0
  readonly limit: number
  truncated = false
  /** Total characters ever accepted, so an offset can be told from the tail. */
  pushed = 0

  constructor(limit: number) {
    this.limit = limit
  }

  /** Accept a chunk, keeping the tail when the budget overruns. */
  push(text: string): void {
    if (text === '') return
    this.pushed += text.length
    this.#chunks.push(text)
    this.#bytes += text.length
    while (this.#bytes > this.limit && this.#chunks.length > 1) {
      const head = this.#chunks.shift()!
      this.#bytes -= head.length
      this.truncated = true
    }
    if (this.#chunks.length === 1 && this.#bytes > this.limit) {
      const only = this.#chunks[0]!
      const cut = this.#bytes - this.limit
      this.#chunks[0] = only.slice(cut)
      this.#bytes = this.limit
      this.truncated = true
    }
  }

  /** The captured text. */
  get text(): string {
    return this.#chunks.join('')
  }

  /** Characters dropped from the head of the stream. */
  get dropped(): number {
    return this.pushed - this.#bytes
  }

  /**
   * The text that arrived at or after whole-stream offset `from`.
   *
   * Consuming readers must use this rather than slicing `text` by their own
   * counter: once the head is dropped the retained text stops growing, so a
   * raw `slice(last)` returns '' forever and the tail is never delivered.
   */
  since(from: number): string {
    const text = this.text
    const dropped = this.dropped
    const at = Math.min(Math.max(0, from - dropped), text.length)
    return text.slice(at)
  }

  /** The batch projection of this capture. */
  get collected(): CollectedOutput {
    return this.truncated ? { text: this.text, truncated: true } : { text: this.text, truncated: false }
  }
}

/** A non-consuming offset reader over a capture that is still growing. */
function readerOf(capture: Capture): SubprocessOutputReader {
  return {
    readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } {
      const text = capture.text
      const dropped = capture.dropped
      // Offsets are whole-stream coordinates; the capture retains only a tail,
      // so an offset below the retained window can only be answered as lossy.
      const lossy = fromByte < dropped
      const from = Math.min(Math.max(0, fromByte - dropped), text.length)
      return { text: text.slice(from), nextOffset: capture.pushed, lossy }
    },
  }
}

/**
 * The WSL shell executor.
 *
 * Members are TypeScript `private`, never `#private`: cordis hands a service out
 * through a `Proxy`, and reading a `#name` field with that proxy as the receiver
 * throws `Receiver must be an instance of class WslShellExecutor`. Every tool in
 * a real session reaches this service as `ctx.shell`, so a real `#` member here
 * breaks every command while direct-instantiation tests stay green.
 */
export class WslShellExecutor extends ShellExecutor {
  static Config: z<Config> = z.object({
    distro: z.string().default(''),
    nodePath: z.string().default('node'),
    cwd: z.string().default('/'),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
    maxTimeoutMs: z.number().default(MAX_TIMEOUT_MS),
    maxOutputBytes: z.number().default(DEFAULT_OUTPUT_BYTES),
  })

  /** Validated config (schemastery applied the defaults before construction). */
  readonly config: Required<Config>

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Apply the schema here as well as in the loader: a directly constructed
    // executor (tests, a host that wires the service by hand) would otherwise
    // carry `undefined` for every defaulted field, and `Math.min(timeout, undefined)`
    // silently disables the command timeout instead of failing.
    this.config = WslShellExecutor.Config(config) as Required<Config>
  }

  /**
   * Commands are not confined by this executor: the WSL VM is the isolation
   * boundary, and the harness cannot enforce Windows ACLs across it. Reporting a
   * mode here would be a claim the executor cannot keep, which is exactly the
   * mismatch dsh-wsl-workspace#78 ran into.
   */
  override get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /** The address a workdir or a configured default names. */
  private base(workdir?: string): Address {
    const configured = this.config.distro ? { distro: this.config.distro, path: this.config.cwd } : undefined
    if (workdir) {
      const resolved = resolveAddress(workdir, configured)
      if (resolved?.distro) return resolved
    }
    if (configured) return configured
    const fromWorkdir = workdir ? parseUnc(workdir) : undefined
    if (fromWorkdir) return fromWorkdir
    throw new ChannelError(
      `cannot tell which WSL distribution to run in${workdir ? ` for ${workdir}` : ''}; configure one or run from a WSL workspace`,
      'ENODISTRO',
    )
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = Math.min(request.timeoutMs ?? this.config.timeoutMs, this.config.maxTimeoutMs)
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd,
      timeoutMs,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const address = this.base(spec.workdir)
    const channel: Channel = await channelFor(address.distro, this.config.nodePath)

    // `resolve()` fills `stdoutMaxBytes`, but `execute()` is public and a caller
    // may hand it a bare request. Without the fallback the limit would be
    // `undefined`, every `bytes > limit` comparison would be false, and a
    // runaway command could buffer its entire output in memory.
    const stdout = new Capture(spec.stdoutMaxBytes ?? this.config.maxOutputBytes)
    const stderr = new Capture(this.config.maxOutputBytes)
    // A stdout-limited foreground command still gets a bounded stderr; the two
    // budgets are separate because a command's diagnostics are usually small.
    const env: Record<string, string> = { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }

    // First cause wins: whichever of the deadline or the caller's signal fires
    // first classifies the run, so the result can never report both.
    let timedOut = false
    let aborted = spec.signal?.aborted === true
    let settled = false

    const state: {
      status: 'running' | 'completed' | 'killed'
      exitCode: number | null
      signal: NodeJS.Signals | null
    } = { status: 'running', exitCode: null, signal: null }

    let settle: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    const release = (): void => {
      if (settled) return
      settled = true
      settle()
    }

    const request = {
      op: 'exec' as const,
      cmd: spec.command,
      cwd: address.path,
      env,
      ...(spec.stdin !== undefined ? { in: Buffer.from(spec.stdin, 'utf8').toString('base64') } : {}),
      ...(spec.onExpiry === 'kill' && spec.timeoutMs > 0 ? { timeout: spec.timeoutMs } : {}),
    }

    const { id, reply } = channel.begin(
      request,
      undefined,
      // The channel's own deadline must not race the command's: the command's
      // timeout is the one that classifies a result, so the transport waits.
      0,
      (stream, text) => {
        if (stream === 'o') stdout.push(text)
        else stderr.push(text)
      },
    )

    const kill = (): void => {
      if (state.status !== 'running') return
      state.status = 'killed'
      // The agent kills the whole process group, so a pipeline dies together.
      void channel.call({ op: 'kill', target: id }).catch(() => undefined)
    }

    const onAbort = (): void => {
      if (state.status !== 'running') return
      aborted = true
      kill()
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    if (aborted) onAbort()

    const resultPromise = reply.then(
      (final) => {
        spec.signal?.removeEventListener('abort', onAbort)
        if (!final.ok) {
          // An infrastructure failure: the caller must see this as a rejection.
          state.status = 'killed'
          release()
          throw new ChannelError(final.message ?? 'exec failed', final.code ?? 'EIO')
        }
        if (state.status === 'running') {
          state.status = final.signal || final.timedOut ? 'killed' : 'completed'
        }
        state.exitCode = final.code_ ?? null
        state.signal = (final.signal as NodeJS.Signals | undefined) ?? null
        if (final.timedOut) timedOut = true
        release()

        const result: ShellRunResult = {
          exitCode: state.exitCode,
          signal: state.signal,
          timedOut,
          aborted: aborted && !timedOut,
          timeoutMs: spec.timeoutMs,
          stdout: stdout.collected,
          stderr: stderr.collected,
        }
        return result
      },
      (error: unknown) => {
        spec.signal?.removeEventListener('abort', onAbort)
        state.status = 'killed'
        release()
        throw error
      },
    )

    // Mark the rejection handled at creation. A background handle may never have
    // `result()` called on it (the jobs registry polls a running job without
    // awaiting it), and Node turns an unobserved rejection into a fatal throw —
    // which would take the whole harness process down, not just this command.
    // Attaching a reaction here only silences that trap: callers still receive
    // the rejection when they do await `result()`, because `result()` hands back
    // this same promise.
    void resultPromise.catch(() => undefined)

    let result: Promise<ShellRunResult> | undefined
    let lastStdout = 0
    let lastStderr = 0

    const execution: ShellExecution = {
      get status() {
        return state.status
      },
      get exitCode() {
        return state.exitCode
      },
      get signal() {
        return state.signal
      },
      done,
      readOutput: (): ShellProcessRead => {
        // Consuming read in WHOLE-STREAM offsets. Counting against `text.length`
        // would stall forever once the head is dropped: the retained text never
        // grows past the budget again, so the delta stays empty while the job
        // keeps producing output.
        const outDelta = stdout.since(lastStdout)
        const errDelta = stderr.since(lastStderr)
        lastStdout = stdout.pushed
        lastStderr = stderr.pushed
        const separator = outDelta.length > 0 && !outDelta.endsWith('\n') ? '\n' : ''
        return {
          delta: outDelta + (errDelta.length > 0 ? `${separator}[stderr]\n${errDelta}` : ''),
          lossy: stdout.truncated || stderr.truncated,
        }
      },
      observed: {
        stdout: readerOf(stdout),
        stderr: readerOf(stderr),
      },
      kill: (): boolean => {
        if (state.status !== 'running') return false
        kill()
        return true
      },
      result: (): Promise<ShellRunResult> => {
        result ??= resultPromise
        return result
      },
    }

    return execution
  }
}

export default WslShellExecutor
