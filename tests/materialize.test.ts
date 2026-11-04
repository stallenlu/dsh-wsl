/**
 * Preset materialization checked end to end: a realistic roster goes through
 * the REAL `materialize`, which parses, transforms, validates against the
 * host's own `entryListProblem`, and registers. The preset service and context
 * are stubs, but the transform and the validator are the shipping ones — the
 * failure this catches is an emitted composition the host would refuse.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { materialize } from '../src/index.ts'

const STANDARD = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a coding agent.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
  config:
    timeoutMs: 120000
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: delegation
  name: cordis:group
  group: true
  config:
    - id: subagent
      name: '@deepseek-ai/dsh-tool-subagent'
`

function harness(documents: Record<string, string>) {
  const registered: PresetDefinition[] = []
  const disposers: (() => Promise<void>)[] = []
  const presets = {
    async list() {
      return Object.keys(documents).map((id) => ({ id, name: id }))
    },
    async readDocument(id: string) {
      return { content: documents[id]!, name: id }
    },
    async register(definition: PresetDefinition) {
      registered.push(definition)
      const dispose = async (): Promise<void> => {}
      disposers.push(dispose)
      return dispose
    },
  }
  // Only `effect` is touched, and it runs the body immediately so the
  // registration side effects land in this process.
  const ctx = {
    effect(body: () => () => void) {
      body()
    },
  } as unknown as Context
  return { ctx, presets, registered }
}

test('every healthy preset gets a variant the host would accept', async () => {
  const { ctx, presets, registered } = harness({ standard: STANDARD })
  const outcome = await materialize(ctx, presets)
  assert.deepEqual(outcome.failed, [])
  assert.deepEqual(outcome.produced, ['wsl-standard'])

  const definition = registered[0]
  assert.equal(definition?.id, 'wsl-standard')
  const ids = (definition?.plugins ?? []).map((row) => row.id)
  // `tool-pwsh` is gone (there is no PowerShell inside the distribution), and
  // the shell/fs consumers moved INTO the world group. The delegation group
  // survives; the persona stays outside the group.
  assert.deepEqual(ids, ['persona', 'delegation', 'wsl-world'])

  const world = definition?.plugins?.find((row) => row.id === 'wsl-world') as
    | { config: { id: string; disabled?: unknown }[] }
    | undefined
  assert.deepEqual(
    world?.config.map((row) => row.id),
    ['shell-wsl', 'fs-wsl', 'search-wsl', 'tool-bash', 'tool-fs'],
  )
  // The gate tests `process.platform` on the HOST — Windows — so it must not
  // travel with the row into the world. Left in place, bash would be disabled.
  const bash = world?.config.find((row) => row.id === 'tool-bash')
  assert.equal('disabled' in (bash ?? {}), false)
})

test('provider entries are loadable URLs, not bare paths', async () => {
  // The loader passes a non-relative module name straight to `import()`. On
  // Windows a bare `C:/…/lib/shell.js` has no URL scheme and fails with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME — the variant would register and then every
  // row inside it would fail to mount. Only a `file://` href loads.
  const { ctx, presets, registered } = harness({ standard: STANDARD })
  await materialize(ctx, presets)
  const world = registered[0]?.plugins?.find((row) => row.id === 'wsl-world') as
    | { config: { id: string; name: string }[] }
    | undefined
  for (const row of world?.config.slice(0, 3) ?? []) {
    assert.match(row.name, /^file:\/\//, `${row.id} must be importable on Windows`)
    assert.doesNotMatch(row.name, /^[A-Za-z]:/, `${row.id} must not be a bare drive path`)
  }
})

test('an existing variant is never re-imported', async () => {
  const { ctx, presets, registered } = harness({ standard: STANDARD, 'wsl-standard': STANDARD })
  const outcome = await materialize(ctx, presets)
  assert.deepEqual(outcome.produced, ['wsl-standard'])
  assert.equal(registered.length, 1)
})

test('one broken preset does not cost the others their variant', async () => {
  const { ctx, presets, registered } = harness({ standard: STANDARD, broken: 'not: [a, list\n' })
  const outcome = await materialize(ctx, presets)
  assert.deepEqual(outcome.produced, ['wsl-standard'])
  assert.equal(outcome.failed.length, 1)
  assert.equal(outcome.failed[0]?.id, 'wsl-broken')
  assert.equal(registered.length, 1)
})

test('a fiber disposed mid-flight retires the preset instead of leaking it', async () => {
  // This is the host's `wsl-minimal: cannot create effect on inactive context`.
  // `materialize` runs detached, so a boot-time reload can dispose the fiber
  // while it awaits the registry. `presets.register` then still succeeds and
  // `ctx.effect` throws — which used to be reported as a preset FAILURE even
  // though the preset was registered, with its disposer never attached.
  const { Context: RealContext } = await import('@deepseek-ai/cordis')
  const registered: string[] = []
  const retired: string[] = []
  const presets = {
    async list() {
      return [{ id: 'minimal', name: 'minimal' }]
    },
    async readDocument() {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { content: STANDARD, name: 'minimal' }
    },
    async register(definition: PresetDefinition) {
      registered.push(definition.id)
      return async () => {
        retired.push(definition.id)
      }
    },
  }

  const root = new RealContext()
  let captured: Context | undefined
  const fiber = root.plugin({
    name: 'probe',
    apply(pluginCtx: Context) {
      captured = pluginCtx
    },
  })
  await fiber
  const running = materialize(captured!, presets as never)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await fiber.dispose()
  const outcome = await running

  assert.deepEqual(outcome.failed, [], 'a disposed fiber is not a preset failure')
  assert.deepEqual(registered, ['wsl-minimal'], 'the preset was registered, so it must not be reported as failed')
  assert.deepEqual(retired, ['wsl-minimal'], 'the disposer must run, or the preset leaks forever')
})
