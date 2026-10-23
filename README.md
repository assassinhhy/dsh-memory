# dsh-memory

DeepSeek Harness 的有界常驻记忆插件。`USER.md` 与 `MEMORY.md` 在新会话开头冻结注入；日记只检索、不常驻。全文以 Markdown 为准，SQLite 只是可重建的索引。

兼容 DeepSeek Harness `>=0.2.1-0 <0.3.0`（见 `packages/dsh-memory/package.json` 的 `engines.dsh`）。插件不改写 `AGENTS.md`，不读不写 `.credentials.yaml`，也不改 LLM provider 或默认模型。

## 功能

- **常驻记忆**：`USER.md`（画像、偏好、禁忌，2000 字符）与 `MEMORY.md`（环境、约定、踩坑，4000 字符）。超限整次拒绝，不截断。
- **日记**：`journal/YYYY-MM-DD.md`，按 `Asia/Shanghai` 分日。只参与检索。
- **工具**：写入、按 id 或锚点改删、列出、混合检索、置顶、重建索引、立刻周整理，以及包装官方 `sessionQuery` 的 `session_search`。
- **回合整理**：默认每 6 个已完成回合，用当前会话的模型决定追加、更新、删除或不动。失败只记日志。
- **衰减**：检索先融合全文和向量，再按使用情况重排。置顶不衰减。衰减不删除任何文件。
- **周整理**：用默认模型看条目摘要，写出合并、归档、晋升、冲突四类建议。建议必须人工同意后才执行。
- **设置页**：设置 → 记忆。可看占用和条目、改半衰期、处理建议、恢复归档、打开目录、重建索引。

## 安装

需要本机已有 `dsh` 命令，并且 `pnpm` 在 `PATH` 上。`dsh plugin` 会把参数转给 pnpm。把下面的 `web` 换成你的 profile 名。

### 克隆后按本地目录安装

仓库根目录不是插件包。可安装的包在 `packages/dsh-memory`，入口 `index.js` 和设置页 `lib/client.js` 已经提交，克隆后不必先构建。

本地目录是 `link:` 安装。插件自己的依赖（`@huggingface/transformers`、`undici`）要装在包目录里，Node 才能从链接目录解析到它们。该目录带有 `package-lock.json`：

```sh
git clone https://github.com/assassinhhy/dsh-memory.git
cd dsh-memory/packages/dsh-memory
npm install
cd ../..
dsh plugin --profile web add ./packages/dsh-memory
```

Windows 上把最后一步写成 `dsh plugin --profile web add .\packages\dsh-memory`。

### 从 GitHub 安装

裸的 `github:assassinhhy/dsh-memory` 指向仓库根。根目录没有 `package.json`，这样装不上。包在子目录，用 pnpm 的 `path:` 参数：

```sh
dsh plugin --profile web add "github:assassinhhy/dsh-memory#path:/packages/dsh-memory"
```

要锁定某次提交时，把完整 SHA 和子目录写在同一个说明符里（`&` 需要引号）：

```sh
dsh plugin --profile web add "github:assassinhhy/dsh-memory#<commit>&path:/packages/dsh-memory"
```

`package.json` 没有 `prepare` 脚本。git 安装拿到的就是已提交的 `index.js` 和 `lib/client.js`，不需要为构建单独放行脚本。依赖由 pnpm 按该包的 `dependencies` 安装。

### npm 上的同名包不是这个插件

本仓库没有发布到 npm。registry 上的 `dsh-memory@0.1.0` 是另一位维护者的不同项目（描述为不含向量模型的 SQLite 记忆）。`dsh plugin add dsh-memory` 会装到那个包。请使用上面的本地目录，或带 `path:` 的 GitHub 说明符。

### 桌面 profile

`desktop` 经常被桌面应用占用，命令行可能改不了它。打开 DeepSeek Harness → 插件 → **添加插件**，填入克隆目录下 `packages/dsh-memory` 的完整路径，安装并启用。这一步做一次即可。之后这个目录仍是链接，改代码并重启就会读到新文件。

### 可选：Windows 安装脚本

`scripts/Install-DshMemory.ps1` 面向已经有一份 DeepSeek Harness **源码树** 的环境。它会：

1. 运行 `node scripts/build.mjs`，重新生成 `packages/dsh-memory/lib/client.js`
2. 在 `packages/dsh-memory` 里用 pnpm 安装插件依赖
3. 把目标 profile 的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml` 备份为 `*.bak-mem-<时间戳>`
4. 在 Harness 源码根执行 `pnpm dsh plugin --profile <profile> add <clone>/packages/dsh-memory`

```powershell
.\scripts\Install-DshMemory.ps1 -DshRoot <Harness 源码目录> -Profiles web
```

省略 `-DshRoot` 时，脚本把**本仓库的上一级目录**当作 Harness 源码根。`-Profiles` 默认是 `desktop,web`。`desktop` 不会被脚本修改，只打印 `packages/dsh-memory` 的路径，供上面的「添加插件」使用。

`-Proxy` 默认是 `http://127.0.0.1:7890`，`-Registry` 默认是 `https://registry.npmmirror.com`。不使用这组代理和镜像时，传入你自己的值。脚本不改 LLM provider，也不碰 `.credentials.yaml`。

只有 `dsh` 命令、没有 Harness 源码树时，用上面的 `dsh plugin add`，不必跑这个脚本。

### 装好之后

重启 DeepSeek Harness。新开会话才会带上记忆快照。设置 → 记忆 可以确认插件已加载。

改了 `packages/dsh-memory/src/client.src.js` 之后，在仓库根运行 `node scripts/build.mjs`（需要 Node 20 或更新），再重启。

## 数据目录

记忆根目录是 `DSH_HOME` 下的 `memory/`。未设置 `DSH_HOME` 时，用当前用户主目录里的 `.dsh`：

| 系统 | 默认路径 |
|---|---|
| macOS / Linux | `~/.dsh/memory` |
| Windows | `%USERPROFILE%\.dsh\memory` |

设置了 `DSH_HOME` 时，路径是 `%DSH_HOME%\memory`（Windows）或 `$DSH_HOME/memory`。`AGENTS.md` 和 `.credentials.yaml` 在 `memory/` 旁边，本插件不读写它们。

| 路径 | 上限 | 作用 |
|---|---|---|
| `USER.md` | 2000 字符 | 画像、偏好、禁忌。会话开头冻结注入 |
| `MEMORY.md` | 4000 字符 | 环境、约定、踩坑。同上 |
| `journal/YYYY-MM-DD.md` | 按日不限 | 日记。只检索，不常驻 |
| `archive/YYYY-MM.md` | 不限 | 归档。可恢复，不是删除 |
| `review/YYYY-Www.json` 与同名 `.md` | — | 周整理建议。`.json` 是事实来源 |
| `index.sqlite` | — | FTS5 trigram、向量缓存、`entry_meta`。删掉会重建 |
| `models/` | — | bge-m3 权重。不进 git |
| `session-index.sqlite` | — | 官方 `sessionQuery` 的持久索引 |

字符按 JavaScript 的 `string.length`（UTF-16 码元）计算，常用汉字算 1。上限含条目标记，按整文件计。

已有的 `USER.md` / `MEMORY.md` 不会被清空。工具只追加带 id 的条目，或按你给出的 id / 锚点修改、删除。手改 Markdown 是合法的；**下一次新会话**才进入提示词。本会话里的快照保持不变，以免打掉 prompt cache。

条目标记：

```markdown
<!-- dsh-mem id="e-1a2b3c4d" tags="tooling" -->
记住我默认用 pnpm
<!-- /dsh-mem -->
```

没有标记的原文在 `memory_list` 里显示为 `unfenced`，可以整段替换。读取时不会改写原文。

疑似密钥、token、私钥或密码赋值会整段拒绝。错误只说明检测种类，不回显原文。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_add` | 写入 `user` / `memory` / `journal` |
| `memory_replace` | 按 id 或唯一原文锚点修改。改动算「用过」 |
| `memory_remove` | 按 id 或锚点删除 |
| `memory_list` | 列出常驻条目、字符占用和元数据。省略 target 时列出 USER 与 MEMORY |
| `memory_search` | FTS5 trigram + 本地 bge-m3，RRF 融合后再按衰减重排。含日记，结果带 `score` / `last_used` |
| `memory_pin` | 置顶或取消置顶。`USER.md` 条目默认置顶 |
| `memory_consolidate` | 立刻跑一次周整理，只产出建议 |
| `memory_reindex` | 从 Markdown 重建索引 |
| `session_search` | 包装 `ctx.sessionQuery`。同一工作区，不含本会话 |

超限时返回明确错误，并建议可删的长条目，不截断。

`session_search` 不自建会话全文索引。插件的 `cordis.patch.yml` 把 `session-query-sqlite` 的 `openAt` 从 `never` 改成 `first-search`，从而能搜到 `DSH_HOME/sessions` 里的旧 JSONL，索引落在 `memory/session-index.sqlite`。权限与官方工具一致：没有 cwd 不能跨会话；目标会话必须属于当前工作区。profile 自己的 `cordis.patch.yml` 若把该行又写回 `never`，以 profile 为准，工具会说明原因。

## 回合整理

默认每 6 个已完成回合，用当前会话的模型看最近对话，决定 `ADD` / `UPDATE` / `DELETE` / `NOOP`。这不是每条消息都抽一次。失败只记日志，不打断对话。

设置 → 记忆 可以关掉（`autoReview`），或把间隔 `reviewEvery` 改成 1–100。

## 衰减排序

检索命中先按 RRF 融合，再按使用情况重排：

```
score = rrf × decay × (1 + log2(1 + use_count) × 0.25)
decay = 0.5 ^ (距上次使用的天数 / 半衰期)
```

默认半衰期：`USER.md` 60 天、`MEMORY.md` 60 天、`journal` 21 天。使用加成 `useBoost` 默认 `0.25`。置顶条目的 `decay` 为 1。衰减只影响排序，不删除任何东西。

「用过」指：`memory_search` 的结果进入回复上下文，或 `memory_replace` 改了这条。会话开头的整文件注入不算。

## 周整理

每周用当前默认模型看条目摘要（不含日记全文；每条摘录约 160 字），产出四类建议：

| 类型 | 含义 | 同意之后 |
|---|---|---|
| `merge` | 重复条目合并 | 保留一个 id 并改写，其余归档 |
| `stale` | 长期未用，建议归档 | 搬进归档，可恢复 |
| `promote` | 日记里的事实值得常驻 | 按建议写入 USER 或 MEMORY |
| `conflict` | 互相矛盾 | 列出两边；统一说法可编辑后再同意 |

- 启动时若距上次整理超过 7 天（`consolidateDays`）且 `autoConsolidate` 为开，会自动跑一次。也可以在设置页点「立即整理」，或调用 `memory_consolidate`。
- 建议写入 `review/YYYY-Www.json` 和同名 `.md`，带 `key` 和处理状态。周次按 `Asia/Shanghai` 的 ISO 周。
- 每条都要人工同意、拒绝，或编辑后同意。可以一键全部拒绝。未处理的建议不会自动执行。
- 置顶条目只会出现在 `merge` / `conflict` 里，不会进入 `stale`。
- 归档搬进 `archive/YYYY-MM.md`。设置页可以恢复。合并或晋升若会超过字符上限，整条拒绝并说明没有截断。

## 设置

打开 **设置 → 记忆**。这一页可以：

- 查看 `USER.md` / `MEMORY.md` 的字符占用
- 开关自动回合整理，修改每 N 轮
- 查看向量模型状态（就绪、下载中或失败）
- 打开记忆目录、重建索引、刷新
- 浏览条目：最后使用、使用次数、衰减分、置顶、归档、编辑、删除
- 修改衰减参数：USER / MEMORY / 日记半衰期，以及使用加成
- 处理整理建议：同意、拒绝、编辑后同意、一键全部拒绝；查看上次与下次整理时间；立即整理
- 在归档区恢复条目

插件配置里还有这些默认值（当前页面没有单独的开关）：`embed` 默认开，`vectorWaitMs` 默认 2000，`autoConsolidate` 默认开，`consolidateDays` 默认 7，`consolidateBatchChars` 默认 6000。

向量模型在第一次需要时下载 **Xenova/bge-m3** 的 q8 ONNX（约 570MB）到 `memory/models/`。设置了 `HTTPS_PROXY` 或 `HTTP_PROXY` 时，下载走该代理；都未设置时，下载器会尝试 `http://127.0.0.1:7890`。代理不可用或权重还没下完时，`memory_search` 先返回全文结果，并标明向量未就绪。权重不进 git。

## 测试

在仓库根目录、使用带 `node:sqlite` 的 Node 运行（DeepSeek Harness 自带的运行时即可；本仓库在 Node 26 上验证过 FTS5 trigram）：

```sh
node --test tests/*.test.js
node scripts/smoke-memory.mjs
node scripts/smoke-m2.mjs
```

覆盖字符上限、整段拒绝密钥、快照冻结、检索融合排序、工作区权限边界、衰减公式与置顶不衰减、使用计数、手改 Markdown 后的元数据对齐、整理建议 schema、置顶不进 stale、归档可恢复、超限拒绝。这些测试使用临时目录。`smoke-m2.mjs` 在结束时核对正式记忆文件的字节没有变化；它的模型调用是 mock，不会打真实 API。

可选：`node scripts/smoke-embed.mjs` 会把 bge-m3 权重下载到当前 `DSH_HOME/memory/models`（或 `~/.dsh/memory/models`）。它不改写 `USER.md`、`MEMORY.md` 或 `AGENTS.md`。

## 非目标

不做 Dreaming、知识图谱、每条消息抽取、云端 embedding、自动晋升、自动删除。周整理只产出建议；衰减只改变排序。

## 许可

[MIT](LICENSE)
