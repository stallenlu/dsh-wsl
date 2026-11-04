/**
 * Address conversion between the three path dialects this plugin meets:
 *
 * - **UNC** — `\\wsl.localhost\<distro>\<linux path>`, what the harness stores
 *   as a workspace key and what every `fs` target ultimately names.
 * - **Linux absolute** — `/home/user/x`, what a shell inside the distribution
 *   uses and what the agent speaks.
 * - **Windows drive** — `C:\x` from the host, which inside the distribution is
 *   `/mnt/c/x`.
 *
 * Getting this wrong is how the reference plugin ended up synthesizing `/mnt`
 * from `statSync('C:\\')` and rerouting drvfs paths: it could only see 9P, and
 * 9P serves ext4 but answers *access denied* for drvfs. The agent is inside
 * the distribution, so `/mnt/c` is simply a directory and the whole workaround
 * disappears. All that is left is naming the same file in each dialect.
 * @module dsh-wsl/paths
 */

/** Where one path lives: a distribution plus a path inside it. */
export interface Address {
  distro: string
  /** Absolute POSIX path inside the distribution. */
  path: string
}

/** Legal distribution names, matching `wsl.exe -l`. */
const DISTRO = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/

/**
 * Split a UNC workspace path into its distribution and Linux path.
 * @param value - `\\wsl.localhost\Ubuntu\home\x`, `/wsl.localhost/...`, or `\\wsl$\Ubuntu\...`.
 * @returns the address, or `undefined` when the value is not a WSL UNC path.
 */
export function parseUnc(value: string): Address | undefined {
  const normalized = value.replace(/\//g, '\\')
  const match = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\(.*))?$/i.exec(normalized)
  if (!match) return undefined
  const distro = match[1]!
  if (!DISTRO.test(distro)) return undefined
  const rest = (match[2] ?? '').replace(/\\/g, '/')
  return { distro, path: toPosix('/' + rest) }
}

/**
 * Render an address in the UNC dialect the harness stores as a workspace key.
 * @param distro - the distribution name.
 * @param path - an absolute POSIX path inside it.
 * @returns the UNC form.
 */
export function toUnc(distro: string, path: string): string {
  return `\\\\wsl.localhost\\${distro}${toPosix(path).replace(/\//g, '\\')}`
}

/**
 * Translate a Windows drive path to its mount point inside a distribution.
 * @param value - `C:\Users\x` or `C:/Users/x`.
 * @returns the `/mnt/c/Users/x` form, or `undefined` for anything else.
 */
export function driveToMnt(value: string): string | undefined {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value)
  if (!match) return undefined
  return toPosix(`/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`)
}

/**
 * Normalize a POSIX path: collapse repeated separators, resolve `.` and `..`,
 * and drop a trailing separator. Purely lexical — no filesystem access, so it
 * cannot be tricked by a symlink and does not cost a round-trip.
 * @param value - any absolute POSIX path.
 * @returns the normalized absolute path.
 */
export function toPosix(value: string): string {
  const parts: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return '/' + parts.join('/')
}

/**
 * Test whether `child` is `parent` or a descendant of it, on path boundaries.
 * @param parent - normalized absolute POSIX path.
 * @param child - normalized absolute POSIX path.
 */
export function containsPosix(parent: string, child: string): boolean {
  if (parent === '/') return true
  return child === parent || child.startsWith(parent + '/')
}

/**
 * Resolve any accepted dialect against an optional base into an address.
 * @param value - UNC, Windows drive, Linux absolute, or relative path.
 * @param base - the address relative paths resolve against, and the distro
 *   for a Windows drive path (a drive path is only meaningful inside some distro).
 * @returns the address, or `undefined` when no distribution can be determined.
 */
export function resolveAddress(value: string, base?: Address): Address | undefined {
  const unc = parseUnc(value)
  if (unc) return unc

  const mounted = driveToMnt(value)
  if (mounted) return base ? { distro: base.distro, path: mounted } : undefined

  if (!base) return undefined
  if (value.startsWith('/')) return { distro: base.distro, path: toPosix(value) }
  return { distro: base.distro, path: toPosix(base.path + '/' + value) }
}

/**
 * The WSL distribution a workspace path belongs to, without resolving it.
 * @param value - any accepted dialect.
 * @returns the distribution name, or `undefined`.
 */
export function distroOf(value: string): string | undefined {
  return parseUnc(value)?.distro
}
