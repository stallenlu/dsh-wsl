/**
 * Row vocabulary for preset compositions.
 *
 * A preset document is a YAML sequence of loader entries. We only ever touch the
 * fields we own, so rows are typed loosely and passed through by reference.
 */
export type Row = Record<string, unknown>

/** Provider ids the WSL world registers. */
export const WSL_PROVIDERS = { shell: 'shell-wsl', fs: 'fs-wsl', search: 'search-wsl' } as const

/** Where a WSL world group's providers come from. */
export interface WorldPaths {
  /** Absolute path to this package's shell executor entry (`lib/shell.js`). */
  shell: string
  /** Absolute path to this package's filesystem backend entry (`lib/fs.js`). */
  fs: string
  /** Absolute path to this package's search tools entry (`lib/search.js`). */
  search: string
  /**
   * Optional pinned distribution. Left empty, both providers read the distro
   * from the path they are handed, so ONE variant serves every distribution —
   * no per-distro preset variants, no rebuild when a distro is added.
   */
  distro?: string
  /** Optional starting directory; unset means the path handed in wins. */
  cwd?: string
  /** Executable that starts the in-distro agent. Defaults to the service's `node`. */
  nodePath?: string
}

/**
 * Build the `wsl-world` group.
 *
 * `isolate` on `shell` and `fs` gives the variant its own instances of those two
 * services without hiding them from the rest of the host — everything else
 * (tools, jobs, terminals) keeps resolving the services it already knows.
 */
export function wslWorldGroup(paths: WorldPaths): Row {
  const config: Row = {}
  if (paths.distro) config['distro'] = paths.distro
  if (paths.cwd) config['cwd'] = paths.cwd
  if (paths.nodePath) config['nodePath'] = paths.nodePath
  const provider = (id: string, name: string): Row =>
    Object.keys(config).length === 0 ? { id, name } : { id, name, config: { ...config } }
  return {
    id: 'wsl-world',
    name: 'cordis:group',
    group: true,
    isolate: { shell: true, fs: true },
    config: [
      provider(WSL_PROVIDERS.shell, paths.shell),
      provider(WSL_PROVIDERS.fs, paths.fs),
      // Registers the `grep` / `glob` tools. It takes only the distro — the
      // search directory comes from the session path, like every other row.
      paths.distro
        ? { id: WSL_PROVIDERS.search, name: paths.search, config: { distro: paths.distro } }
        : { id: WSL_PROVIDERS.search, name: paths.search },
    ],
  }
}
