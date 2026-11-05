/**
 * The `grep` / `glob` replacement: argument quoting, path translation, and a
 * real run through the persistent agent.
 *
 * The tools are captured from a stub registry but built by the real
 * `defineTool`, so a schema mistake fails here rather than in a session. The
 * live cases drive `execute` with a UNC session path, which is how the model
 * reaches a WSL workspace, and assert on ripgrep's actual answers.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { closeAll } from '../src/channel.ts'
import { decodeWslOut } from '../src/index.ts'
import { apply, linuxTarget, resolveTarget, shq } from '../src/search.ts'

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

const distro = distros()[0]
const skip = distro === undefined ? 'no WSL distribution on this machine' : false

after(async () => {
  await closeAll()
})

interface Tool {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown; render: (args: unknown, value: unknown) => { type: string; text: string }[] }
  execute: (args: never, exec: unknown) => Promise<unknown>
}

/** Register the tools against a stub registry and return them by name. */
function tools(config?: { distro?: string }): Map<string, Tool> {
  const registered = new Map<string, Tool>()
  const sections: { name: string; order: number; text: string }[] = []
  const ctx = {
    get(name: string) {
      if (name === 'tools') {
        return {
          register(definition: Tool) {
            registered.set(definition.name, definition)
            return () => {}
          },
        }
      }
      if (name === 'systemPrompt') {
        return {
          section(entry: { name: string; order: number; text: string }) {
            sections.push(entry)
            return () => {}
          },
          getSectionOrder: () => 100,
        }
      }
      return undefined
    },
    effect(body: () => () => void) {
      body()
    },
  } as unknown as Context
  apply(ctx, config)
  assert.deepEqual([...registered.keys()].sort(), ['glob', 'grep'])
  assert.deepEqual(
    sections.map((entry) => entry.name),
    ['tool:grep'],
  )
  return registered
}

/** An execution whose session lives at `cwd`, which is all search reads. */
function exec(cwd: string): unknown {
  return {
    agent: { session: { header: { cwd } } },
    signal: new AbortController().signal,
  }
}

test('a shell-hostile pattern survives quoting intact', () => {
  // The whole point of shq: the model supplies the pattern, so it must reach
  // ripgrep as one literal argument whatever it contains.
  assert.equal(shq("it's"), "'it'\\''s'")
  assert.equal(shq('a b'), "'a b'")
  assert.equal(shq('$(rm -rf /)'), "'$(rm -rf /)'")
  assert.equal(shq('`id`'), "'`id`'")
  assert.equal(shq('a; rm -rf /'), "'a; rm -rf /'")
})

test('paths translate to Linux coordinates and relative ones pass through', () => {
  assert.equal(linuxTarget(undefined), '.')
  assert.equal(linuxTarget(''), '.')
  assert.equal(linuxTarget(String.raw`\\wsl.localhost\Ubuntu\home\x`), '/home/x')
  assert.equal(linuxTarget('D:\\proj\\src'), '/mnt/d/proj/src')
  assert.equal(linuxTarget('D:/proj/src'), '/mnt/d/proj/src')
  // A relative path is resolved by ripgrep against the session's own cwd.
  assert.equal(linuxTarget('src'), 'src')
})

test('a target comes from the session path, not from the host', () => {
  assert.deepEqual(resolveTarget(String.raw`\\wsl.localhost\Ubuntu\home\x`), {
    distro: 'Ubuntu',
    cwd: '/home/x',
  })
  // A Linux path with no distro anywhere is not a WSL session: search must
  // refuse rather than run ripgrep on the host.
  assert.equal(resolveTarget('/home/x'), undefined)
  assert.deepEqual(resolveTarget('/home/x', 'Ubuntu'), { distro: 'Ubuntu', cwd: '/home/x' })
  // A drive path is never a WSL session either.
  assert.equal(resolveTarget('C:\\Users'), undefined)
})

test('grep and glob refuse a session that is not inside a distribution', async () => {
  const registry = tools()
  for (const name of ['grep', 'glob']) {
    await assert.rejects(
      registry.get(name)!.execute({ pattern: 'x' } as never, exec('C:\\Users')),
      /only available in a WSL workspace session/,
    )
  }
})

test('grep finds real matches and reports line numbers', { skip }, async () => {
  const registry = tools({ distro: distro! })
  const result = (await registry.get('grep')!.execute(
    { pattern: 'NAME=', path: '/etc/os-release' } as never,
    exec(`//wsl.localhost/${distro!}/home`),
  )) as { matches: { path: string; lineNumber: number; line: string }[]; total: number }

  assert.ok(result.total >= 1, 'expected at least one NAME= line in /etc/os-release')
  const name = result.matches.find((match) => match.line.startsWith('NAME='))
  assert.ok(name, 'expected the NAME= line itself')
  assert.equal(name.path, '/etc/os-release')
  assert.equal(typeof name.lineNumber, 'number')
  assert.ok(name.lineNumber >= 1)

  const rendered = registry.get('grep')!.output.render({}, result)
  assert.equal(rendered.length, 1)
  // Grouped by file, then `line:content` — the shipped tool's shape.
  assert.match(rendered[0]!.text, /^\/etc\/os-release:\n\d+:.*NAME=/m)
})

test('grep reports no matches without failing', { skip }, async () => {
  const registry = tools({ distro: distro! })
  const result = (await registry.get('grep')!.execute(
    { pattern: 'dsh-wsl-no-such-token-5a1f', path: '/etc/os-release' } as never,
    exec(`//wsl.localhost/${distro!}/home`),
  )) as { matches: unknown[]; total: number }
  // ripgrep exits 1 here; treating that as an error would turn "no matches"
  // into a failed tool call.
  assert.deepEqual(result.matches, [])
  assert.equal(result.total, 0)
  assert.equal(registry.get('grep')!.output.render({}, result)[0]!.text, 'No matches.')
})

test('grep rejects an include that is a list or a negation', { skip }, async () => {
  const registry = tools({ distro: distro! })
  const target = exec(`//wsl.localhost/${distro!}/home`)
  await assert.rejects(
    registry.get('grep')!.execute({ pattern: 'x', include: '!*.md' } as never, target),
    /negated patterns are not supported/,
  )
  await assert.rejects(
    registry.get('grep')!.execute({ pattern: 'x', include: '*.ts,*.tsx' } as never, target),
    /one glob, not a comma-separated list/,
  )
})

test('an unreadable directory costs nothing but is not an empty answer', { skip }, async () => {
  // `/etc` holds root-only directories, so ripgrep exits 2 having skipped
  // them — it still returns every other match. Failing the call there would
  // refuse to search any real tree; returning nothing would be a lie.
  const registry = tools({ distro: distro! })
  const result = (await registry.get('glob')!.execute(
    { pattern: '*.conf', path: '/etc' } as never,
    exec(`//wsl.localhost/${distro!}/home`),
  )) as { total: number }
  assert.ok(result.total > 0, 'matches from readable directories must survive')
})

test('a broken pattern reports why, not "no matches"', { skip }, async () => {
  const registry = tools({ distro: distro! })
  await assert.rejects(
    registry.get('grep')!.execute(
      { pattern: '(', path: '/etc/os-release' } as never,
      exec(`//wsl.localhost/${distro!}/home`),
    ),
    /ripgrep exited 2: .*regex parse error/,
  )
  // A path that does not exist is the same class: nothing was searched, so
  // "No matches." would claim the question was answered.
  await assert.rejects(
    registry.get('glob')!.execute(
      { pattern: '*.md', path: '/no/such/directory' } as never,
      exec(`//wsl.localhost/${distro!}/home`),
    ),
    /ripgrep exited 2/,
  )
})

test('glob lists files, never directories, and honours the pattern', { skip }, async () => {
  const registry = tools({ distro: distro! })
  const result = (await registry.get('glob')!.execute(
    { pattern: '*.conf', path: '/etc' } as never,
    exec(`//wsl.localhost/${distro!}/home`),
  )) as { root: string; paths: string[]; total: number }

  assert.equal(result.root, '/etc')
  assert.equal(result.paths.length, Math.min(result.total, 100))
  // `*.conf` matches the basename at any depth, and `--files` yields files
  // only — a directory named `x.conf` would be a defect.
  assert.ok(result.total > 0, 'expected some .conf files under /etc')
  for (const path of result.paths) assert.match(path, /\.conf$/)

  const rendered = registry.get('glob')!.output.render({}, { ...result, paths: [], total: 0 })
  assert.equal(rendered[0]!.text, 'No files matched.')
})

test('a search actually runs inside the distribution', { skip }, async () => {
  // The packaged Windows ripgrep reached the same tree through 9P, but took
  // 44 s for a file walk and silently dropped roughly half the matches. The
  // timing bound is loose enough not to flake and tight enough to fail if the
  // search ever fell back to the share.
  const registry = tools({ distro: distro! })
  const started = performance.now()
  const result = (await registry.get('glob')!.execute(
    { pattern: '*.conf', path: '/etc' } as never,
    exec(`//wsl.localhost/${distro!}/home`),
  )) as { total: number }
  const elapsed = performance.now() - started
  assert.ok(result.total > 0, 'expected some .conf files under /etc')
  assert.ok(elapsed < 10_000, `glob cost ${elapsed.toFixed(0)} ms`)
})
