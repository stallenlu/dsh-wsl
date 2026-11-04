/**
 * Wire protocol between the harness host and the in-distro agent
 * (`agent/agent.mjs`).
 *
 * One JSON object per line on both pipes, each request carrying an `id` that
 * its reply echoes. That is the whole framing: the channel is a pipe inside
 * one distro, so no length prefix, no escaping layer, no multiplexing header.
 * Binary payloads ride as base64 in the `data` field.
 *
 * This module is shared by the host side only — the agent is plain JS and
 * restates the shapes it answers. `tests/protocol.test.ts` holds the two ends
 * to the same table.
 * @module dsh-wsl/proto
 */

/** Operations the agent answers. */
export type Op =
  | 'ping'
  | 'realpath'
  | 'stat'
  | 'lstat'
  | 'readdir'
  | 'read'
  | 'readRange'
  | 'write'
  | 'remove'
  | 'mkdir'
  | 'exec'
  | 'kill'

/** A request line. `op` selects the handler; unused fields are ignored. */
export interface Request {
  id: number
  op: Op
  /** Path operand, already absolute in the distro. */
  p?: string
  /** Exec command line, run through `bash -c` in the distro. */
  cmd?: string
  /** Working directory for `exec`. */
  cwd?: string
  /** Extra environment for `exec`, merged over the agent's own. */
  env?: Record<string, string>
  /** stdin for `exec`, base64. Written then closed. */
  in?: string
  /** Timeout for `exec` in milliseconds; the child is killed at expiry. */
  timeout?: number
  /** Byte offset for `readRange`. */
  offset?: number
  /** Byte count for `readRange`. */
  length?: number
  /** Payload for `write`, base64. */
  data?: string
  /** Per-stream capture cap for `exec` output, in bytes. */
  max?: number
  /** Target request id for `kill`. */
  target?: number
}

/** Metadata the agent reports for a path. */
export interface AgentStat {
  /** Raw `stat(2)` mode bits. */
  mode: number
  /** Size in bytes. */
  size: number
  /** Modification time in milliseconds (fractional). */
  mtimeMs: number
  /** Inode number — half of the version identity. */
  ino: number
  /** Inode generation/change counter, when the platform reports one. */
  ctimeMs?: number
  /** True for a directory. */
  dir: boolean
  /** True for a symbolic link (only `lstat` reports this). */
  link: boolean
}

/** One directory child as reported by `readdir`. */
export interface AgentEntry {
  /** Basename. */
  n: string
  /** Directory flag (from `dirent`, no extra stat). */
  d: boolean
  /** Symlink flag (from `dirent`, no extra stat). */
  l: boolean
}

/** A reply line. `ok` decides which fields are meaningful. */
export interface Reply {
  id: number
  ok: boolean
  /** Stable failure code: an errno name, or one of the agent-local codes. */
  code?: string
  /** Human-readable failure detail. */
  message?: string
  /** Path result for `realpath`. */
  path?: string
  /** Metadata for `stat` / `lstat`. */
  st?: AgentStat
  /** Children for `readdir`, already in name order. */
  entries?: AgentEntry[]
  /** base64 bytes for `read` / `readRange`. */
  data?: string
  /** Exit code for `exec`; null when signal-killed. */
  code_?: number | null
  /**
   * Set on an `exec` output chunk: `'o'` for stdout, `'e'` for stderr, with
   * the text in `d`. A chunk reply is not the operation's reply — the request
   * stays outstanding until the exit reply arrives.
   */
  ev?: 'o' | 'e'
  /** Output text for a chunk reply (`ev`). */
  d?: string
  /** Terminating signal name, when the command died from one. */
  signal?: string
  /** Wall time the command took, in milliseconds. */
  ms?: number
  /** True when the timeout killed the command. */
  timedOut?: boolean
  /** Set when the host asked for the command to be killed (a `kill` request). */
  killedBy?: string
}

/** Agent-local failure codes that are not errno names. */
export const CODE = {
  /** The operation name is not in the table. */
  unknownOp: 'EOP',
  /** The agent could not serialize a reply. */
  badReply: 'EBADREPLY',
  /** The channel closed before a reply arrived. */
  channelClosed: 'ECHANNEL',
  /** The request exceeded the channel's own deadline. */
  timeout: 'ETIMEDOUT',
  /** The caller's signal aborted the request or the channel is shutting down. */
  aborted: 'EABORTED',
} as const

/** Default per-stream capture cap for `exec`. */
export const DEFAULT_MAX_BYTES = 1024 * 1024

/**
 * The version token for a file, derived from the identity fields the kernel
 * already maintains. Any write changes `mtimeMs`; a replace changes `ino`;
 * a same-millisecond rewrite of the same size on a filesystem with coarse
 * timestamps is the one case this cannot see, which is why `ctimeMs` is folded
 * in when the agent reports it.
 * @param st - the reported metadata.
 * @returns a stable, opaque version string.
 */
export function versionOf(st: AgentStat): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs ?? 0}`
}
