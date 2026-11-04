/**
 * The `grep` and `glob` tools, running ripgrep INSIDE the distribution.
 *
 * The harness ships both tools in `@deepseek-ai/dsh-tool-fs-search`, which
 * spawns its own packaged Windows ripgrep binary through `ctx.subprocess`. Over
 * the 9P share that binary is functionally correct and practically useless:
 * measured on this machine, `rg --files` across a home directory took 44 s
 * against 0.29 s in-distro, a content search 150 s against 0.79 s — and on the
 * large walk it returned roughly half the files, silently, while emitting
 * `ETIMEDOUT`. So a WSL variant must not use it. It must not go without
 * either: without these tools the model can only reach file contents through a
 * `bash` command, which is exactly the "works but not really" gap this plugin
 * exists to close.
 *
 * ## Why a provider rather than a shell command
 *
 * The row mounts inside `wsl-world`, so it resolves `shell`/`fs` the way every
 * other world row does and takes the distribution from the session path. The
 * search itself is one `exec` on the persisted channel: `rg` is already on PATH
 * in the distribution (ripgrep 15.x on Ubuntu 24.04+), the process is a child of
 * the agent rather than of `wsl.exe`, and no second spawn costs 200 ms.
 *
 * ## Injection
 *
 * Every model-supplied value reaches the command line through
 * {@link shq}, a POSIX single-quote escape. The two that could be mistaken for
 * flags ride in `--flag=value` form and the search target follows `--`, so a
 * value beginning with `-` is data, not an option.
 * @module dsh-wsl/search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { channelFor } from './channel.ts'
import { parseUnc, toPosix } from './paths.ts'

export const name = 'search-wsl'

/** One `grep` hit. */
interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

/** Matches kept inline. Beyond this the reply reports the total instead. */
const MAX_MATCHES = 250

/** Paths kept inline by one `glob` call. */
const MAX_PATHS = 100

/** Longest matched line kept, in characters. */
const MAX_LINE = 2_000

/** Wall-clock budget for one search. */
const TIMEOUT_MS = 120_000

/**
 * Wrap a value as one POSIX shell word.
 *
 * Single quotes suppress every expansion, so the only character needing care is
 * the quote itself: close, emit an escaped quote, reopen. Nothing else — `$`,
 * backticks, `\`, newlines — is special inside single quotes.
 * @param value - the raw value.
 * @returns the quoted word.
 */
export function shq(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

/** Where one search runs: a distribution and a directory inside it. */
interface Target {
  distro: string
  cwd: string
}

/**
 * Resolve the search target from a session cwd, mirroring the shell and
 * filesystem providers: a UNC path names its own distribution, and an absolute
 * Linux path uses the configured one.
 * @param cwd - the calling session's cwd.
 * @param configured - the world's pinned distribution, when any.
 * @returns the target, or `undefined` when the session is not in a WSL world.
 */
export function resolveTarget(cwd: string | undefined, configured?: string): Target | undefined {
  if (!cwd) return undefined
  const unc = parseUnc(cwd)
  if (unc) return { distro: unc.distro, cwd: unc.path }
  const pinned = configured?.trim()
  if (pinned && cwd.startsWith('/')) return { distro: pinned, cwd: toPosix(cwd) }
  return undefined
}

/**
 * Express a model-supplied path in Linux coordinates.
 *
 * A UNC path becomes its Linux form and a Windows drive path becomes
 * `/mnt/<drive>`, the same translation the file tools apply — so `grep
 * path='D:\proj'` searches what `read D:\proj\a.ts` reads.
 * @param path - the tool call's `path`, when given.
 * @returns the path to hand ripgrep.
 */
export function linuxTarget(path: string | undefined): string {
  if (path === undefined || path === '') return '.'
  const unc = parseUnc(path)
  if (unc) return unc.path
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (drive) return toPosix(`/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`)
  return path
}

/** Reject an `include` that is a list or a negation, as the shipped tool does. */
function checkInclude(include: string): void {
  if (include.trim() === '') throw new Error('include must be a non-empty glob when given')
  if (include.startsWith('!')) {
    throw new Error('include must be a positive glob filter; negated patterns are not supported')
  }
  let depth = 0
  for (const char of include) {
    if (char === '{') depth += 1
    else if (char === '}') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) {
      throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation)')
    }
  }
}

/** Parse one `rg --json` line; `undefined` for record types that are not a match. */
function matchOf(line: string): GrepMatch | undefined {  let record: { type?: string; data?: Record<string, unknown> }
  try {
    record = JSON.parse(line) as typeof record
  } catch {
    // A truncated tail from a capped capture is not a match either.
    return undefined
  }
  if (record.type !== 'match' || typeof record.data !== 'object' || record.data === null) return undefined
  const data = record.data as {
    path?: { text?: string }
    line_number?: number
    lines?: { text?: string }
  }
  const path = data.path?.text
  const lineNumber = data.line_number
  if (typeof path !== 'string' || typeof lineNumber !== 'number') return undefined
  const text = data.lines?.text
  // Non-UTF-8 lines arrive as base64 `bytes` instead of `text`; a placeholder
  // beats failing the whole search over one binary file.
  return { path, lineNumber, line: typeof text === 'string' ? text.replace(/\n$/, '') : '' }
}

/** Truncate one line without splitting a surrogate pair. */
function clip(line: string): string {
  if (line.length <= MAX_LINE) return line
  const head = Array.from(line).slice(0, MAX_LINE).join('')
  return `${head}…`
}

/**
 * The tools registry face this plugin registers on.
 *
 * `dsh-tools` is not a plugin dependency (it is a preset row, and a world
 * without it must still load), so it is read through `ctx.get` and typed here.
 */
interface ToolsFace {
  register(definition: unknown): () => void
}

/** A tool execution, as much of it as search needs. */
interface ExecFace {
  agent?: { session: { header: { cwd?: string } } }
  signal: AbortSignal
}

/** Render `grep` hits as text, the same shape the shipped tool produces. */
function renderMatches(matches: GrepMatch[], total: number): ContentBlock[] {
  if (matches.length === 0) return [{ type: 'text', text: 'No matches.' }]
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const list = byFile.get(match.path)
    if (list) list.push(match)
    else byFile.set(match.path, [match])
  }
  const blocks: string[] = []
  for (const [path, hits] of byFile) {
    blocks.push(`${path}:`)
    for (const hit of hits) blocks.push(`${hit.lineNumber}:${clip(hit.line)}`)
    blocks.push('')
  }
  if (total > matches.length) {
    blocks.push(`[${total} matches; showing the first ${matches.length}]`)
  }
  return [{ type: 'text', text: blocks.join('\n').trimEnd() }]
}

/**
 * Register the two tools and their prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param config - the world's pinned distribution, when one was configured.
 */
export function apply(ctx: Context, config?: { distro?: string }): void {
  const tools = ctx.get('tools') as unknown as ToolsFace | undefined
  if (tools === undefined) return
  const pinned = config?.distro

  const targetOf = (exec: ExecFace): Target => {
    const target = resolveTarget(exec.agent?.session.header.cwd, pinned)
    if (target === undefined) {
      throw new Error('grep and glob are only available in a WSL workspace session')
    }
    return target
  }

  /**
   * Run one command through the channel and return its stdout.
   *
   * Output arrives as `exec` chunk replies on the same request, so it must be
   * collected through `begin`'s callback — `call` would resolve on the exit
   * facts and throw the text away.
   *
   * Ripgrep's exit codes are 0 (matched), 1 (nothing matched) and 2 (an error
   * worth reporting). Exit 2 is NOT all-or-nothing: a tree with one unreadable
   * directory — `/etc/credstore`, `~/.ssh`, any root-owned subdirectory —
   * still yields every other match and still exits 2. Failing the call there
   * would replace the share's silent under-reporting with a hard refusal to
   * search at all, so results are kept and only a run with nothing to show is
   * reported as an error, carrying ripgrep's own reason.
   */
  const run = async (target: Target, command: string, signal: AbortSignal): Promise<string> => {
    const channel = await channelFor(target.distro)
    let stdout = ''
    let stderr = ''
    const { reply } = channel.begin(
      { op: 'exec', cmd: command, cwd: target.cwd, timeout: TIMEOUT_MS },
      signal,
      0,
      (stream, text) => {
        if (stream === 'o') stdout += text
        else stderr += text
      },
    )
    const final = await reply
    if (!final.ok) throw new Error(final.message ?? 'search failed')
    // A killed search is a failure, not an empty result: reporting "no matches"
    // would tell the model a question was answered when it was not.
    if (final.timedOut) throw new Error(`search timed out after ${TIMEOUT_MS} ms`)
    if (final.code_ === 0 || final.code_ === 1) return stdout
    if (stdout.trim() !== '') return stdout
    const reason = stderr.trim().split('\n').slice(0, 3).join('; ')
    throw new Error(
      `ripgrep exited ${final.code_ ?? 'on a signal'}${reason === '' ? '' : `: ${reason}`}`,
    )
  }

  const grep = defineTool({
    name: 'grep',
    description:
      'Search file contents inside this WSL distribution with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Regular expression to search for (ripgrep syntax).',
      },
      path: {
        type: 'string',
        description: 'File or directory to search. Defaults to the session workspace.',
      },
      include: {
        type: 'string',
        description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}").',
      },
    },
    timeoutMs: TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args: unknown, value: { matches: GrepMatch[]; total: number }) =>
        renderMatches(value.matches, value.total),
    },
    async execute(
      args: { pattern: string; path?: string; include?: string },
      exec: ExecFace,
    ): Promise<{ matches: GrepMatch[]; total: number }> {
      if (args.pattern === '') throw new Error('pattern must be a non-empty string')
      if (args.include !== undefined) checkInclude(args.include)
      const target = targetOf(exec)
      const parts = ['rg', '--json', `--regexp=${shq(args.pattern)}`]
      if (args.include !== undefined) parts.push(`--glob=${shq(args.include)}`)
      parts.push('--', shq(linuxTarget(args.path)))
      const stdout = await run(target, parts.join(' '), exec.signal)
      const all: GrepMatch[] = []
      for (const line of stdout.split('\n')) {
        if (line === '') continue
        const match = matchOf(line)
        if (match) all.push(match)
      }
      return { matches: all.slice(0, MAX_MATCHES), total: all.length }
    },
  })

  const glob = defineTool({
    name: 'glob',
    description:
      'Find files, not directories, whose paths match a glob pattern inside this WSL distribution. Returns paths in modification-time order.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description:
          'Glob pattern to match file paths against (e.g. "**/*.ts"). A pattern with no "/" matches the basename at any depth.',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to the session workspace.',
      },
    },
    timeoutMs: TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args: unknown, value: { paths: string[]; total: number }) => {
        if (value.paths.length === 0) return [{ type: 'text', text: 'No files matched.' }]
        const text = value.paths.join('\n')
        return [
          {
            type: 'text',
            text:
              value.total > value.paths.length
                ? `${text}\n[${value.total} files; showing the first ${value.paths.length}]`
                : text,
          },
        ]
      },
    },
    async execute(
      args: { pattern: string; path?: string },
      exec: ExecFace,
    ): Promise<{ root: string; paths: string[]; total: number }> {
      if (args.pattern === '') throw new Error('pattern must be a non-empty string')
      const target = targetOf(exec)
      const root = linuxTarget(args.path)
      // `--files` with a glob is the only reliable "paths only" mode: `-l`
      // would stop at the first hit per file and hide the rest.
      const command = [
        'rg',
        '--files',
        `--glob=${shq(args.pattern)}`,
        '--sort=modified',
        '--no-ignore',
        '--hidden',
        '--glob=!**/.git/*',
        '--glob=!**/node_modules/*',
        '--',
        shq(root),
      ].join(' ')
      const stdout = await run(target, command, exec.signal)
      const all = stdout.split('\n').filter((line) => line !== '')
      return { root, paths: all.slice(0, MAX_PATHS), total: all.length }
    },
  })

  ctx.effect(() => tools.register(grep), 'dsh-wsl: grep tool')
  ctx.effect(() => tools.register(glob), 'dsh-wsl: glob tool')

  // Without the tool the guidance is noise, so it is gated on the registration.
  const prompts = ctx.get('systemPrompt') as unknown as
    | { section(section: unknown): () => void; getSectionOrder(name: string): number }
    | undefined
  if (prompts) {
    prompts.section({
      name: 'tool:grep',
      order: prompts.getSectionOrder('TOOL_GREP'),
      text: 'Use the grep and glob tools — not shell grep, rg, or find — to search files inside WSL.',
    })
  }
}
