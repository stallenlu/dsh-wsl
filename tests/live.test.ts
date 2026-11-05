/**
 * Live integration checks against a real distribution. Skipped (not failed)
 * when this machine has no WSL install, so `npm test` stays usable anywhere.
 *
 * These are the two behaviours the whole rewrite exists for: an exec that costs
 * milliseconds instead of a `wsl.exe` spawn, and a filesystem that can read
 * drvfs (`/mnt/<drive>`), which 9P cannot serve at all.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { channelFor, closeAll } from '../src/channel.ts'
import { decodeWslOut } from '../src/index.ts'
import { WslFileSystem } from '../src/fs.ts'
import { WslShellExecutor } from '../src/shell.ts'

/** The distro names this machine has, decoded the way `wsl.exe` writes them. */
function distros(): string[] {
  try {
    const raw = execFileSync('wsl.exe', ['-l', '-q'], { windowsHide: true })
    return decodeWslOut(raw)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch {
    return []
  }
}

const available = distros()
const distro = available[0]
const skip = distro === undefined ? 'no WSL distribution on this machine' : false

after(async () => {
  await closeAll()
})

test('a stat through the persistent agent is far below one spawn', { skip }, async () => {
  const channel = await channelFor(distro!)
  const started = performance.now()
  const rounds = 50
  for (let index = 0; index < rounds; index += 1) {
    const reply = await channel.ok({ op: 'stat', p: '/etc' })
    assert.equal(reply.st?.dir, true)
  }
  const perOp = (performance.now() - started) / rounds
  // A one-shot `wsl.exe` costs ~250 ms; 9P costs ~4 ms. Anything near those
  // means the channel degraded to a spawn or fell back to the share.
  assert.ok(perOp < 40, `stat cost ${perOp.toFixed(2)} ms/op`)
})

test('a command reports exit code, stream split, and the login environment', { skip }, async () => {
  const shell = new WslShellExecutor(new Context(), { distro: distro! })
  const execution = await shell.execute(
    shell.resolve({ command: 'echo one; echo two >&2; echo "$HOME"; exit 3' }),
  )
  const result = await execution.result()
  assert.equal(result.exitCode, 3)
  assert.equal(result.timedOut, false)
  assert.equal(result.stderr.text, 'two\n')
  const [first, home] = result.stdout.text.trim().split('\n')
  assert.equal(first, 'one')
  // `wsl.exe --exec` bypasses the login shell, so the agent reconstructs PATH
  // itself; $HOME proves it took effect.
  assert.match(home ?? '', /^\/home\/|^\/root$/)
})

test('a timeout kills the whole process group', { skip }, async () => {
  const shell = new WslShellExecutor(new Context(), { distro: distro! })
  const execution = await shell.execute(
    shell.resolve({ command: 'sleep 30 & sleep 30; echo unreachable', timeoutMs: 400 }),
  )
  const result = await execution.result()
  assert.equal(result.timedOut, true)
  assert.equal(result.stdout.text, '')
})

test('file writes are atomic, version-checked, and survive a stale guard', { skip }, async () => {
  const fs = new WslFileSystem(new Context(), { distro: distro! })
  const directory = mkdtempSync(join(tmpdir(), 'dsh-wsl-'))
  const linux = `/mnt/${directory[0]!.toLowerCase()}${directory.slice(2).replace(/\\/g, '/')}`
  const target = await fs.resolve(`${linux}/note.txt`, { cwd: '/' })

  const created = await fs.writeText(target, 'alpha\n', { kind: 'createIfAbsent' })
  assert.equal(created.operation, 'create')
  assert.equal(created.before, null)

  await assert.rejects(fs.writeText(target, 'nope\n', { kind: 'createIfAbsent' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'FS_NOT_OBSERVED')
    return true
  })

  const updated = await fs.writeText(target, 'beta\n', { kind: 'replaceIfVersion', version: created.version })
  assert.equal(updated.operation, 'update')
  assert.equal(updated.before, 'alpha\n')

  await assert.rejects(
    fs.writeText(target, 'stale\n', { kind: 'replaceIfVersion', version: created.version }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'FS_STALE_VERSION')
      return true
    },
  )

  const edited = await fs.editText(target, { oldString: 'beta', newString: 'gamma', replaceAll: false })
  assert.equal((await fs.readText(target)).trim(), 'gamma')
  assert.equal(edited.before, 'beta\n')
})

test('the filesystem serves drvfs, which 9P cannot', { skip }, async () => {
  const fs = new WslFileSystem(new Context(), { distro: distro! })
  const mounted = await fs.resolve('/mnt/c/Users', { cwd: '/' })
  const entries = await fs.listDir(mounted)
  assert.ok(entries.length > 0, 'expected entries under /mnt/c/Users')
  assert.ok(
    entries.some((entry) => entry.type === 'directory'),
    'expected at least one user directory',
  )
})

/**
 * `run_in_background`, `job_output` and `job_kill` are the host's own tools and
 * they are not isolated into the world group, so they keep working in a WSL
 * variant — but only if the shell they hold meets the process-handle contract:
 * a handle at once, a non-consuming `observed` pull source, and a kill that
 * really ends the run. This is that contract, against the WSL shell.
 */
test('a background handle streams and kills like the jobs registry expects', { skip }, async () => {
  const shell = new WslShellExecutor(new Context(), { distro: distro! })
  const handle = await shell.execute({
    command: 'for i in 1 2 3; do echo tick$i; sleep 1; done',
    workdir: '/',
    timeoutMs: 0,
  })
  assert.equal(handle.status, 'running')

  // `observed` is a pull source at byte offsets, not a consuming read.
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  const first = handle.observed.stdout.readFrom(0)
  assert.match(first.text, /tick1/, 'a running job has output to pull')
  assert.equal(handle.status, 'running')

  const result = await handle.result()
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.stdout, { text: 'tick1\ntick2\ntick3\n', truncated: false })

  const doomed = await shell.execute({ command: 'sleep 30', workdir: '/', timeoutMs: 0 })
  assert.equal(doomed.kill(), true, 'kill() reports it stopped something')
  await doomed.result().catch(() => {})
  assert.equal(doomed.status, 'killed')
  assert.equal(doomed.signal, 'SIGKILL', 'the process group is killed, not orphaned')
})

/**
 * The seam reports `before`/`after` LF-normalized so a diff has one basis. That
 * is about the REPORT. Seeking to "normalize" the bytes on disk rewrites every
 * untouched line of a CRLF file the moment one line is edited — data loss, and
 * a whole-file diff in a repository that legitimately commits CRLF.
 */
test('an edit keeps the line endings the file already had', { skip }, async () => {
  const fs = new WslFileSystem(new Context(), { distro: distro! })
  const directory = mkdtempSync(join(tmpdir(), 'dsh-wsl-eol-'))
  const linux = `/mnt/${directory[0]!.toLowerCase()}${directory.slice(2).replace(/\\/g, '/')}`
  const target = await fs.resolve(`${linux}/crlf.txt`, { cwd: '/' })

  await fs.writeText(target, 'alpha\r\nbeta\r\ngamma\r\n', { kind: 'createIfAbsent' })
  assert.equal(await fs.readText(target), 'alpha\r\nbeta\r\ngamma\r\n', 'write stores the bytes it was given')

  const edited = await fs.editText(target, { oldString: 'beta', newString: 'BETA', replaceAll: false })
  assert.equal(await fs.readText(target), 'alpha\r\nBETA\r\ngamma\r\n', 'untouched lines keep CRLF')
  // The reported diff basis stays LF even though the file is CRLF.
  assert.equal(edited.before, 'alpha\nbeta\ngamma\n')
  assert.equal(edited.after, 'alpha\nBETA\ngamma\n')
})

/**
 * A background handle may never have `result()` awaited — the jobs registry
 * polls it by status. If the channel then dies mid-run, an unobserved rejection
 * is a FATAL throw in Node, taking the whole harness down rather than one call.
 * This test fails loudly by *dying*: without the guard, the process exits here.
 */
test('a background run that fails unobserved never kills the process', { skip }, async () => {
  const shell = new WslShellExecutor(new Context(), { distro: distro! })
  const handle = await shell.execute({ command: 'sleep 240', workdir: '/', timeoutMs: 0 })
  assert.equal(handle.status, 'running')

  // Tear the transport down under it, exactly like a crashed or idle-closed agent.
  await closeAll()
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(handle.status, 'killed')
  await assert.rejects(handle.result(), /closed/, 'the caller still sees the failure')
})

/**
 * A long run only arms the idle timer once — at `begin()`. If "idle" meant "no
 * request started recently", the channel would close under a 30-minute `pytest`
 * or a dev server while the user merely read code, and the agent kills its
 * children when stdin ends. Mocked timers reach `IDLE_TTL_MS` in microseconds;
 * this asserts the run survives it and still delivers its whole output.
 */
test('the idle timer never kills a run that is still in flight', { skip }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const shell = new WslShellExecutor(new Context(), { distro: distro! })
    const handle = await shell.execute({ command: 'echo alive; sleep 1', workdir: '/', timeoutMs: 0 })
    assert.equal(handle.status, 'running')

    t.mock.timers.tick(11 * 60 * 1000)
    assert.equal(handle.status, 'running', 'a pending request keeps the channel open')

    const result = await handle.result()
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.text, /alive/)
  } finally {
    t.mock.timers.reset()
  }
})

/**
 * Output must stay bounded even when a caller hands `execute()` the bare request
 * instead of resolving it first. With an `undefined` limit every size check is
 * false and a runaway command buffers its whole output in memory — the failure
 * mode is an OOM in the harness, not a bad tool result.
 */
test('stdout is capped even without resolve() filling the budget', { skip }, async () => {
  const shell = new WslShellExecutor(new Context(), { distro: distro! })
  const execution = await shell.execute({
    command: "yes 'xxxxxxxxxxxxxxxx' | head -c 2000000",
    workdir: '/',
    timeoutMs: 60_000,
  })
  const result = await execution.result()
  assert.equal(result.stdout.truncated, true, 'the cap engaged')
  assert.ok(result.stdout.text.length <= 64_000, `kept ${result.stdout.text.length} chars`)
})

/**
 * `readOutput()` is the consuming reader the `job_output` tool drives. Once the
 * capture starts dropping its head, a reader that counts against `text.length`
 * stops producing deltas — the retained text never grows past the budget again —
 * so a job still streaming output looks silent forever. The final marker here is
 * written only AFTER the cap has engaged, so it can only arrive through a delta.
 */
test('deltas keep flowing after the output cap starts dropping the head', { skip }, async () => {
  const shell = new WslShellExecutor(new Context(), { distro: distro! })
  // A slow flood: the cap engages early, then output continues for seconds.
  // Counting polls that yielded text is what separates a real delta reader from
  // one that slices the retained (capped) text by its own counter — that one
  // returns nothing almost every time once the head starts being dropped.
  const handle = await shell.execute({
    command:
      "for i in $(seq 1 1500); do echo line$i-$(printf 'x%.0s' $(seq 1 60)); sleep 0.004; done",
    workdir: '/',
    timeoutMs: 0,
  })

  let capped = false
  let pollsAfterCap = 0
  let productiveAfterCap = 0
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const read = handle.readOutput()
    if (capped) {
      pollsAfterCap += 1
      if (read.delta !== '') productiveAfterCap += 1
    }
    if (read.lossy) capped = true
    if (handle.status !== 'running' && read.delta === '') break
  }
  await handle.result()
  assert.equal(capped, true, 'the cap really engaged')
  assert.ok(pollsAfterCap >= 5, `only ${pollsAfterCap} polls after the cap`)
  assert.ok(
    productiveAfterCap >= pollsAfterCap / 2,
    `only ${productiveAfterCap} of ${pollsAfterCap} polls after the cap returned text`,
  )
})

/**
 * The regression that matters most: cordis hands a service out through a Proxy,
 * and a `#private` member read off that proxy throws
 * `Receiver must be an instance of class …`. Every other test here constructs the
 * provider directly, so only this one notices — and in production *every* WSL
 * tool goes through `ctx.shell` / `ctx.fs`, never the constructor's own object.
 */
test('services work through the cordis proxy a real session uses', { skip }, async () => {
  const ctx = new Context()
  new WslShellExecutor(ctx, { distro: distro!, cwd: '/' })
  new WslFileSystem(ctx, { distro: distro! })

  const shell = ctx.shell as unknown as WslShellExecutor
  const fs = ctx.fs as unknown as WslFileSystem
  assert.notEqual(shell, undefined, 'ctx.shell is provided')
  assert.notEqual(fs, undefined, 'ctx.fs is provided')

  const ran = await (await shell.execute({ command: 'echo proxied', workdir: '/' })).result()
  assert.equal(ran.stdout.text.trim(), 'proxied')

  const stat = await fs.stat(await fs.resolve('/etc/os-release', { cwd: '/' }))
  assert.equal(stat?.type, 'file')
})
