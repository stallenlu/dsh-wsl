# dsh-wsl

DeepSeek Harness 的 WSL 工作区插件。对
[`dsh-wsl-workspace`](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace)
的重写，基座不同：**发行版内一个常驻 agent 进程**，走 JSON-lines 管道通信，
而不是 9P 文件共享加每次命令一个 spawn。

（本文为 [README.md](README.md) 的中文版，内容对应；以英文版为准。）

## 致谢

本插件离不开
[`dsh-wsl-workspace`](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace)
及其作者 **刘云韬（[@6Mikao9](https://github.com/6Mikao9)）** 与各位维护者的工作。
那个插件验证了本插件所服务的完整工作流——从侧栏添加 WSL 工作区、让整个会话
跑在发行版内——它的客户端设计（标题栏入口挂载、添加工作区弹窗、footer
席位回退）正是 `src/client/` 遵循的蓝图。本插件换的是基座，不是想法：
向原作者与维护者致谢。

dsh-wsl 的问题请在本仓库提 issue；`dsh-wsl-workspace` 本身的问题请到它
自己的仓库反馈。

```
浏览器 ──POST /dsh-wsl/api──▶ 宿主插件 ──管道──▶ node agent.mjs（发行版内）
                                    │                       │
                                    └── ctx.fs / ctx.shell ◀─┘
```

## 为什么换基座

在本机对真实 Ubuntu 发行版实测：

| 操作 | 9P 共享（`//wsl.localhost/…`） | 每次调用一个 `wsl.exe` spawn | 本 agent |
| --- | --- | --- | --- |
| `stat` | 4.3 ms | 212–282 ms | **0.20 ms** |
| `readdir` | 2.8 ms | 212–282 ms | **0.25 ms** |
| 跑一条命令 | — | 212–282 ms | **13–20 ms** |
| 对 5.2 GB 仓库 glob（64,625 个文件） | 44 s（且漏掉约一半目录树） | — | **0.59 s** |

由此带来三个后果，也是重写要达到的全部目的：

- **不再轮询。** 旧插件每 3 s 扫一遍共享、每 30 s 走一遍目录树来感知变化。
  对共享而言每轮巡检都是一串多毫秒的元数据调用，会伸进发行版，而且 WSLg
  开着时每半分钟把焦点拉到 Windows 桌面一次。现在 agent 是按需被问询的，
  所以这些定时器是被删掉而不是被调优——空闲时没有任何东西碰发行版。
- **`/mnt/<盘符>` 可用。** 9P 共享只服务 `ext4`，drvfs 挂载对它不可见，
  这逼得旧插件把这些路径改路由到 Windows 盘符、靠探测每个盘来合成 `/mnt`
  条目。在发行版内 `/mnt/c` 只是个目录，改路由和探测随之删掉，连同
  「工作区键与它的路径不一致」这一类 bug 一起消失。
- **搜索在发行版内执行。** 旧插件的 `grep`/`glob` 是宿主工具，靠打包的
  Windows ripgrep 对共享跑：整仓走一遍 **44 s**（9P）对比发行版内
  **0.29 s**，内容搜索 **150 s** 对比 **0.79 s**，而且 9P 那次返回 22,436
  行、原生返回 41,838 行——悄悄漏了约一半目录树。所以 WSL 变体换上
  `search-wsl`，通过 agent 跑发行版自己的 `rg`。同一个 `glob '*.toml'`
  查询 2.3 s 返回 891 个文件。

## 它为你做什么

- **从侧栏添加 WSL 工作区。** 在「工作区」分区标题栏，按自带「添加工作区」
  控件旁的 **W** 按钮（标题栏不存在时回退到底部列表入口）。弹窗列出已安装
  的发行版并浏览 Linux 文件系统；「添加此文件夹」通过宿主自己的工作区
  注册表登记——WSL 工作区只是路径为 UNC（
  `\\wsl.localhost\Ubuntu\home\you\…`）的宿主工作区，只有这一条记录，
  没有会漂移的私有存储。
- **侧栏终端跟着会话进发行版。** 工作区是 WSL 路径的会话，其终端*在发行版
  内*打开——真正的 bash 配真正的 pty（输入、输出、resize 全部回环）。
  Windows cwd 的会话原样不动。
- **模型拿到 WSL 原生工具。** 每个健康预设都有一个 `wsl-<mode>` 孪生变体
  （`standard` → `wsl-standard`），把 shell/fs 工具换成 WSL 版，并新增跑
  发行版自带 ripgrep 的 `grep`/`glob`——覆盖 `/mnt/<盘符>`，对不可读目录
  宽容（exit 2 保留部分结果而不是让整次调用失败）。
- **已本地化。** 弹窗跟随 `navigator.language`：`zh-*` 显示简体中文，
  其余英文。

## 目录里有什么

| 文件 | 职责 |
| --- | --- |
| `agent/agent.mjs` | 发行版内运行的零依赖 Node 脚本：`stat`、`lstat`、`readdir`、`read`、`readRange`、`write`、`mkdir`、`remove`、`realpath`、`exec`、`kill`、`ping`，走 JSON lines。启动时重建一次登录环境，`--exec` 也能看到 `~/.local/bin`。 |
| `src/channel.ts` | 管道的宿主侧：拉起 agent、按 id 配对回复、10 分钟空闲即关（空闲 = 无未完成请求，30 分钟的测试跑不会被杀）、每个发行版一条通道、死后重开。 |
| `src/shell.ts` | `WslShellExecutor extends ShellExecutor`——退出码、流分离、实时流、杀进程组的超时、保尾输出上限、后台句柄（其未观察的 rejection 永远不会杀死宿主）。 |
| `src/fs.ts` | `WslFileSystem extends FileSystem`——12 个原语、版本守卫写入、`FS_STALE_VERSION`/`FS_AMBIGUOUS_EDIT`/`FS_NOT_TEXT` 处理、沙盒围栏、rename 原子写，以及**逐字节保真的 CRLF**：接缝的 LF 归一化只作用于上报的 `before`/`after`，永不动磁盘字节。 |
| `src/search.ts` | `grep` 和 `glob` 工具，ripgrep 在发行版**内**执行。 |
| `src/terminal.ts` | 让侧栏终端跟着 WSL 会话进去：包装宿主唯一的 `subprocess.spawnTerminal`，UNC cwd 改写为 `wsl.exe -d <distro> --cd <linux> -- <shell>`。 |
| `src/client/index.tsx` | 浏览器半边：**W** 标题栏入口（经 `src/client/hostEntry.ts`），底部列表入口作回退兼发现锚点；添加工作区弹窗（`src/client/styles.ts` 只用 `--dsw-*` 令牌 styling，`src/client/locale.ts` 放中英文字符串）。 |
| `src/host/variants.ts` | 预设变换：把 agent 预设改写成它的 WSL 变体。只操作**解析后的行**，不碰缩进。 |
| `src/rows.ts` | `wsl-world` 组：`shell-wsl` + `fs-wsl` + `search-wsl`，置于 `isolate: {shell: true, fs: true}` 下。 |
| `src/index.ts` | 宿主入口：发行版发现、`wsl-<mode>` 物化、`DSH_WSL_DISTRO`、一条仅回环的 POST 路由。 |

## 侧栏席位

**W** 控件挂在「工作区」分区标题栏里自带添加按钮旁——旧
`dsh-wsl-workspace` 插件的处理方式。标题栏是宿主私有的（没有任何 slot 声明
它），所以 `src/client/hostEntry.ts` 沿用参考插件的手法：从 footer
action 自己的 DOM 元素向上走到
`[class*="_sectionHeader"]` / `[class*="_headerActions"]`，注入一个
`<span class="dww-header-slot">`，用添加按钮自己的类名列表把
`HostEntryButton` React 渲染进去，并观察该条带（React 重渲染会丢弃陌生
子节点）。条带 60 px 的宽度上限在入口就位期间放宽到 92 px（
`src/client/styles.ts` 里的 `max-width: 92px`），否则第三个按钮被裁切；
shipped-hidden 变体则保持收起。

底部入口仍注册在 `sidebar.footer.action`（`list` 型 slot、
`replaceRisk: "none"`、新 id `dsh-wsl`）——标题栏席位在场时隐藏，标题栏
缺席时作回退（rail 侧栏、发版改了类名）。它也是标题栏发现向上走的锚点。

## 终端

侧栏终端*不由* `terminals` 注册表驱动，加终端后端够不着它。
`terminalController` 从 `agent.ctx.get('subprocess')` 取环境，直接调
`subprocess.spawnTerminal(...)`。该服务是单槽的，`agent.ctx` 在任何预设组
之外，所以预设无法提供 WSL 版——隔离只向后代传播，预设注册表还会拒绝泄进
宿主域的服务。

它能做的是原地包装宿主 provider 的 `spawnTerminal`，`src/terminal.ts` 就是
这么干的。判别信息本来就在请求里：发行版内的会话 cwd 是 UNC，包装器把这一
次调用改写成

    wsl.exe -d <发行版> --cd <linux cwd> -- <shell>

于是宿主自己的 ConPTY 带起一个真正的 Linux pty——输入、输出、`resize` 全部
回环。Windows cwd 的会话逐字节原样通过。

`resolveExecutable` 和 `terminalEnvironment` 有意不动：它们回答的是宿主级
问题（Windows 上哪个 `bash.exe` 存在），从发行版内回答是另一种主张，与那些
调用点的语义不符。

## 预设变体，不是全局模式

shell 方言必须随世界改变：发行版外 agent 跑 `pwsh`，发行版内跑 `bash`。
所以不做全局路由 provider，而是给 profile 里每个健康预设一个 `wsl-<mode>`
孪生（`standard` → `wsl-standard`），其 shell 与文件工具换成 WSL 版。
预设其余部分——人设、技能、任务、委派——原样带过。

变换按 `id` 在解析后的文档里匹配行，因此对原版那种「嵌套 `subagent` 行
不可见」（`tool "subagent" is already registered in this scope`）的缩进脆弱
性免疫。它还会把被抬进 world 的行上的 `disabled: !!js
process.platform === 'win32'` 门清掉：该表达式由加载器在宿主上求值，带过去
会恰好禁用这个变体要提供的工具。

`!!js` 表达式以 `{__jsExpr: …}` 节点形状在往返中保留——这正是宿主加载器
自己测试的形状，所以重新注册的预设仍会求值自己的门。

## 安装、更新、验证

**从 GitHub 安装（任意机器）：** 把仓库加为 profile 依赖并启用 bundle。在
DeepSeek Harness 会话里，或手动改 profile 的 `package.json`：

```sh
# 在 C:\Users\<你>\.dsh\profiles\desktop\ 下
pnpm add "dsh-wsl@github:stallenlu/dsh-wsl"        # 或 npm i，写法相同
```

```json
"dependencies": {
  "dsh-wsl": "github:stallenlu/dsh-wsl"
}
```

然后在同一文件的 `dsh.profile.bundles` 里加 `"dsh-wsl"` 并重启 harness。
`github:` 规格按 tarball 拉取，每次升版本整体替换副本——没有 `file:` 那套
remove/reinstall 流程。

**本地检出（开发）：**

```text
# 真源——在这里改
C:\\Users\\GT14\\Documents\\deepseek-harness\\wsl-rework\\next\\
# harness 实际加载的副本（是文件复制，不是符号链接）
C:\\Users\\GT14\\.dsh\\profiles\\desktop\\node_modules\\dsh-wsl\\
```

因为安装副本是复制，每处源码改动都要重装；在 DeepSeek Harness 会话里：

1. 源码树里 `npm run verify`（类型检查 + 构建 + 58 项检查）。
2. `plugin_manager remove_bundle target=dsh-wsl`，然后
   `plugin_manager install_bundle target=file:C:\\Users\\GT14\\Documents\\deepseek-harness\\wsl-rework\\next`。
3. 重启 DSH（重装返回 `application: "restart-required"`）。
4. 如果入口又消失了：先看
   `C:\\Users\\GT14\\.dsh\\profiles\\desktop\\package.json` 的
   `dsh.profile.bundles` 是否还含 `dsh-wsl`（并发的 profile 改写曾把它
   掉过），再 `plugin_manager set_bundle target=dsh-wsl enabled=true`
   热挂载——启动稳定且没有其他 HMR 事务时无需重启。

不进 UI 的快速宿主侧自检：

```sh
curl -X POST http://127.0.0.1:<gui-port>/dsh-wsl/api \\
  -H "content-type: application/json" -d '{"method":"listDistros"}'
# → {"ok":true,"value":{"distros":[{"name":"Ubuntu","default":true}]}}
```

`check` 和 `listDir` 走发行版内的常驻 agent，所以 200 加真实条目即可证明
整条管道通。

## 开发

```sh
npm install          # devDependencies 钉住 0.2.1-rc.5 宿主接口
npm run typecheck
npm run build        # lib/{index,fs,shell,search,client}.js
npm test             # 58 项检查；live 的在没有发行版时跳过而非失败
npm run verify       # 类型检查，然后 build + test
```

`tests/live.test.ts` 对真实发行版运行，`wsl.exe -l -q` 无输出时跳过——
所以在没有 WSL 的机器上套件依然诚实。`tests/client.test.ts` 按宿主加载器
的方式加载构建产物，所以 `npm test` 先构建（`pretest`）；那是浏览器半边
唯一被检查的地方，因为 `tsconfig.json` 排除了它。

## 有意不做

- **不做 `fs.watch`。** 宿主侧无法监听发行版的文件系统；侧栏文件浏览器会
  吞掉随之产生的 `workspace-file/watch-unsupported` 码并做一次性刷新。
  参考插件同样没有 watch。
- **`sandboxMode` 保持 `undefined`。** WSL 虚拟机本身就是边界，宿主沙盒
  策略在它内部没有可围栏的东西。
- **不做 `wsl_terminal` 模型工具 / persistent-shell 终端门 / 工作区右键
  菜单项。** 旧插件的模型侧终端和菜单 hack 已被取代：模型走常驻管道
  （结构化退出码与流，比驱动 pty 更快），人走侧栏终端，而侧栏终端现在
  自己就能进发行版。
