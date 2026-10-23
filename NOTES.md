# NOTES.md — 运行时补充（拉姆）

- 2026-10-22：人格已定为「贝蒂」；`C:\Users\Gabi\.dsh\AGENTS.md` 已是契约精灵人设（叫主人、有个性、会纠正）。**禁止覆盖/改写 AGENTS.md 的人格部分。**
- 已预置种子：`C:\Users\Gabi\.dsh\memory\USER.md`、`MEMORY.md`。插件应读取这些路径；可扩充，不要清空重写成空壳。
- 其余仍以 CLAUDE_TASK_M1.md 为准。

## 实现取舍（2026-10-22）

- 密钥策略是**整段拒绝**，不打码后写入。打码壳（`password=[REDACTED]`）看起来像保存成功，也会把“这里有过密钥”写进模型上下文。错误只报检测器种类，不回显原文。
- 条目标记用 HTML 注释，读取时不重写种子。手改 Markdown 仍然合法；`unfenced` 代表未标记正文。
- 字符按 JS `string.length`（UTF-16）。常用中文是 1 字。上限算整文件，含标记，超限不截断。
- 日记按 `Asia/Shanghai` 分日。
- 索引用 Node 自带 `node:sqlite` 的 FTS5 trigram（本机 Node 26 已验证）。向量是暴力余弦，语料很小，不引入 hnsw。
- bge-m3 走 `@huggingface/transformers` 的 q8 ONNX，懒加载，缓存到 `DSH_HOME/memory/models/`。下载只改 embedder 自己的 `env.fetch`（undici ProxyAgent），不改进程级 dispatcher，避免和 `dsh-network-proxy` 打架。模型没就绪时搜索退回 FTS，并在结果里说明。
- 冻结快照挂在 `agent/created` 的 scoped `systemPrompt.section` 上，`interpolate: false`，避免记忆里的 `{{` 被当成变量。同一 session id 第一次读盘获胜，压缩/重建 agent 不会刷新本会话快照。
- 官方 `session-query-sqlite` 出厂是 `openAt: never`，直接包装会搜不到旧 JSONL。插件补丁在后一层把 `openAt` 改成 `first-search`，索引用 `dshHomePath('memory/session-index.sqlite')`。这是文档写明的启用方式，不改上游源码。profile 自己的 patch 若重写该行，以 profile 为准。
- `session_search` 自己实现与官方工具相同的 cwd 围栏，不依赖默认未挂载的 `@deepseek-ai/dsh-tool-session-query`，避免和实验包抢同一个工具名。
- 后台 review 听 `session/event` 的 `turn/end`（completed / max-tokens），推迟到 append 之外并吞掉异常。不用 `agent/turn-stopping`，那个钩子抛错会把回合标成失败。
- **auto-review 的 DELETE 是软删**：模型契约不变（仍输出 `action: DELETE`），但执行时写进 `archive/YYYY-MM.md` 并可 `restore`，绝不硬删；archive 失败就整次失败并记录，不回退到 `remove`。设置页的「删除（不可恢复）」仍是显式硬删（主人点删才算）。

## 实现取舍（M2，2026-10-22）

- 元数据放 `index.sqlite` 的 `entry_meta` 侧表，按裸 id（`e-…` / `p-…` / `unfenced`）索引，不往 Markdown 里塞字段。多一个 `orphaned_at` 列：手删的 id 和归档的 id 要分得清——归档是主动离开语料，不能标 orphan。归档行不参与 orphan 标记。
- 「用过」= `memory_search` 结果进了回复上下文，或 `memory_replace` 改了这条。返回即计数（结果整批都进了上下文）；会话开头的冻结快照注入**不计**，否则每条每天都会「被用一次」，衰减等于失效。
- `USER.md` 条目默认置顶：建行时写 1，读取时再兜底一次（`row?.pinned ?? file === 'user'`），防止历史行漏标。
- 衰减纯函数在 `src/decay.js`，只重排不删除。`memory_search` 会先取比 limit 大的候选窗再重排截断，避免高衰减的早期强命中把新命中挤出候选。没有元数据行的命中保持 `score = rrf`（不编造新鲜度）。
- `toMs` 同时接受 Date / 毫秒数 / 数字字符串 / ISO 串：kv 表把 `consolidate.lastAt` 存成字符串，`Date.parse("1792739040000")` 是 NaN，不特判就会让「上次整理时间」永远为空、`due` 永远为真。
- 归档记录用 `<!-- dsh-arch … -->` 包住**原始 dsh-mem 条目块**，restore 原样贴回，字节级还原；先写归档文件再删源文件，崩在中间不会丢文本。`safeRestorePath` 只认 `USER.md` / `MEMORY.md` / `journal/YYYY-MM-DD.md`，拒绝 `..`。
- 周整理产出**建议**，永不自动执行。模型可以瞎说，所以解析 fail-closed（坏条目丢弃，不抛进对话）；置顶条目即使被模型写进 `stale` 也会被剔除并记 `droppedIds`。同周重跑按 `type|排序后ids` 签名去重，人工决策不复活。
- 整理只喂摘要：id、文件、置顶、使用次数、创建/最近使用时间、tags + 160 字摘录。超阈值分批，每批一次模型调用。默认模型走 `agentDefaultModel.currentSelection()`，退化到会话 `requestHeader().config` / `agent.options` 的老路。
- merge/conflict 同意后保留 `ids[0]` 改写、其余归档；promote 只是往 user/memory 追加。三者都撞字符上限时整条拒绝（报「没有截断」），绝不截断写入。
- 周整理文件按 ISO 周命名（`Asia/Shanghai`，`2026-W43`），建议带 `key`/`status`/`decidedAt`/`resolution`，`.json` 是事实来源、`.md` 只给人看。

## 实现取舍（M3，2026-10-22）

条目模型（A）：

- id 是**内容哈希**（规范化文本 sha256 前 10 位，`l-` 列表项 / `p-` 散文块），不带位置。插入、删除、改写别的条目都不会动它的 id——这是「改相邻行不影响它」能做到的原因。
- 改写采用**就地重写**（返回新 id + 元数据迁移），**不做** `e-` 标记提升。提升会让手写种子正文长出工具标记，也会让「谁写的」混进人类排版。代价：改过那条的 id 会变，返回里必须带 `id=旧 → 新`。
- 散文严格按空行分块，**标题自己也是一块**。若把标题和后面的段落绑在一起，删掉段落会连标题一起换 id——那正是要避免的抖动。代价：小标题会作为独立 `p-` 条目出现在 list 里。
- 列表项连着更深缩进的续行/子项合成一条（它们是同一件事）；空行一般结束条目，只有下一行缩进更深时才续（松散列表）。
- 重复文本按出现次序编号：第一条用裸 id，之后 `~2`、`~3`。**删掉/改掉前面那条，后面的会重新编号**（id 跟内容哈希 + 次序走）。受影响的 id 都在 `affectedIds` 里，`entry_meta` 走 `migrate` 跟过去，不留孤儿行。删除时若幸存者顶替了被删 id，迁移用 `replace` 语义丢掉被删那行的计数，不把两条的 use_count 加在一起。
- 改删只动该条自己的字节跨度（跨度不含行尾；删除顺带走一个空行分隔）。`unfenced` 保留为整段未标记正文的遗留别名（v0.1.0 语义），它会按标记条目重组文件，不算字节级。
- 返回契约：成功路径**不允许 `id=null`**。add `{id, entry, affectedIds, diff}`；replace `{id: 新, previousId, affectedIds, renames, diff}`；remove `{id: 被删, affectedIds, removedIds, renames, diff}`。`renames` 交给 runtime 在 sync 之前做 `meta.migrate`。迁移前先按「谁腾出 id 谁先走」排一次拓扑序（`orderRenames`）：把 `甲` 改写成邻条 `乙` 的文本时，甲会顶到乙的旧 id、乙被挤成 `~2`，若按文档顺序先迁甲就会 `migrate` 合并进乙那一行，计数串号。删除路径上「幸存者顶到被删 id」另用 `replace` 语义丢掉被删那行的计数。
- diff 是手写的 LCS 行 diff + unified hunk（`src/diff.js`），只覆盖受影响条目，超过 40 行截断并注明「完整改动以文件为准」。不引第三方库。
- `index-db.chunksFrom` 改用共享的 `splitProse` 编号，list / search / meta 一套 id。`SCHEMA_VERSION` 升到 2，旧索引自动重建（元数据表不重建，仍按裸 id）。

稳定关键事实（B）：

- `detectKeyFact` 是纯启发式（`src/keyfact.js`）：主机名（`DESKTOP-…`、`*.local`）、端口（`端口 7890`、`:7890`）、路径（`D:\…`、`~/…`、`/home/…`）、域名/URL、IP、账号（邮箱、`github.com/…`、`@xxx`）。返回 `{ kinds: [] }`，不含原文。
- **只建议不自动置顶**：写入/改写后，目标条目未置顶且命中才多一行 `💡 …建议 memory_pin id=…`。USER.md 默认置顶，所以提示基本只出现在 MEMORY.md。置顶之后不再提示。
- 取舍：`:7890` 这类裸冒号数字会当成端口（宁可多提一次）；`password: 12345` 可能误报端口。反过来 `export=12345` 不算（`port` 要独立单词）。邮箱只算账号，不再同时算域名。密钥/token 本来就被脱敏整段拒绝，这里不分类。

超限建议（C）：

- 仍然**整次拒绝、不截断、不自动执行**，只是把「去删点什么」换成三组具体建议：`toJournal`（日期叙事/今天刚才/进度踩坑/长叙述）、`merge`（三元组 Jaccard ≥ 0.3 的相似对，保留长的）、`trim`（剩下最长的几条）。每项带 id、chars、preview、reason。
- 估算句按**实际会释放的字数**算（各组的丢弃方去重求和）：「挪走这些后可释放约 N 字，足以写入本次 M 字」；不够就写「仍不够本次 M 字（还差 K 字）」。
- 置顶条目永不进任何一组；正在写的那条（excludeIds）也不进。有 `entry_meta` 时按「从未用过优先、再最久没用、再最长」排；没有就退化成纯长度。
- `trim` 跳过 merge 对的两边（那一对已经由 merge 负责），避免同一个 id 被两组同时算释放量。

