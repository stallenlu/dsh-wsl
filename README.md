# dsh-wsl

WSL workspaces for DeepSeek Harness. A rebuild of
[`dsh-wsl-workspace`](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace)
on a different substrate: **one persistent agent process inside the distribution**,
reached over a JSON-lines pipe, instead of a 9P file share plus a spawn per command.
中文版：[README.zh-CN.md](README.zh-CN.md)（内容对应，以本文为准）.

```
browser ──POST /dsh-wsl/api──▶ host plugin ──pipe──▶ node agent.mjs (in distro)
                                     │                        │
                                     └── ctx.fs / ctx.shell ◀─┘
```

## Why the substrate changed

Measured on this machine against a live Ubuntu distro:

| operation | 9P share (`//wsl.localhost/…`) | one `wsl.exe` spawn per call | this agent |
| --- | --- | --- | --- |
| `stat` | 4.3 ms | 212–282 ms | **0.20 ms** |
| `readdir` | 2.8 ms | 212–282 ms | **0.25 ms** |
| run a command | — | 212–282 ms | **13–20 ms** |
| glob a 5.2 GB repo (64,625 files) | 44 s (and misses ~half the tree) | — | **0.59 s** |

Three consequences follow, and all three are the point of the rebuild:

- **No polling.** The old plugin swept the share every 3 s and walked it every 30 s so
  it could notice changes. Against a share, each sweep is a batch of multi-millisecond
  metadata calls that reaches into the distro and, when WSLg is on, pulls focus to the
  Windows desktop every half minute. The agent is asked on demand, so those timers are
  gone rather than tuned — nothing touches the distro while it is idle.
- **`/mnt/<drive>` works.** A 9P share serves `ext4` only; the drvfs mounts are
  invisible to it, which forced the old plugin to reroute those paths to Windows
  drive letters and to synthesize `/mnt` entries by probing every drive. Inside the
  distribution `/mnt/c` is just a directory, so the rerouting and the probe are deleted
  along with the class of bug where a workspace key and its path disagreed.
- **Search runs in the distribution.** `grep` and `glob` are the shipped tools backed by
  a packaged Windows `ripgrep`, which against a share is not merely slow: a whole-home
  walk took **44 s** over 9P versus **0.29 s** in-distro, a content search **150 s**
  versus **0.79 s**, and the 9P run returned 22,436 lines where the native one returned
  41,838 — it silently missed about half the tree. So the WSL variant swaps in
  `search-wsl`, which runs the distro's own `rg` through the agent. The same
  `glob '*.toml'` query answers 891 files in 2.3 s.

## What it does for you

- **Add a WSL workspace from the sidebar.** In the Workspaces section header, press the
  **W** button beside the shipped “添加工作区” control (it falls back to a bottom-list
  entry when the header is absent). The dialog lists your installed distributions and
  browses the Linux filesystem; “添加此文件夹” registers the folder through the host's
  own workspace registry — a WSL workspace is just a host workspace whose path is a UNC
  path (`\\wsl.localhost\Ubuntu\home\you\…`), so there is exactly one record and no
  private store to drift.
- **The sidebar terminal follows the session in.** A session whose workspace is a WSL
  path opens its terminal *inside* the distribution — a real bash with a real pty
  (input, output and resize all round-trip). Windows-cwd sessions are untouched.
- **The model gets WSL-native tools.** A `wsl-<mode>` twin of every healthy preset
  replaces the shell/fs tools with the WSL ones and adds `grep`/`glob` that run the
  distro's own ripgrep — including `/mnt/<drive>` and unreadable-directory tolerance
  (exit 2 keeps the partial results instead of failing the call).
- **Localized.** The dialog follows `navigator.language`: Simplified Chinese for
  `zh-*`, English otherwise.

## What is in here

| file | role |
| --- | --- |
| `agent/agent.mjs` | zerodep Node script run inside the distro: `stat`, `lstat`, `readdir`, `read`, `readRange`, `write`, `mkdir`, `remove`, `realpath`, `exec`, `kill`, `ping` over JSON lines. Reconstructs the login environment once at startup so `--exec` still sees `~/.local/bin`. |
| `src/channel.ts` | host side of that pipe: spawns the agent, pairs replies by id, idles closed after 10 minutes (idle = no request outstanding, so a 30-minute test run is never killed), one channel per distro, reopen-on-death. |
| `src/shell.ts` | `WslShellExecutor extends ShellExecutor` — exit codes, stream split, live streaming, timeout that kills the process group, tail-preserving output cap, background handles whose unobserved rejection can never kill the host. |
| `src/fs.ts` | `WslFileSystem extends FileSystem` — 12 primitives, version-guarded writes, `FS_STALE_VERSION`/`FS_AMBIGUOUS_EDIT`/`FS_NOT_TEXT` handling, sandbox fencing, atomic write by rename, and **byte-faithful CRLF**: the seam's LF normalization applies to the reported `before`/`after` only, never to the bytes on disk. |
| `src/search.ts` | the `grep` and `glob` tools, running ripgrep **inside** the distribution. |
| `src/terminal.ts` | makes the sidebar terminal follow a WSL session in: wraps the host's single `subprocess.spawnTerminal` so a UNC cwd launches `wsl.exe -d <distro> --cd <linux> -- <shell>`. |
| `src/client/index.tsx` | browser half: the **W** header entry (via `src/client/hostEntry.ts`) with the bottom-list entry as fallback + discovery anchor; the add-workspace dialog (`src/client/styles.ts` styles it with `--dsw-*` tokens only, `src/client/locale.ts` carries the zh/en strings). |
| `src/host/variants.ts` | preset transform that rewrites an agent preset into its WSL variant. Works on **parsed rows**, never on indentation. |
| `src/rows.ts` | the `wsl-world` group: `shell-wsl` + `fs-wsl` + `search-wsl` under `isolate: {shell: true, fs: true}`. |
| `src/index.ts` | host entry: distro discovery, `wsl-<mode>` materialization, `DSH_WSL_DISTRO`, and one loopback-only POST route. |

## The sidebar seat

The **W** control mounts beside the shipped add-workspace button in the Workspaces
section header — the treatment the old `dsh-wsl-workspace` plugin shipped. The header is
host-private (no slot declares it), so `src/client/hostEntry.ts` mirrors the reference's
technique: walk up from the footer action's own DOM element to
`[class*="_sectionHeader"]` / `[class*="_headerActions"]`, inject a `<span class="dww-header-slot">`
and React-render `HostEntryButton` into it with the add button's own class list, and
observe the strip because React re-renders drop unknown children. The strip's 60 px cap
is widened to 92 px while the entry is seated (`max-width: 92px` in
`src/client/styles.ts`) or the third button is clipped; the shipped-hidden variant keeps
it collapsed.

The footer entry stays registered on `sidebar.footer.action` (a `list` slot,
`replaceRisk: "none"`, fresh id `dsh-wsl`) — hidden while the header seat is present,
and the fallback when the header is absent (rail sidebar, a release that renames the
classes). It is also the anchor the header discovery walks up from.

## The terminal

The sidebar terminal is *not* driven by the `terminals` registry, so adding a terminal
backend does not reach it. `terminalController` gets its environment from
`agent.ctx.get('subprocess')` and calls `subprocess.spawnTerminal(...)` directly. That
service is single-slot and `agent.ctx` sits outside any preset group, so a preset cannot
provide a WSL one — isolation only propagates to descendants, and the preset registry
rejects a service that leaks into the host realm.

What it can do instead is wrap the host provider's `spawnTerminal` in place, which
`src/terminal.ts` does. The discriminator is already in the request: a session inside a
distribution has a UNC cwd, and the wrapper rewrites that one call into

    wsl.exe -d <distro> --cd <linux cwd> -- <shell>

so the host's own ConPTY carries a real Linux pty — input, output and `resize` all
round-trip. Sessions with a Windows cwd pass through untouched, byte for byte.

`resolveExecutable` and `terminalEnvironment` are deliberately left alone: they answer
host-wide questions (which `bash.exe` exists on Windows), and answering them from inside a
distribution would be a different claim than the one those call sites are making.

## Preset variants, not a mode

The shell dialect has to change with the world: outside a distribution the agent runs
`pwsh`, inside it runs `bash`. So instead of a global routing provider, every healthy
preset in the profile gets a `wsl-<mode>` twin (`standard` → `wsl-standard`) whose shell
and file tools are the WSL ones. The rest of the preset — persona, skills, jobs,
delegation — is carried through untouched.

The transform matches rows by `id` in the parsed document, which makes it immune to the
indentation fragility that made a nested `subagent` row invisible to the original
(`tool "subagent" is already registered in this scope`). It also clears a `disabled: !!js
process.platform === 'win32'` gate off a row it lifts into the world: that expression is
evaluated by the loader on the host, so carrying it along would disable the very tool the
variant exists to provide.

`!!js` expressions survive the round trip as `{__jsExpr: …}` nodes, which is the shape the
host loader itself tests for, so a re-registered preset still evaluates its own gates.

## Installing, updating, verifying

```text
# source of truth — edit here
C:\Users\GT14\Documents\deepseek-harness\wsl-rework\next\
# the copy the harness actually loads (a FILE COPY, not a symlink)
C:\Users\GT14\.dsh\profiles\desktop\node_modules\dsh-wsl\
```

Because the installed copy is a copy, every source change needs a reinstall; from a
DeepSeek Harness session:

1. `npm run verify` in the source tree (typecheck + build + 58 checks).
2. `plugin_manager remove_bundle target=dsh-wsl`, then
   `plugin_manager install_bundle target=file:C:\Users\GT14\Documents\deepseek-harness\wsl-rework\next`.
3. Restart DSH (the reinstall answers `application: "restart-required"`).
4. If the entry ever disappears again: check `dsh.profile.bundles` in
   `C:\Users\GT14\.dsh\profiles\desktop\package.json` still contains `dsh-wsl`
   (a concurrent profile rewrite has dropped it before), and
   `plugin_manager set_bundle target=dsh-wsl enabled=true` re-mounts it hot — no
   restart needed — when the boot is stable and no other HMR transaction is open.

Quick host-side check without the UI:

```sh
curl -X POST http://127.0.0.1:<gui-port>/dsh-wsl/api \
  -H "content-type: application/json" -d '{"method":"listDistros"}'
# → {"ok":true,"value":{"distros":[{"name":"Ubuntu","default":true}]}}
```

`check` and `listDir` go through the persistent in-distro agent, so a 200 with real
entries proves the whole pipe.

## Developing

```sh
npm install          # devDependencies pin the 0.2.1-rc.5 host surface
npm run typecheck
npm run build        # lib/{index,fs,shell,search,client}.js
npm test             # 58 checks; live ones skip when no distro is present
npm run verify       # typecheck, then build + test
```

`tests/live.test.ts` runs against a real distro and skips — rather than fails — when
`wsl.exe -l -q` returns nothing, so the suite is honest on a machine without WSL.
`tests/client.test.ts` loads the built bundle the way the host's loader does, so `npm test`
builds first (`pretest`); that is the only place the browser half is checked, because
`tsconfig.json` excludes it.

## Deliberate non-goals

- **No `fs.watch`.** The distro's filesystem cannot be watched from the host; the sidebar
  file browser swallows the resulting `workspace-file/watch-unsupported` code and does a
  one-shot refresh instead. The reference plugin had no watch either.
- **`sandboxMode` is `undefined`.** The WSL VM is the boundary; there is nothing inside it
  for the host's sandbox policy to fence.
- **No `wsl_terminal` model tool / persistent-shell terminal door / workspace context-menu
  items.** The old plugin's model-side terminal and menu hack are superseded: the model
  uses the persistent channel (structured exit codes and streams, faster than driving a
  pty), and people use the sidebar terminal, which now enters the distribution on its own.
