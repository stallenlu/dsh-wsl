/**
 * Preset variant transform.
 *
 * The upstream plugin rewrites preset YAML by slicing line spans and matching
 * `/^  name: (.+)$/` with exactly two spaces of indentation. A delegation row
 * nested one level deeper (six spaces, inside a `cordis:group`) is missed, which
 * leaves `tool "subagent" is already registered in this scope` at session start
 * (dsh-wsl-workspace#132).
 *
 * This module never looks at indentation: it parses the document to a row array,
 * edits rows by `id`, and dumps it back. Nesting is irrelevant by construction.
 */
import yaml from 'js-yaml'
import type { Row } from '../rows.ts'

/** A `!!js` scalar as the host loader recognizes it. */
export interface JsNode {
  __jsExpr: string
}

const JS_TAG = 'tag:yaml.org,2002:js'

/**
 * The host loader evaluates `!!js` by reading `__jsExpr` off the node
 * (`cordis-plugin-loader`, `isJsExpr = value instanceof Object && '__jsExpr' in
 * value`). Carrying the expression anywhere else would round-trip through YAML
 * and then evaluate as truthy at activation, so the node shape is the contract.
 */
export function isJsNode(value: unknown): value is JsNode {
  return value instanceof Object && Object.hasOwn(value, '__jsExpr')
}

const SCHEMA = yaml.JSON_SCHEMA.extend([
  new yaml.Type(JS_TAG, {
    kind: 'scalar',
    resolve: (data: unknown): data is string => typeof data === 'string',
    construct: (data: string): JsNode => ({ __jsExpr: data }),
    predicate: isJsNode,
    represent: (value: object) => (value as JsNode).__jsExpr,
  }),
])

const DUMP_OPTIONS: yaml.DumpOptions = { schema: SCHEMA, lineWidth: -1, noRefs: true, quotingType: "'" }

/** Parse a preset document into its top-level rows. */
export function parseRows(source: string): Row[] {
  const doc = yaml.load(source, { schema: SCHEMA })
  if (doc === null || doc === undefined) return []
  if (!Array.isArray(doc)) throw new Error('preset document is not a YAML sequence')
  return doc as Row[]
}

/** Serialize rows back to a preset document. */
export function dumpRows(rows: readonly Row[]): string {
  return yaml.dump(rows, DUMP_OPTIONS)
}

/** Row ids this plugin owns and must remove from a source preset before re-adding. */
export const WORLD_ROWS: ReadonlySet<string> = new Set([
  'wsl-world',
  'shell-wsl',
  'fs-wsl',
  'sandbox-wsl',
  'search-wsl',
  'jobs-wsl',
  'read-image-wsl',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'str-replace-editor',
  'tool-str-replace-editor',
  'filesystem',
  'persistent-shell',
  'persistent-bash',
  'bash-wsl',
  'persistent-pwsh',
  'terminal-bash',
  'terminal-pwsh',
  'custom-bash',
  'bootstrap-filesystem',
])

const PERSONA_ROW = 'persona'
const SKILL_FILESYSTEM_ROW = 'skill-filesystem'

/**
 * Appended once to the persona text. Deliberately carries no `{{…}}` group: the
 * host only registers `provider` and `model` as template variables, so a `{{cwd}}`
 * here failed every session at turn 1 step 1 (dsh-wsl-workspace#87).
 */
export const PERSONA_APPEND =
  ' Your working directory is inside a WSL (Windows Subsystem for Linux) distribution: the bash tool and the file read/write/edit tools use Linux paths, and the Windows filesystem is reachable as /mnt/<drive> for file migration.'

export interface TransformOptions {
  /** Rows to append after the retained source rows (the WSL world group). */
  world: readonly Row[]
  /** Drop a subagent delegation row from the source preset. */
  dropSubagentDelegation?: boolean
  /** Sentence appended to the persona row; defaults to {@link PERSONA_APPEND}. */
  personaAppend?: string
}

export interface TransformResult {
  rows: Row[]
  /** Whether the source preset mounted a subagent delegation row that was dropped. */
  droppedDelegation: boolean
}

/**
 * Rewrite one preset composition for use inside a WSL distribution.
 *
 * Retains every source row except the world rows (tool/fs/shell providers and
 * their groups, which are replaced) and the delegation row when requested, then
 * appends the supplied world rows.
 */
export function transformVariant(source: string, options: TransformOptions): TransformResult {
  const source_ = parseRows(source)
  const kept: Row[] = []
  const seen = new Set<string>()
  let droppedDelegation = false

  for (const row of source_) {
    const id = typeof row['id'] === 'string' ? row['id'] : undefined
    if (id !== undefined) {
      if (seen.has(id)) continue // a duplicate id is a loader error
      if (isWorldRow(row)) continue
      seen.add(id)
    }
    if (options.dropSubagentDelegation === true && mountsSubagentDelegation(row)) {
      droppedDelegation = true
      continue
    }
    kept.push(row)
  }

  const persona = kept.find((row) => row['id'] === PERSONA_ROW)
  if (persona !== undefined) appendPersona(persona, options.personaAppend ?? PERSONA_APPEND)

  const skills = kept.find((row) => row['id'] === SKILL_FILESYSTEM_ROW)
  if (skills !== undefined) disableWatch(skills)

  return { rows: [...kept, ...options.world], droppedDelegation }
}

/** True for a row (or group) this plugin owns and replaces. */
export function isWorldRow(row: Row): boolean {
  const id = typeof row['id'] === 'string' ? row['id'] : undefined
  if (id !== undefined && WORLD_ROWS.has(id)) return true
  return isWslWorldGroup(row)
}

function isWslWorldGroup(row: Row): boolean {
  const id = typeof row['id'] === 'string' ? row['id'] : ''
  return id === 'wsl-world' || /^wsl-world\b/.test(id)
}

/** True when a row (at any depth) mounts the subagent delegation plugin. */
export function mountsSubagentDelegation(row: Row): boolean {
  if (row['name'] === '@deepseek-ai/dsh-tool-subagent') return true
  const children = childRows(row)
  if (children === undefined) return false
  return children.some((child) => mountsSubagentDelegation(child))
}

/** Nested rows of a group row, or undefined when the row has none. */
function childRows(row: Row): Row[] | undefined {
  const config = row['config']
  if (!Array.isArray(config)) return undefined
  const rows = config.filter((entry): entry is Row => entry !== null && typeof entry === 'object')
  return rows.length > 0 ? rows : undefined
}

const PERSONA_FIELDS = ['suffix', 'text', 'prefix'] as const

function appendPersona(row: Row, sentence: string): void {
  const config = row['config']
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return
  const record = config as Record<string, unknown>
  if (record['complete'] === true) return // author declares the text final
  for (const field of PERSONA_FIELDS) {
    const value = record[field]
    if (typeof value !== 'string' || value.length === 0 || value.includes(sentence)) continue
    record[field] = value + sentence
    return
  }
}

/**
 * Drop a `disabled` gate that a `!!js` expression produced.
 *
 * Presets gate the host's own tools on the HOST platform — the shipped science and
 * clearai documents both carry `disabled: !!js process.platform === 'win32'` on
 * `tool-bash`. The loader evaluates that expression where the loader runs, which is
 * Windows, so a row lifted into the WSL world would arrive permanently disabled and
 * the variant would have no bash tool at all. A literal `disabled: true` is an
 * author's deliberate choice and survives.
 */
export function clearHostGate(row: Row): void {
  if (isJsNode(row['disabled'])) delete row['disabled']
}

/** True for an id this plugin generates, so a variant is never transformed again. */
export function isWslVariantId(id: string): boolean {
  return id === 'wsl' || /^wsl-[a-z0-9-]+$/.test(id)
}

/** The variant id published for a source preset. */
export function variantIdFor(sourceId: string): string {
  return `wsl-${sourceId.toLowerCase()}`
}

/**
 * The skill catalog is withheld while a filesystem snapshot is incomplete, and the
 * watcher cannot watch a path inside a distribution, so it would never complete.
 */
function disableWatch(row: Row): void {
  const config = row['config']
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return
  ;(config as Record<string, unknown>)['watch'] = false
}
