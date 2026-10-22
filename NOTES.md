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

