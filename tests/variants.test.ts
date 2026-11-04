/**
 * Variant transform checks. The point of this module is dsh-wsl-workspace#132:
 * the reference detected the subagent delegation row by matching two leading
 * spaces, so a row nested six spaces deep inside a `cordis:group` was missed
 * and session creation died with `tool "subagent" is already registered`.
 * These checks are structural, so they fail if anyone reintroduces
 * indentation-sensitive matching.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PERSONA_APPEND,
  dumpRows,
  mountsSubagentDelegation,
  parseRows,
  transformVariant,
} from '../src/host/variants.ts'
import { wslWorldGroup } from '../src/rows.ts'

const STANDARD_LIKE = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are an agent.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: delegation
  name: cordis:group
  group: true
  disabled: !!js process.platform === 'win32'
  config:
    - id: subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        maxDepth: 3
- id: skill-filesystem
  name: '@deepseek-ai/dsh-tool-skill'
  config:
    watch: true
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform === 'win32'
`

const world = wslWorldGroup({
  shell: '/pkg/lib/shell.js',
  fs: '/pkg/lib/fs.js',
  distro: 'Ubuntu',
  cwd: '/home/x',
  nodePath: 'node',
})

test('world rows are replaced, every other row keeps its order', () => {
  const result = transformVariant(STANDARD_LIKE, { world: [world] })
  assert.deepEqual(
    result.rows.map((row) => row['id']),
    ['persona', 'delegation', 'skill-filesystem', 'wsl-world'],
  )
  // #132: detected at six-space depth, and KEPT — 0.2.1-rc.5 ships the gate.
  assert.equal(result.droppedDelegation, false)
})

test('the persona sentence is appended once and is idempotent', () => {
  const result = transformVariant(STANDARD_LIKE, { world: [world] })
  const persona = result.rows.find((row) => row['id'] === 'persona')
  assert.equal((persona?.['config'] as { text: string }).text, `You are an agent.${PERSONA_APPEND}`)

  const twice = transformVariant(dumpRows(result.rows), { world: [] })
  const again = twice.rows.find((row) => row['id'] === 'persona')
  assert.equal((again?.['config'] as { text: string }).text, `You are an agent.${PERSONA_APPEND}`)
})

test('the skill watch is disabled: a UNC-free tree has no watcher', () => {
  const result = transformVariant(STANDARD_LIKE, { world: [world] })
  const skills = result.rows.find((row) => row['id'] === 'skill-filesystem')
  assert.equal((skills?.['config'] as { watch: boolean }).watch, false)
})

test('!!js survives a parse → dump → parse cycle', () => {
  const dumped = dumpRows(transformVariant(STANDARD_LIKE, { world: [world] }).rows)
  assert.ok(dumped.includes("disabled: !!js process.platform === 'win32'"))
  assert.deepEqual(parseRows(dumped).map((row) => row['id']), [
    'persona',
    'delegation',
    'skill-filesystem',
    'wsl-world',
  ])
})

test('dropping delegation reaches a nested row and reports it', () => {
  const dropped = transformVariant(STANDARD_LIKE, { world: [world], dropSubagentDelegation: true })
  assert.equal(dropped.droppedDelegation, true)
  assert.equal(dropped.rows.some((row) => row['id'] === 'delegation'), false)
})

test('delegation detection is structural, not indentation-based', () => {
  assert.equal(mountsSubagentDelegation({ id: 'x', name: '@deepseek-ai/dsh-tool-subagent' }), true)
  assert.equal(
    mountsSubagentDelegation({
      id: 'g',
      name: 'cordis:group',
      config: [{ id: 'y', name: '@deepseek-ai/dsh-tool-subagent' }],
    }),
    true,
  )
  assert.equal(mountsSubagentDelegation({ id: 'x', name: 'other' }), false)
})

test('a duplicate top-level id is dropped, first wins', () => {
  const dup = transformVariant('- id: a\n  name: one\n- id: a\n  name: two\n', { world: [] })
  assert.deepEqual(dup.rows.map((row) => row['name']), ['one'])
})

test('a persona that declares itself complete is left alone', () => {
  const complete = transformVariant('- id: persona\n  name: p\n  config:\n    text: fixed\n    complete: true\n', {
    world: [],
  })
  assert.equal((complete.rows[0]?.['config'] as { text: string }).text, 'fixed')
})
