# DONE.md — dsh-memory

日期：2026-10-22。只动了 `dsh-memory/` 和上游 `.gitignore` 里的 `dsh-memory/` 一行。没有改 `AGENTS.md`，没有读、没有写 `.credentials.yaml`。种子 `USER.md` / `MEMORY.md` 未被清空。

## 交付了什么

可安装的 overlay：`packages/dsh-memory`。

- `USER.md`（2000）/ `MEMORY.md`（4000）/ `journal/YYYY-MM-DD.md`。超限拒绝，不截断。密钥整段拒绝，错误不回显原文。
- 工具：`memory_add` `memory_replace` `memory_remove` `memory_list` `memory_search` `memory_reindex` `session_search`。
- 新会话在 `agent/created` 注入冻结快照；本会话内改文件不刷新提示词。
- 索引：`node:sqlite` FTS5 trigram + 本地 bge-m3 q8，RRF。模型缓存在 `%USERPROFILE%\.dsh\memory\models\`（约 570MB），不进 git。
- 每 N 轮（默认 6）后台 review，失败不打断对话。
- 设置 → 记忆：占用、开关整理、编辑/删除、打开文件夹、重建索引。
- 插件补丁把 `session-query-sqlite` 的 `openAt` 设为 `first-search`，`session_search` 包装官方 `ctx.sessionQuery`，cwd 围栏与官方工具一致。

## 安装

```powershell
cd D:\Tool\deepseek-harness\dsh-memory
.\scripts\Install-DshMemory.ps1 -DshHome "$env:USERPROFILE\.dsh" -Profiles web,desktop
```

代理 `http://127.0.0.1:7890`，包走 npmmirror。web 已 link 过会跳过。desktop 不能用 CLI 改，到应用里：插件 → 添加插件，填：

```
D:\Tool\deepseek-harness\dsh-memory\packages\dsh-memory
```

装一次，点立即启用。之后改代码重新跑脚本再重启。重启后新会话才带上记忆快照。

## 测试

`node --test tests/*.test.js`：21 通过，0 失败。覆盖字符上限、脱敏、快照冻结、RRF、中文 FTS、工作区围栏。测试只用临时目录。

`scripts/smoke-embed.mjs`（本机已缓存的 bge-m3 q8）：

- dim 1024
- 「默认包管理器是 pnpm」vs「用哪种命令拉取第三方库」余弦 0.502
- vs「今天天气不错」0.306
- 同义排名高于无关句，`bge-m3 synonym ranking ok`

安装脚本本次结果：web 已安装，跳过；desktop 只打印了上面的手动 link 路径。更早一次 `dsh --profile web --dump-config` 已看到 `dsh-memory` 行，以及 `session-query-sqlite.openAt: first-search`。当时 web 能起来，并在 `~\.dsh\memory\index.sqlite` 里索引了现有种子，没有改写 md。

## 已知缺口

- desktop 还要在应用里手动 link 一次。
- 没有对 `~\.dsh\sessions` 跑过一次真实 `session_search`。引擎已按官方方式打开，围栏有单测；第一次搜索会建 `memory/session-index.sqlite`。
- 若 profile 自己的 `cordis.patch.yml` 又把 `session-query-sqlite` 写回 `never`，以那边为准，工具会说明原因。
- 搜自己当前会话的事件时，不剔除进行中的那一步；跨会话搜索会排除本会话。
- 未做 Dreaming、知识图谱、每条消息抽取、云端向量。

## 验收（2026-10-22 19:20，CLAUDE_TASK_VERIFY）

证据文件：`_verify_tests.txt` / `_verify_session_search.txt` / `_verify_memory_smoke.txt` / `_claude_verify.out`。
说明：验收 Claude 开了后台 workflow，约 10 分钟后被 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING` 掐掉，未自行改写本文件；实测结果如下，由拉姆据证据补记。

| 项 | 结果 |
|---|---|
| `node --test tests/*.test.js` | 21 pass / 0 fail（约 159ms） |
| 真实 `session_search`（`~\.dsh\sessions`） | ok；`session-index.sqlite` 已用；docs 89→100；16 次查询有命中 |
| memory 冒烟（临时 `DSH_HOME`） | add → search → list → remove 全过，正式记忆未污染 |
| desktop link | `dsh-memory` 已在 dependencies + bundles |
| 保护文件 | `AGENTS.md` / `USER.md` / `MEMORY.md` / `.credentials.yaml` 未改写（见 `_verify_protected_before.json`） |

`VERIFY_DONE` 未由 Claude 打印（后台超时打断）；实质验收项已通过。

---

# M2 — 衰减 + 整理面板 + 周整理

日期：2026-10-22。只改 `dsh-memory/`。没有改上游 dsh 源码、rem-theme、`AGENTS.md`、`.credentials.yaml`；没有读、没有写任何 key/token。迁移过程中没有重写正式 `USER.md` / `MEMORY.md`（本任务全部写入走临时 `DSH_HOME`）。

## 交付了什么

- **条目元数据**：`index.sqlite` 里的 `entry_meta` 侧表（`id, file, created_at, last_used_at, use_count, pinned, archived_at, last_seen_hash`，外加 `orphaned_at` 区分手删与归档）。Markdown 仍是唯一事实来源：`sync()` 在每次写盘后对齐——新 id 建行（`USER.md` 默认置顶），消失的 id 标 orphan（保留不删），改写只动 `last_seen_hash`，计数器留存。
- **使用计数**：`memory_search` 的返回结果进入回复上下文、或 `memory_replace` 改动条目，才算「用过」。会话开头的整文件注入不计。
- **衰减排序**（只排序，不删除）：`score = rrf × decay × (1 + log2(1+use_count) × 0.25)`，`decay = 0.5^(距上次使用天数 / 半衰期)`。半衰期 user 60 天 / memory 60 天 / journal 21 天，`use_boost=0.25`，全在 cordis 配置里，设置页可改。置顶不衰减（`decay = 1`）。`memory_search` 结果带 `score` 与 `last_used`。
- **周整理（Consolidation，不是 Dreaming）**：启动时超过 7 天未整理自动跑一次；设置页「立即整理」按钮；工具 `memory_consolidate`。每个摘要批次一次模型调用，走当前默认模型（`agentDefaultModel.currentSelection()`），只喂条目摘要 + 元数据（160 字摘录），绝不整段 journal。输出 `merge / stale / promote / conflict` 四类建议，写 `review/YYYY-Www.json` + 同名 `.md`。**永不自动执行**；置顶条目只会出现在 merge/conflict，绝不进 stale（模型硬塞也会被剔掉并记 `droppedIds`）。同周重跑按 `type|ids` 签名去重，已决策的不复活。
- **执行语义**：归档 = 搬到 `archive/YYYY-MM.md`（可恢复），不是删除；restore 按原路径放回并校验路径穿越。merge 冲突类保留一个 id 改写、其余归档；promote 只是建议写入。merge/promote 超字符上限整条拒绝（报「没有截断」），绝不截断。
- **设置页**：条目表（最后使用 / 使用次数 / 衰减分 / 📌 置顶 / 归档）、衰减参数、整理建议（按类型分组，同意 / 拒绝 / 编辑后同意 + 一键全部拒绝，显示上次与下次整理时间 + 立即整理）、归档区（可恢复）。顺手修了 M1 设置页 `status`/`setStatus` 未声明、toast 从不显示的 bug。
- **新工具**：`memory_pin`（置顶/取消）、`memory_consolidate`（立刻整理）。
- **新配置**：`halfLifeUser` `halfLifeMemory` `halfLifeJournal` `useBoost` `autoConsolidate` `consolidateDays` `consolidateBatchChars`（均 volatile）。

## 测试

`node --test tests/*.test.js`：45 通过，0 失败（M1 的 21 条原样全绿，新增 24 条）。覆盖衰减公式与半衰期、置顶不衰减、use_count 加成、md 手改后元数据对齐（新增/删除/改写）、建议 schema 校验、置顶不进 stale、归档可恢复、merge 超限拒绝、模型调用全 mock。

`scripts/smoke-m2.mjs`（临时 `DSH_HOME`，全 mock 模型）8 步全过：

| 步骤 | 结果 |
|---|---|
| 旧 / 置顶 / 常用 三条种子 | ok |
| `memory_search` 排序 | `frequent > pinned > old`（旧条目虽最先写入、FTS 原始分最好） |
| 使用计数 | 检索一次后 old=1、frequent=9 |
| mock 周整理 | `review/2026-W43.json` + `.md`，一次模型调用，模型想 stale 置顶条目被剔除 |
| 同意 stale → 归档 | 进 `archive/2026-10.md`，`MEMORY.md` 里消失，置顶条目无恙 |
| 恢复 | 回到 `MEMORY.md`，归档记录消费掉，二次同意报 `already_decided` |
| 正式 `~\.dsh\memory` | 前后字节不变 |

## 安装

```powershell
cd D:\Tool\deepseek-harness\dsh-memory
.\scripts\Install-DshMemory.ps1 -Profiles web
```

desktop 已 link，重启即可。代理 `http://127.0.0.1:7890`，包走 npmmirror。

## 已知缺口

- `memory_consolidate` 的真实模型调用没跑过（单元与冒烟全 mock，按任务要求不打真 API）。
- 设置页的整理建议操作只走 HTTP 端点（`/dsh-memory/suggestion` 等），没有单独的 e2e 浏览器测试。
- 手改 Markdown 后的元数据对齐有单测；对真实 `~\.dsh\memory` 的大规模历史手改没有跑过迁移脚本（本来也不需要：首次启动 `sync()` 会就地建行）。
- 不做知识图谱、每条消息抽取、云端向量、自动晋升、自动删除。
