# dsh-memory

Hermes 式有界常驻核 + OpenClaw 式 Markdown 分层。全文以 Markdown 为准，SQLite 只是可重建的索引。不覆盖 `AGENTS.md`，不读不写 `.credentials.yaml`。

## 安装

在本目录：

```powershell
.\scripts\Install-DshMemory.ps1
.\scripts\Install-DshMemory.ps1 -Profiles web
```

脚本会：

1. `node scripts/build.mjs` 生成设置页 `lib/client.js`
2. 如需代理可设 `HTTPS_PROXY`；国内可用 npmmirror 安装插件依赖
3. 备份 profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` 为 `*.bak-mem-<时间戳>`
4. 在 dsh 源码根执行 `pnpm dsh plugin --profile <p> add packages/dsh-memory`

`desktop` profile 被桌面应用占用时，脚本不会改它，只打印本地目录。到 DeepSeek Harness → 插件 → 添加插件，填入：

```
<本仓库>/packages/dsh-memory
```

装一次即可。之后改代码，重新跑本脚本（或至少 `node scripts/build.mjs`）再重启。

不会改 llm provider、默认模型，也不会碰 `.credentials.yaml`。

## 目录

根目录是 `%USERPROFILE%\.dsh\memory\`，尊重 `DSH_HOME`。

| 文件 | 上限 | 作用 |
|---|---|---|
| `USER.md` | 2000 字符 | 画像、偏好、禁忌。会话开头冻结注入 |
| `MEMORY.md` | 4000 字符 | 环境、约定、踩坑。同上 |
| `journal/YYYY-MM-DD.md` | 按日不限 | 日记。只检索，不常驻 |
| `archive/YYYY-MM.md` | 不限 | 归档区。条目可恢复，不是删除 |
| `review/YYYY-Www.json` + `.md` | — | 周整理建议（含人工决策状态） |
| `index.sqlite` | — | FTS5 trigram + 向量缓存 + `entry_meta` 元数据，可删，会重建 |
| `models/` | — | bge-m3 权重。不进 git |
| `session-index.sqlite` | — | 官方 sessionQuery 的持久索引（插件补丁打开 `openAt: first-search`） |

已有的 `USER.md` / `MEMORY.md` 种子不会被清空。工具只追加带 id 的条目，或按你指定的 id / 锚点改删。手改 Markdown 合法，**下一次新会话**才进入提示词。本会话里的快照不变，以免打掉 prompt cache。

条目标记：

```markdown
<!-- dsh-mem id="e-1a2b3c4d" tags="tooling" -->
记住我默认用 pnpm
<!-- /dsh-mem -->
```

没有标记的原文会在 `memory_list` 里显示为 `unfenced`，可以整段替换，不会在读取时被改写。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_add` | 写入 user / memory / journal |
| `memory_replace` | 按 id 或唯一原文锚点修改。改动算「用过」 |
| `memory_remove` | 删除 |
| `memory_list` | 列出常驻条目、字符占用和元数据 |
| `memory_search` | FTS5 trigram + 本地 bge-m3，RRF 融合后按衰减重排。含日记，结果带 `score` / `last_used` |
| `memory_pin` | 置顶 / 取消置顶（`USER.md` 条目默认置顶） |
| `memory_consolidate` | 立刻跑一次周整理 |
| `memory_reindex` | 从 Markdown 重建索引 |
| `session_search` | 包装 `ctx.sessionQuery`。同一工作区，不含本会话 |

超限返回明确错误和建议删除的长条目，**不截断**。检测到密钥、token、密码赋值会拒绝写入，错误信息不回显密钥。

`session_search` 不自建会话 FTS。插件补丁把 `session-query-sqlite` 的 `openAt` 从 `never` 改成 `first-search`，这样能搜到 `~/.dsh/sessions` 里的旧 JSONL。权限与官方工具一致：没有 cwd 不能跨会话；目标会话必须属于当前工作区。若 profile 自己的 `cordis.patch.yml` 又把该行改回 `never`，以那边为准，工具会说明原因。

## 自动整理

默认每 6 个已完成回合，用当前会话的模型看最近对话，决定 ADD / UPDATE / DELETE / NOOP。失败只记日志，不打断对话。这不是每条消息都抽一次。设置里可以关掉，或改 N。

## 衰减排序

检索命中先按 RRF 融合，再按使用情况重排：

```
score = rrf × decay × (1 + log2(1 + use_count) × 0.25)
decay = 0.5 ^ (距上次使用的天数 / 半衰期)
```

半衰期：`USER.md` 60 天、`MEMORY.md` 60 天、`journal` 21 天（可配）。置顶条目永不衰减。**衰减只影响排序，不删除任何东西。**

「用过」的定义：`memory_search` 把结果送进回复上下文，或 `memory_replace` 改了这条。会话开头的整文件注入不算。

## 周整理（Consolidation）

每周用当前默认模型看一遍条目摘要（不含 journal 全文），产出四类**建议**：

| 类型 | 含义 | 执行时 |
|---|---|---|
| `merge` | 重复条目合并 | 保留一个 id 改写，其余归档 |
| `stale` | 长期未用，建议归档 | 归档（可恢复） |
| `promote` | 日记里的事实值得常驻 | 只建议写入 USER/MEMORY |
| `conflict` | 互相矛盾 | 列出两边，统一说法可编辑 |

- 触发：启动时距上次超过 7 天自动跑；设置页「立即整理」；工具 `memory_consolidate`。
- 建议写进 `review/YYYY-Www.json` + 同名 `.md`，带 `key` 和处理状态。
- **永不自动执行。** 每条要人工点同意 / 拒绝 / 编辑后同意，可一键全部拒绝。
- 置顶条目只会出现在 merge/conflict，**绝不进 stale**。
- 归档搬进 `archive/YYYY-MM.md`，设置页可一键恢复。merge/promote 超字符上限整条拒绝并提示，**不截断**。

## 设置

设置 → 记忆：条目表（最后使用 / 使用次数 / 衰减分 / 📌 置顶 / 归档）、衰减参数（半衰期与使用加成）、整理建议（同意 / 拒绝 / 编辑后同意、一键全部拒绝、上次与下次整理时间、立即整理）、归档区（恢复）、字符占用、开关自动整理、改 N、编辑/删除条目、打开文件夹、重建索引。

向量模型第一次使用时经代理下载 **bge-m3 q8**（约 570MB）到 `memory/models/`。没下完时 `memory_search` 先用全文，结果里会标明向量未就绪。权重不进 git。

## 测试

```powershell
node --test tests/*.test.js
node scripts/smoke-m2.mjs
```

覆盖字符上限、脱敏、快照冻结、检索融合排序、工作区权限边界、衰减公式与置顶不衰减、使用计数、md 手改后元数据对齐、整理建议 schema、置顶不进 stale、归档可恢复、超限拒绝。不写真实的 `~\.dsh\memory`（冒烟脚本跑完还会核对正式文件字节不变）。

## 不做

Dreaming、知识图谱、每条消息抽取、云端 embedding、自动晋升、自动删除。
