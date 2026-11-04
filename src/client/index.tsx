/**
 * Browser half of dsh-wsl.
 *
 * Two seats, one dialog. The footer action on the host's own
 * `sidebar.footer.action` list slot (`replaceRisk: "none"`) is both the fallback
 * and the discovery anchor: the header entry (`src/client/hostEntry.ts`) walks
 * up from this slot's mounted element to find the Workspaces section header and
 * mounts a "W" control right of the shipped "Add workspace" button there — the
 * treatment the old `dsh-wsl-workspace` plugin shipped. The header copy retires
 * the footer copy while its seat is present; the footer copy keeps working when
 * the header is absent (rail sidebar, a release that renames the classes).
 *
 * The dialog talks to this plugin's host route for the two things the host's
 * remote surface does not expose — installed distributions and Linux directory
 * listing — and otherwise uses the host's own `remote.workspace.create`, so no
 * second workspace registry exists.
 *
 * Styling is token-only (`src/client/styles.ts`, all `--dsw-*`), so the same
 * rules read correctly on the dark shell instead of the light-theme fallbacks
 * this client used to hard-code.
 *
 * @module dsh-wsl/client
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { mountHeaderEntry } from './hostEntry.ts'
import { ensureStyles } from './styles.ts'
import { fill, strings } from './locale.ts'

// The client registry identifies this module through the package's `dsh.client`
// manifest, so the bundle exports `apply`/`inject` only — the shape the
// installed reference plugin ships and the registry accepts.

/** `slots` is the only hard dependency; the dialog degrades without the rest. */
export const inject = ['slots']

/** The route the host half registers by default. */
const ENDPOINT = '/dsh-wsl/api'
const CALL_TIMEOUT_MS = 30_000

// --- transport -----------------------------------------------------------

interface Distro {
  name: string
  default: boolean
}

interface DirEntry {
  name: string
  dir: boolean
  link: boolean
}

type Envelope<T> = { ok: true; value: T } | { ok: false; error: string }

function errorText(value: unknown): string {
  if (typeof value === 'string' && value !== '') return value
  if (value instanceof Error) return value.message
  return String(value)
}

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, ...params }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
  // The status is checked before the body is trusted: a proxy answering 500
  // sends HTML, and parsing it would report "non-JSON" instead of the status.
  if (!response.ok) throw new Error(`dsh-wsl ${method}: HTTP ${response.status}`)
  const envelope = (await response.json()) as Envelope<T>
  if (!envelope.ok) throw new Error(errorText(envelope.error))
  return envelope.value
}

// --- dialog --------------------------------------------------------------

const JOINT = '/'

function childPath(parent: string, name: string): string {
  return parent === JOINT ? `/${name}` : `${parent}/${name}`
}

function parentPath(path: string): string {
  if (path === JOINT) return JOINT
  const cut = path.lastIndexOf(JOINT)
  return cut <= 0 ? JOINT : path.slice(0, cut)
}

function AddWslDialog(props: { onClose: () => void }): React.ReactElement {
  const t = strings()
  const [distros, setDistros] = useState<Distro[]>([])
  const [distro, setDistro] = useState('')
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [done, setDone] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    void call<{ distros: Distro[] }>('listDistros')
      .then((value) => {
        if (!live) return
        setDistros(value.distros)
        const first = value.distros[0]
        if (first !== undefined) {
          setDistro(first.name)
          setPath('/home')
        }
      })
      .catch((cause: unknown) => {
        if (live) setError(errorText(cause))
      })
    return () => {
      live = false
    }
  }, [])

  const browse = useCallback(
    async (next: string) => {
      if (distro === '') return
      setBusy(true)
      setError(undefined)
      try {
        const value = await call<{ entries: DirEntry[] }>('listDir', { distro, path: next })
        setPath(next)
        setEntries(value.entries)
      } catch (cause) {
        setError(errorText(cause))
      } finally {
        setBusy(false)
      }
    },
    [distro],
  )

  useEffect(() => {
    if (distro !== '') void browse(path)
    // Entering the dialog browses the starting directory once per distro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distro])

  const create = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const value = await call<{ workspace: { title: string }; created: boolean }>('createWorkspace', {
        distro,
        path,
      })
      setDone(
        value.created
          ? fill(t.added, { title: value.workspace.title })
          : fill(t.alreadyAdded, { title: value.workspace.title }),
      )
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }, [distro, path])

  const crumbs: string[] = []
  for (let cursor = path; ; cursor = parentPath(cursor)) {
    crumbs.unshift(cursor)
    if (cursor === JOINT) break
  }

  return (
    <div className="dww-overlay" role="dialog" aria-modal="true" aria-label={t.addTitle}>
      <div className="dww-overlay-mask" onClick={props.onClose} />
      <div className="dww-card">
        <div className="dww-header">
          <h2 className="dww-title">{t.addTitle}</h2>
          <button type="button" className="dww-close" aria-label={t.close} onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="dww-body">
          <div className="dww-field">
            <span className="dww-field-label">{t.distribution}</span>
            <select
              className="dww-select"
              value={distro}
              onChange={(event) => setDistro(event.target.value)}
            >
              {distros.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                  {entry.default ? t.defaultTag : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="dww-feedback">
            <div className="dww-breadcrumb">
              {crumbs.map((crumb, index) => (
                <button
                  key={crumb}
                  type="button"
                  className="dww-dir-row"
                  style={{ display: 'inline-flex', height: 'auto', padding: '0 6px', fontSize: 12 }}
                  onClick={() => void browse(crumb)}
                  aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                >
                  {crumb === JOINT ? '/' : crumb.slice(crumb.lastIndexOf(JOINT) + 1)}
                </button>
              ))}
            </div>

            <div className="dww-dirlist">
              {path !== JOINT ? (
                <button type="button" className="dww-dir-row dww-dir-row--up" onClick={() => void browse(parentPath(path))}>
                  <span aria-hidden="true">↑</span> ..
                </button>
              ) : null}
              {entries
                .filter((entry) => entry.dir)
                .map((entry) => (
                  <button
                    key={entry.name}
                    type="button"
                    className="dww-dir-row"
                    onClick={() => void browse(childPath(path, entry.name))}
                  >
                    <span aria-hidden="true">{entry.link ? '↪' : '📁'}</span> {entry.name}
                  </button>
                ))}
            </div>
          </div>

          <div className="dww-breadcrumb">{path}</div>
          {error === undefined ? null : <div className="dww-error">{error}</div>}
          {done === undefined ? null : <div className="dww-done">{done}</div>}
        </div>

        <div className="dww-actions">
          <button type="button" className="dww-btn" onClick={props.onClose} disabled={busy}>
            {t.close}
          </button>
          <button type="button" className="dww-btn dww-btn--primary" onClick={() => void create()} disabled={busy || distro === ''}>
            {t.addFolder}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- seats ---------------------------------------------------------------

/**
 * The footer seat: fallback and discovery anchor. `hidden` while the header
 * entry is seated — hidden, not removed, because the header mount discovers
 * its way up from this component's own DOM element.
 */
function AddWslAction(props: { wide: boolean }): React.ReactElement {
  const t = strings()
  const [open, setOpen] = useState(false)
  const [seated, setSeated] = useState(false)
  const homeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const home = homeRef.current?.parentElement ?? null
    return mountHeaderEntry(home, { label: () => t.addTitle, open: () => setOpen(true) }, setSeated)
    // The dictionary is resolved once per mount; a language change reloads the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <button
        ref={homeRef}
        type="button"
        hidden={seated}
        className={props.wide ? 'dww-action dww-action--wide' : 'dww-action dww-action--rail'}
        aria-label={t.addTitle}
        onClick={() => setOpen(true)}
      >
        <span className="dww-letter" aria-hidden="true">W</span>
        {props.wide ? <span>{t.addTitle}…</span> : null}
      </button>
      {open ? <AddWslDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

// --- plugin entry --------------------------------------------------------

interface SlotsService {
  register(options: Record<string, unknown>, component: unknown): () => void
  inject(name: string, register: () => () => void): () => void
}

export function apply(ctx: { get(name: string): unknown; effect(body: () => () => void, label?: string): void }): void {
  // Named exports only: the client registry reads the module's named exports,
  // and a default export would make a CommonJS consumer reach for `.default`.

  ensureStyles()

  const slots = ctx.get('slots') as unknown as SlotsService | undefined
  if (slots === undefined || typeof slots.register !== 'function') return

  ctx.effect(
    () =>
      slots.inject('sidebar.footer.action', () =>
        slots.register({ name: 'sidebar.footer.action', id: 'dsh-wsl' }, AddWslAction),
      ),
    'dsh-wsl: sidebar footer action',
  )
}
