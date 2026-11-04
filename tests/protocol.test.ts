/**
 * Wire-protocol checks: the two ends of `proto.ts` and `agent/agent.mjs` held
 * to the same table, plus the framing rules (one JSON line per reply, `id`
 * echoed, out-of-order settling, failure codes) exercised against the real
 * agent process on this machine.
 *
 * The agent is plain JS with no dependencies, so it runs on the host too —
 * which is what lets this test cover framing everywhere, while the ops that
 * genuinely need bash (`exec`) stay in `live.test.ts`.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, test } from 'node:test'
import { CODE, DEFAULT_MAX_BYTES, versionOf, type Reply } from '../src/proto.ts'

const root = new URL('..', import.meta.url)
const protoSource = readFileSync(new URL('src/proto.ts', root), 'utf8')
const agentSource = readFileSync(new URL('agent/agent.mjs', root), 'utf8')

/** Ops the `Op` union in `src/proto.ts` declares. */
function declaredOps(): string[] {
  const union = /\nexport type Op =([\s\S]*?)\n\n/.exec(protoSource)
  assert.ok(union, 'could not find the Op union in src/proto.ts')
  return [...union[1]!.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]!).sort()
}

/** Ops `agent/agent.mjs` actually answers, read off its switch. */
function answeredOps(): string[] {
  return [...agentSource.matchAll(/^ {4}case '([A-Za-z]+)':/gm)].map((match) => match[1]!).sort()
}

test('both ends answer exactly the same op table', () => {
  const declared = declaredOps()
  const answered = answeredOps()
  // A one-sided addition is the defect this guards: the host would send an op
  // the agent answers with EOP, or the agent would grow a handler nothing calls.
  assert.deepEqual(answered, declared)
  assert.ok(declared.length >= 12, `only ${declared.length} ops found`)
})

test('the agent-local failure codes match what the agent emits', () => {
  for (const code of Object.values(CODE)) {
    if (code === CODE.channelClosed || code === CODE.timeout || code === CODE.aborted) continue
    assert.ok(agentSource.includes(`'${code}'`), `agent never emits ${code}`)
  }
})

/** A real agent process on this machine, spoken to over its own pipes. */
function startAgent() {
  const child = spawn(process.execPath, [new URL('agent/agent.mjs', root).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const waiting = new Map<number, (reply: Reply) => void>()
  const chunks: Reply[] = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (!line) return
    const reply = JSON.parse(line) as Reply
    if (reply.ev) {
      chunks.push(reply)
      return
    }
    waiting.get(reply.id)?.(reply)
    waiting.delete(reply.id)
  })
  let nextId = 1
  return {
    child,
    chunks,
    ask(request: Record<string, unknown>): Promise<Reply> {
      const id = nextId++
      return new Promise((resolve) => {
        waiting.set(id, resolve)
        child.stdin.write(JSON.stringify({ ...request, id }) + '\n')
      })
    },
  }
}

const agent = startAgent()
after(() => agent.child.kill())

test('a reply echoes its request id and carries no framing noise', async () => {
  const reply = await agent.ask({ op: 'ping' })
  assert.equal(reply.ok, true)
  assert.equal(typeof reply.id, 'number')
  // `path` on a ping is the interpreter version — proof the far side is node.
  assert.match(reply.path ?? '', /^v\d+\./)
})

test('an unknown op fails with EOP instead of dropping the request', async () => {
  const reply = await agent.ask({ op: 'definitely-not-an-op' })
  assert.equal(reply.ok, false)
  assert.equal(reply.code, CODE.unknownOp)
  assert.match(reply.message ?? '', /unknown op/)
})

test('a malformed line is ignored and the channel keeps serving', async () => {
  agent.child.stdin.write('{not json\n')
  const reply = await agent.ask({ op: 'ping' })
  assert.equal(reply.ok, true)
})

test('concurrent requests settle independently and out of order', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-wsl-proto-'))
  writeFileSync(join(directory, 'note.txt'), 'hello\n')
  // Fire a fast op and a slower one together; both must come back on their own
  // id, because the channel pairs replies by id rather than by arrival order.
  const [readdir, ping] = await Promise.all([
    agent.ask({ op: 'readdir', p: directory.replace(/\\/g, '/') }),
    agent.ask({ op: 'ping' }),
  ])
  assert.equal(readdir.ok, true)
  assert.equal(ping.ok, true)
  assert.deepEqual(
    readdir.entries?.map((entry) => entry.n),
    ['note.txt'],
  )
  assert.equal(readdir.entries?.[0]?.d, false)
})

test('bytes round-trip through base64 and a write reports fresh metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-wsl-proto-'))
  const target = join(directory, 'nested', 'deep.bin').replace(/\\/g, '/')
  const payload = Buffer.from([0, 1, 2, 250, 251, 255])

  const written = await agent.ask({ op: 'write', p: target, data: payload.toString('base64') })
  // The parent directory did not exist: a write must create it rather than fail.
  assert.equal(written.ok, true)
  assert.equal(written.st?.size, payload.length)

  const read = await agent.ask({ op: 'read', p: target })
  assert.equal(read.ok, true)
  assert.deepEqual(Buffer.from(read.data ?? '', 'base64'), payload)

  const ranged = await agent.ask({ op: 'readRange', p: target, offset: 2, length: 3 })
  assert.deepEqual(Buffer.from(ranged.data ?? '', 'base64'), payload.subarray(2, 5))

  const missing = await agent.ask({ op: 'stat', p: `${target}.absent` })
  // A missing path is an error the caller classifies, never an empty success.
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'ENOENT')
})

test('a version token changes when any identity field changes', () => {
  const base = { mode: 0o100644, size: 3, mtimeMs: 1_000, ino: 7, ctimeMs: 1_000, dir: false, link: false }
  const first = versionOf(base)
  assert.notEqual(versionOf({ ...base, size: 4 }), first)
  assert.notEqual(versionOf({ ...base, mtimeMs: 1_001 }), first)
  assert.notEqual(versionOf({ ...base, ino: 8 }), first)
  assert.notEqual(versionOf({ ...base, ctimeMs: 1_002 }), first)
  assert.equal(versionOf({ ...base }), first)
})

test('the capture cap is a sane ceiling, not an accident', () => {
  // `DEFAULT_MAX_BYTES` bounds each stream's retained text on the host, so a
  // runaway command cannot grow the session's memory without limit.
  assert.ok(DEFAULT_MAX_BYTES >= 64 * 1024)
  assert.ok(DEFAULT_MAX_BYTES <= 16 * 1024 * 1024)
  assert.ok(agentSource.includes('CHUNK_MAX'), 'the agent must coalesce output before emitting')
})

test('the default distribution decodes the way wsl.exe writes it', () => {
  let raw: Buffer
  try {
    raw = execFileSync('wsl.exe', ['-l', '-q'], { windowsHide: true })
  } catch {
    return // no WSL on this machine; the live suite covers the rest
  }
  // wsl.exe writes UTF-16LE. Decoding as UTF-8 yields NUL-interleaved text,
  // which is the trap that makes distro discovery look empty.
  const names = raw
    .toString('utf16le')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  assert.ok(names.length > 0)
  assert.ok(
    names.every((name) => !name.includes('\0')),
    'UTF-16LE must be decoded as utf16le',
  )
})
