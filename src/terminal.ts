/**
 * Let the sidebar terminal enter the distribution.
 *
 * The sidebar terminal is not the `terminals` registry the model tools use:
 * `terminalController` asks the session's `subprocess` service for
 * `spawnTerminal()`, so a terminal enters WSL only if that provider launches a
 * shell inside the distribution. A preset cannot supply such a provider —
 * `subprocess` is a single-slot service, an isolated group's provider is
 * invisible to `agent.ctx`, and a second registration at preset scope is
 * rejected ("Preset services require isolate realms"). So the host provider is
 * wrapped in place instead, and only `spawnTerminal` is touched.
 *
 * `spawnTerminal({cwd})` already carries the per-session discriminator, so a
 * WSL session is recognised by its UNC cwd and every other caller — a Windows
 * session's terminal, shell discovery, `workspace-changes`, PTC runners —
 * passes through untouched. `resolveExecutable` and `terminalEnvironment` are
 * deliberately left alone: they answer host-wide questions ("where is bash on
 * this machine") whose Windows answer must stay true.
 *
 * The launch keeps the host's ConPTY and puts `wsl.exe` in front of the shell,
 * an arrangement probes confirmed round-trips input, output, and resize into
 * the distribution's own pty.
 * @module dsh-wsl/terminal
 */

import type { Context } from '@deepseek-ai/cordis'
import { parseUnc } from './paths.ts'

/** A terminal spawn request, as much of it as this module reads. */
export interface TerminalSpec {
  argv: readonly string[]
  cwd: string
  env?: Record<string, string> | undefined
  rows: number
  cols: number
  terminalType: string
  shellActivity?: boolean | undefined
  graceMs: number
  signal?: AbortSignal | undefined
}

/** The slice of the host `subprocess` provider this module wraps. */
interface SubprocessFace {
  spawnTerminal: (spec: TerminalSpec) => Promise<unknown>
}

/**
 * One patch per host provider, ref-counted so two mounts unwind cleanly.
 */
const PATCHED = new WeakMap<object, { original: SubprocessFace['spawnTerminal']; refs: number }>()

/**
 * Rewrite a spawn request so the shell starts inside the session's
 * distribution; a request whose cwd is not a WSL path is left alone.
 * @param spec - the request the host provider received.
 * @returns the rewritten request, or `undefined` to pass the original through.
 */
export function wslLaunch(spec: TerminalSpec): TerminalSpec | undefined {
  const address = parseUnc(spec.cwd)
  if (address === undefined) return undefined
  return {
    ...spec,
    // A Windows process cannot hold a UNC directory as its working directory,
    // so `cwd` stays a Windows path and `--cd` is what places the shell where
    // the session actually is.
    argv: ['wsl.exe', '-d', address.distro, '--cd', address.path, '--', shellOf(spec.argv), ...spec.argv.slice(1)],
    cwd: process.env['USERPROFILE'] ?? 'C:\\',
    env: { ...spec.env, TERM: spec.terminalType },
  }
}

/** POSIX shells that may be asked for by their Windows basename. */
const POSIX_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'])

/**
 * Pick the shell to run inside the distribution.
 *
 * The requested `argv[0]` was resolved against the WINDOWS PATH — on this
 * machine a Git-for-Windows `bash.exe` — so its path cannot be used; only the
 * shell's own name carries over, and only when the distribution plausibly has
 * it. Anything else falls back to `/bin/bash`.
 * @param argv - the argv the controller built.
 * @returns an absolute path inside the distribution.
 */
function shellOf(argv: readonly string[]): string {
  const first = argv[0] ?? ''
  const name = first.slice(Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\')) + 1).replace(/\.exe$/i, '')
  return POSIX_SHELLS.has(name.toLowerCase()) ? `/bin/${name.toLowerCase()}` : '/bin/bash'
}

/**
 * Wrap the host `subprocess` provider so terminals follow their session into WSL.
 * @param ctx - host context, where the single `subprocess` provider lives.
 */
export function applyTerminal(ctx: Context): void {
  ctx.inject(['subprocess'], (ctx: Context) => {
    const subprocess = ctx.get('subprocess') as unknown as SubprocessFace
    const existing = PATCHED.get(subprocess)
    if (existing !== undefined) {
      existing.refs += 1
      ctx.effect(() => () => {
        existing.refs -= 1
        if (existing.refs > 0) return
        subprocess.spawnTerminal = existing.original
        PATCHED.delete(subprocess)
      }, 'dsh-wsl: restore terminal spawn')
      return
    }
    // `spawnTerminal` is reached through the service proxy, so it is captured
    // and called with the provider as receiver — its implementation reads its
    // own instance state.
    const inner = subprocess.spawnTerminal
    subprocess.spawnTerminal = spec => inner.call(subprocess, wslLaunch(spec) ?? spec)
    PATCHED.set(subprocess, { original: inner, refs: 1 })
    ctx.effect(() => () => {
      const entry = PATCHED.get(subprocess)
      if (entry === undefined) return
      entry.refs -= 1
      if (entry.refs > 0) return
      subprocess.spawnTerminal = entry.original
      PATCHED.delete(subprocess)
    }, 'dsh-wsl: restore terminal spawn')
  })
}
