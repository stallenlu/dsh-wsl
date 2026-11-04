#!/usr/bin/env node
/**
 * The in-distro agent: one long-lived Node process inside the WSL distribution
 * that answers filesystem and shell requests over a JSON-lines pipe.
 *
 * It exists because the two obvious alternatives are both wrong. The UNC 9P
 * share costs 3–4 ms per metadata call and cannot serve `/mnt/<drive>` at all;
 * a fresh `wsl.exe` spawn costs 200–280 ms. One persisted process on the far
 * side of the boundary costs ~0.2 ms per call for both, which is what makes
 * fine-grained tool calls (stat before every edit, list before every read)
 * affordable.
 *
 * Plain JS with no dependencies on purpose: it must run against whatever
 * `node` the distribution happens to have, with no install step.
 *
 * Framing: one JSON object per line, in both directions, every reply echoing
 * its request `id`. Nothing is written to stdout except replies — diagnostics
 * go to stderr, which the host discards (`wsl.exe` pollutes it with a GBK
 * proxy notice on every invocation).
 */

import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import fs from 'node:fs'
import { dirname } from 'node:path'

/** Longest single reply line the agent will build; guards against a runaway read. */
const MAX_LINE = 96 * 1024 * 1024

/** Longest single `exec` output chunk the agent emits. */
const CHUNK_MAX = 64 * 1024

/** Running execs, keyed by request id, so `kill` can reach them. */
const running = new Map()

/** Set once stdin closes; in-flight execs are killed and the process exits. */
let closing = false

/**
 * The login-shell environment, captured once.
 *
 * `wsl.exe --exec node` bypasses the login shell, so `process.env` here holds
 * the interop environment — which has a PATH, but not the user's PATH. Running
 * commands under that PATH would silently fail to find `~/.local/bin` tools.
 * One `bash -lc` at startup buys the right environment for every later exec,
 * at 1–2 ms per call instead of a login shell per call.
 * @type {Promise<Record<string, string>>}
 */
const loginEnv = captureLoginEnv()

async function captureLoginEnv() {
  return await new Promise((resolve) => {
    let out = ''
    const child = spawn('bash', ['-lc', 'env -0'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (out.length < 1024 * 1024) out += chunk
    })
    const done = () => {
      if (!out) return resolve(process.env)
      const merged = { ...process.env }
      for (const pair of out.split('\0')) {
        const eq = pair.indexOf('=')
        // A login shell re-declares HOME/USER/LOGNAME; those are the point.
        if (eq > 0) merged[pair.slice(0, eq)] = pair.slice(eq + 1)
      }
      resolve(merged)
    }
    child.on('error', () => resolve(process.env))
    child.on('close', done)
  })
}

/**
 * Reply to one request. Always writes exactly one line.
 * @param {object} reply
 */
function reply(reply) {
  if (closing) return
  let line
  try {
    line = JSON.stringify(reply)
  } catch (error) {
    line = JSON.stringify({ id: reply.id, ok: false, code: 'EBADREPLY', message: String(error) })
  }
  if (line.length > MAX_LINE) {
    line = JSON.stringify({
      id: reply.id,
      ok: false,
      code: 'ETOOBIG',
      message: `reply would exceed ${MAX_LINE} bytes`,
    })
  }
  // One write per reply: Node queues each write() as a unit, so concurrent
  // execs finishing together cannot interleave halfway through a line.
  process.stdout.write(line + '\n')
}

/**
 * Report a filesystem error as a stable errno name.
 * @param {number} id
 * @param {unknown} error
 */
function fail(id, error) {
  const code = /** @type {any} */ (error)?.code
  reply({
    id,
    ok: false,
    code: typeof code === 'string' ? code : 'EIO',
    message: String(/** @type {any} */ (error)?.message ?? error),
  })
}

/**
 * Metadata for a path, in the shape the host's version token is built from.
 * @param {string} p
 * @param {boolean} follow resolve the final symlink
 */
function statOf(p, follow) {
  const st = follow ? fs.statSync(p) : fs.lstatSync(p)
  return {
    mode: st.mode,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ino: Number(st.ino),
    ctimeMs: st.ctimeMs,
    dir: st.isDirectory(),
    link: st.isSymbolicLink(),
  }
}

/**
 * Run a shell command line and stream its output back as it arrives.
 *
 * Output is streamed rather than accumulated: a `bash` job can run for an hour
 * and the host must be able to show what it has printed so far. The host
 * reassembles the (capped) text, so the final reply carries only exit facts —
 * which also keeps a 1 MB capture from crossing the pipe twice.
 * @param {object} req
 */
async function exec(req) {
  const env = { ...(await loginEnv), ...(req.env ?? {}) }
  const started = Date.now()

  return await new Promise((resolve) => {
    let timedOut = false
    let settled = false
    let killedBy

    const child = spawn('bash', ['-c', req.cmd ?? ''], {
      cwd: req.cwd || env.HOME || '/',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A process group of its own, so a timeout kills the whole pipeline
      // rather than orphaning `bash`'s children.
      detached: true,
    })
    running.set(req.id, child)

    /**
     * Coalesce chunk text before emitting: a chatty command would otherwise
     * cost one JSON line per 64 KB pipe read, and `yes | head -c 10M` far more.
     */
    const pending = { o: '', e: '' }
    /** @type {NodeJS.Timeout | undefined} */
    let flushTimer
    const flush = () => {
      clearTimeout(flushTimer)
      flushTimer = undefined
      for (const stream of /** @type {const} */ (['o', 'e'])) {
        const text = pending[stream]
        if (text === '') continue
        pending[stream] = ''
        reply({ id: req.id, ev: stream, d: text })
      }
    }
    const emit = (stream, text) => {
      pending[stream] += text
      // Cap the coalescing window: `yes | head -c 100M` produces megabytes
      // faster than a timer can drain, and one huge line would stall the pipe.
      if (!flushTimer || pending[stream].length >= CHUNK_MAX) flush()
    }

    // A decoder per stream: a multi-byte character split across pipe reads
    // must not become two replacement characters in the host's buffer.
    const decoders = { o: new StringDecoder('utf8'), e: new StringDecoder('utf8') }
    child.stdout.on('data', (chunk) => emit('o', decoders.o.write(chunk)))
    child.stderr.on('data', (chunk) => emit('e', decoders.e.write(chunk)))

    const settle = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Flush before the reply so no text is ordered after the exit facts.
      pending.o += decoders.o.end()
      pending.e += decoders.e.end()
      flush()
      running.delete(req.id)
      reply({
        id: req.id,
        ok: true,
        code_: code,
        ms: Date.now() - started,
        timedOut,
        ...(signal ? { signal } : {}),
        ...(killedBy ? { killedBy } : {}),
      })
    }

    /** @type {NodeJS.Timeout | undefined} */
    let timer
    if (req.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, req.timeout)
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      running.delete(req.id)
      reply({ id: req.id, ok: false, code: 'ESPAWN', message: String(error) })
    })
    child.on('close', (code, signal) => settle(code, signal))

    if (req.in) {
      child.stdin.end(Buffer.from(req.in, 'base64'))
    } else {
      child.stdin.end()
    }
  })
}

/**
 * Kill a spawn's whole process group, falling back to the process itself when
 * the group signal fails (already reaped, or `setsid` unavailable).
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  const pid = child.pid
  if (!pid) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/**
 * Dispatch one request.
 * @param {object} req
 */
async function handle(req) {
  switch (req.op) {
    case 'ping':
      return reply({ id: req.id, ok: true, path: process.version })

    case 'realpath':
      return reply({ id: req.id, ok: true, path: fs.realpathSync(req.p) })

    case 'stat':
      return reply({ id: req.id, ok: true, st: statOf(req.p, true) })

    case 'lstat':
      return reply({ id: req.id, ok: true, st: statOf(req.p, false) })

    case 'readdir': {
      const entries = fs
        .readdirSync(req.p, { withFileTypes: true })
        .map((e) => ({ n: e.name, d: e.isDirectory(), l: e.isSymbolicLink() }))
        .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
      return reply({ id: req.id, ok: true, entries })
    }

    case 'read':
      return reply({ id: req.id, ok: true, data: fs.readFileSync(req.p).toString('base64') })

    case 'readRange': {
      const offset = req.offset ?? 0
      const length = req.length ?? 0
      const fd = fs.openSync(req.p, 'r')
      try {
        const buffer = Buffer.allocUnsafe(length)
        const read = fs.readSync(fd, buffer, 0, length, offset)
        return reply({ id: req.id, ok: true, data: buffer.subarray(0, read).toString('base64') })
      } finally {
        fs.closeSync(fd)
      }
    }

    case 'write': {
      const data = Buffer.from(req.data ?? '', 'base64')
      // Missing parents are created, matching the host's own file backend: a
      // write never fails merely because its directory was never announced.
      const dir = dirname(req.p)
      if (dir !== req.p) fs.mkdirSync(dir, { recursive: true })
      // A sibling temp file plus rename is the atomic publication that works
      // everywhere — same directory, same filesystem, no hardlink required.
      const tmp = `${req.p}.dsh-tmp-${process.pid}-${req.id}`
      fs.writeFileSync(tmp, data)
      try {
        fs.renameSync(tmp, req.p)
      } catch (error) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* best effort */
        }
        throw error
      }
      return reply({ id: req.id, ok: true, st: statOf(req.p, true) })
    }

    case 'mkdir':
      fs.mkdirSync(req.p, { recursive: true })
      return reply({ id: req.id, ok: true })

    case 'remove':
      fs.rmSync(req.p, { recursive: true, force: true })
      return reply({ id: req.id, ok: true })

    case 'kill': {
      const child = running.get(req.target)
      if (child) killTree(child)
      return reply({ id: req.id, ok: true })
    }

    case 'exec':
      return exec(req)

    default:
      return reply({ id: req.id, ok: false, code: 'EOP', message: `unknown op ${req.op}` })
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  if (!line) return
  /** @type {any} */
  let req
  try {
    req = JSON.parse(line)
  } catch {
    // A malformed line has no id to answer, so nothing can be paired with it.
    return
  }
  // Not awaited: requests are independent and may finish out of order. The
  // reply carries the id that re-pairs them.
  handle(req).catch((error) => fail(req.id, error))
})

input.on('close', () => {
  closing = true
  for (const child of running.values()) killTree(child)
  // Let queued replies drain, then leave.
  process.stdout.write('', () => process.exit(0))
})
