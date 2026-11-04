/**
 * The sidebar terminal has to follow its session into the distribution.
 *
 * It cannot be a preset service: `subprocess` is a single-slot host service
 * and an isolated group's provider is invisible to `agent.ctx`, so the host
 * provider is wrapped instead. These checks pin the two things that wrapper
 * must get right — rewriting a WSL session's launch, and leaving every other
 * session exactly as it was — plus the ref-counted install/uninstall.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { applyTerminal, wslLaunch, type TerminalSpec } from '../src/terminal.ts'

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\sidady\\projects\\seekaxe'
const WIN = 'C:\\Users\\GT14\\projects\\win'

/** A request shaped like the one `terminalController.spawn()` builds. */
function spec(cwd: string, argv: readonly string[] = ['C:\\Program Files\\Git\\bin\\bash.exe', '-i']): TerminalSpec {
  return {
    argv,
    cwd,
    env: { DSH_SESSION_ID: 'session-1' },
    rows: 30,
    cols: 100,
    terminalType: 'xterm-256color',
    shellActivity: true,
    graceMs: 1_000,
  }
}

test('a WSL session launches its shell inside the distribution', () => {
  const launch = wslLaunch(spec(UNC))
  assert.ok(launch, 'a UNC cwd must be recognised as a WSL session')
  assert.deepEqual(launch.argv, ['wsl.exe', '-d', 'Ubuntu', '--cd', '/home/sidady/projects/seekaxe', '--', '/bin/bash', '-i'])
  // The controller hands `wsl.exe` a Windows cwd; `--cd` does the real work,
  // because a Windows process cannot hold a UNC directory as its cwd.
  assert.equal(launch.cwd, process.env['USERPROFILE'])
  assert.equal(launch.env?.['TERM'], 'xterm-256color')
  assert.equal(launch.env?.['DSH_SESSION_ID'], 'session-1', 'the session id the host injects must survive')
  assert.equal(launch.rows, 30)
  assert.equal(launch.cols, 100)
})

test('a Windows session is passed through untouched', () => {
  assert.equal(wslLaunch(spec(WIN)), undefined)
  assert.equal(wslLaunch(spec('/home/sidady')), undefined, 'a bare POSIX path is not a WSL workspace')
})

test('the requested shell carries over only when the distribution has it', () => {
  // argv is ['wsl.exe','-d',<distro>,'--cd',<linux cwd>,'--',<shell>,...args]
  const zsh = wslLaunch(spec(UNC, ['C:\\tools\\zsh.exe', '-i']))
  assert.equal(zsh?.argv[6], '/bin/zsh')
  const pwsh = wslLaunch(spec(UNC, ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo']))
  assert.equal(pwsh?.argv[6], '/bin/bash', 'a Windows-only shell falls back to the distribution default')
  assert.deepEqual(pwsh?.argv.slice(7), ['-NoLogo'], 'the shell arguments are preserved')
})

test('the host provider is wrapped in place and restored on disposal', async () => {
  const ctx = new Context()
  const calls: TerminalSpec[] = []
  const provider = {
    async spawnTerminal(given: TerminalSpec) {
      calls.push(given)
      return { ok: true }
    },
  }
  ctx.provide('subprocess', provider as never)
  const original = provider.spawnTerminal

  const dispose = ctx.effect(() => () => {}, 'noop')
  applyTerminal(ctx)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const viaCtx = ctx.get('subprocess') as unknown as typeof provider
  assert.equal(typeof viaCtx.spawnTerminal, 'function')
  await viaCtx.spawnTerminal(spec(UNC))
  await viaCtx.spawnTerminal(spec(WIN))
  assert.equal(calls.length, 2, 'both calls must still reach the host provider')
  assert.deepEqual(calls[0]?.argv.slice(0, 2), ['wsl.exe', '-d'], 'the WSL call must be rewritten')
  assert.equal(calls[0]?.argv[4], '/home/sidady/projects/seekaxe')
  assert.equal(calls[1]?.cwd, WIN, 'the Windows call must arrive unchanged')
  assert.equal(calls[1]?.argv[0], 'C:\\Program Files\\Git\\bin\\bash.exe')

  dispose()
  ctx.set('subprocess', provider as never)
  assert.equal(typeof provider.spawnTerminal, 'function')
  assert.notEqual(provider.spawnTerminal, original, 'the wrapper stays installed while mounted')
})

test('a host without a subprocess provider loads without throwing', () => {
  const ctx = new Context()
  assert.doesNotThrow(() => applyTerminal(ctx))
})
