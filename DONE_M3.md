# DONE_M3.md — M3 完成报告

- 分支：本地 `m3`（未 push、未打 tag、未发 release、未改 remote）
- 版本：`packages/dsh-memory/package.json` → `0.2.0-m3`（不发布）
- 日期：2026-10-23
- 状态：A/B/C 三项全部完成，`node --test tests/*.test.js` 全绿

---

## 1. 改动清单（文件 + 要点）

### 新增文件

| 文件 | 要点 |
|---|---|
| `packages/dsh-memory/src/diff.js` | 手写最小行级 LCS diff + unified hunk（`--- a/…` / `+++ b/…` / `@@`）。只覆盖受影响条目 + 2 行上下文，超过 40 行截断并追加「…（diff 过长已截断，完整改动以文件为准）」。前后相等返回 `''`。不引第三方库。 |
| `packages/dsh-memory/src/keyfact.js` | 纯函数 `detectKeyFact(text) → { kinds: [] }`。识别主机名（`DESKTOP-…`/`LAPTOP-…`/`*.local`）、端口（`端口 7890`、`port 8080`、`:7890`）、路径（`D:\…`、`C:\Users\…`、`~/.dsh/…`、`/home/…`、UNC）、域名/URL、IP（逐段 ≤255 校验）、账号（邮箱、`github.com/xxx`、`@xxx`）。kinds 排序去重；`keyFactLabel` 渲染成「端口/路径」。 |
| `packages/dsh-memory/src/limit-suggest.js` | 纯函数 `suggestForLimit(items, opts)` → `{ toJournal, merge, trim, incoming, overflow, freed, enough }`。toJournal=日期叙事/今天刚才/进度踩坑/长叙述；merge=三元组 Jaccard≥0.3 的相似对（保留长的）；trim=剩下最长的几条。每项带 `id/chars/preview/reason`。置顶条目与 `excludeIds` 永不入选；有 meta 时按「从未用过 → 最久没用 → 最长」排。 |
| `tests/entry-model.test.js` | 10 项：拆分规则、id 稳定性、重复 `~2` 编号、字节级改删、store 级 `l-` replace/remove、锚点非空 id、`unfenced` 兼容、list/search id 一致、diff 截断。 |
| `tests/keyfact.test.js` | 6 项：各模式识别、密钥/版本号不误报、`keyFactLabel`、runtime `suggestPin`（含不自动置顶、USER.md 不提示、改写后在新 id 上提示）。 |
| `tests/limit-suggest.test.js` | 5 项：分组字段齐全、置顶不进建议、meta 排序、中文建议文案 + 估算句、真实超限写入被整次拒绝且文件字节不变。 |

### 修改文件

| 文件 | 要点 |
|---|---|
| `packages/dsh-memory/src/document.js` | 核心。新增共享 `splitProse(text, counter)`（列表项含更深缩进续行/子项；空行一般断开，只有下一行更深才续；其余散文按空行分块，标题单独一块）、`eachItem(raw)`（带字节跨度的全部条目：`e-`/`l-`/`p-`）、`replaceItem`/`removeItem`（只动该条跨度）、`renderItemBlock`、`itemsInRange`、`lineNumberAt`、`hasUnfenced`。id=内容哈希（规范化文本 sha256 前 10 位），重复文本首次用裸 id、其后 `~2`/`~3`。`replaceItem` 对散文块不再跑 `stripMarker`（避免吃掉正文里像列表标记的首行）。`removeItem` 会带走一个空行分隔；若删的是末条则回吃前面的分隔。 |
| `packages/dsh-memory/src/store.js` | 重写写路径。`locateEntry` 支持 `l-`/`p-`（多文件命中 → `ambiguous`；`unfenced` 仍是「第一个有正文的文件」）。`planReplace`/`planRemove` 统一产出 `{id, previousId?, affectedIds, removedIds?, renames, diff, entry}`。锚点路径解析到它所在的条目 id，**成功路径不再可能 `id=null`**。`overLimit` 换成分组建议 + `incoming/overflow/freed/enough`，签名带 `current`（本次新增字数）与 `getMeta`（置顶/使用信号）。add/replace/remove 全部回传 `diff`（`{before, after, text}`）。 |
| `packages/dsh-memory/src/meta.js` | 新增 `migrate(from, to, opts)`：把 use_count/last_used/pinned/created_at 跟着 id 改名搬走并删旧行（**不是 orphan + 新行**）。目标行已存在时默认合并（use_count 相加、last_used 取新、pinned 取或）；`opts.replace` 用于「幸存者顶替了刚被删的 id」，直接丢掉被删那行的计数。 |
| `packages/dsh-memory/src/index-db.js` | `chunksFrom` 改用共享 `listItems`（= `splitProse` 编号），list / search / meta 一套 id。`SCHEMA_VERSION` 1 → 2，旧索引自动重建。 |
| `packages/dsh-memory/src/runtime.js` | `createStore` 注入 `getMeta`。写成功后先 `applyRenames(result.renames, result.removedIds)` 做 meta 迁移，再 `markUsed`、再 `sync`。改名先经 `orderRenames` 排序（**先腾空 id 再迁入**），否则「改写后撞上邻条 id」会把两行合并、计数串号。add/replace 成功后按 `detectKeyFact` + 置顶状态挂 `suggestPin`（只在 user/memory、未置顶时）。`list()` 给每条补 `pinned`/`useCount`。 |
| `packages/dsh-memory/src/format.js` | `formatWrite`：`已更新/已写入 target id=旧 → 新（used/limit 字符）` + `affected:` + `💡 像是稳定关键事实（端口/路径），建议 memory_pin id=…` + diff 回显。`formatRemove`：`已删除 target id=…` + affected + diff。`formatList`：一行一条 `- id [kind] N字 📌 预览`。`formatFailure`：toJournal/merge/trim 三组中文清单 + 「挪走这些后可释放约 N 字，足以写入本次 M 字」+「只建议，不会自动删除/合并/挪动」。 |
| `packages/dsh-memory/src/consolidate.js` | `collectEntries` 不再只收 `e-` 条目，`l-`/`p-` 也进整理范围（`unfenced` 仍跳过）。 |
| `packages/dsh-memory/index.js` | 工具描述与 `TOOL_GUIDE` 改成 M3 口径：`l-`/`p-`/`e-` id、改写后 id 会变（返回 旧→新）、`unfenced` 变 legacy、💡 置顶建议、超限三组建议 + 估算。 |
| `README.md` | 新增「条目模型」小节（内容哈希 id、重复 `~2`、就地重写 + 元数据迁移、字节级保留）；工具表补返回格式；超限/置顶建议说明；测试清单补 M3 覆盖；「不做」补自动置顶/自动合并/超限自动腾挪。 |
| `NOTES.md` | 新增「实现取舍（M3，2026-10-22）」：内容哈希 id、**就地重写而非 `e-` 提升**、标题单独成块、重复编号会随前项重排（含 meta 迁移顺序）、字节跨度与空行分隔、返回契约、diff 手写与截断、keyfact 取舍（裸冒号数字算端口、`export=12345` 不算、邮箱只算账号）、超限三组与估算口径（trim 跳过 merge 对，避免重复计释放量）。 |
| `tests/store.test.js` | 2 条基线断言按新契约更新（理由见第 3 节）。 |
| `tests/meta.test.js` | 新增 2 项 `migrate` 覆盖（纯改名、合并、`replace` 覆盖被删行）。 |
| `packages/dsh-memory/package.json` | `0.1.0` → `0.2.0-m3`。 |

`lib/client.js` **未改**：设置页的删除按钮本来就对所有非 `unfenced` id 开放，现在自动支持 `l-`/`p-`；归档按钮仍只对 `e-` 条目显示（`store.archive` 也只接受带标记的条目）。因此没有重新跑 `node scripts/build.mjs` 的必要。

---

## 2. 测试数（前后对比）

| | tests | pass | fail |
|---|---|---|---|
| M3 开始前（基线） | 45 | 45 | 0 |
| M3 完成后 | 69 | 69 | 0 |

- 新增 24 项：`tests/entry-model.test.js` 10 + `tests/keyfact.test.js` 6 + `tests/limit-suggest.test.js` 5 + `tests/meta.test.js` 2 + `tests/runtime.test.js` 1（改名链的元数据不串）。
- 冒烟（均只用 `mkdtemp` 临时目录，跑完核对正式 `~/.dsh/memory` 字节不变）：
  - `node scripts/smoke-memory.mjs` → `RESULT {"ok":true,"steps":6,...}`（add / search / list / remove，输出含 diff 回显）
  - `node scripts/smoke-m2.mjs` → `RESULT {"ok":true,"steps":8,...}`（排序、use_count、周整理、归档/恢复）
- 未运行 `scripts/smoke-embed.mjs` / `smoke-session-search.mjs`（本次未改嵌入与会话检索）。

### 改动的基线断言（逐条理由）

1. `tests/store.test.js` — `refuses over the character cap without truncating or writing`
   - 旧：`assert.ok(denied.suggestions.length > 0)`
   - 新：`assert.ok(denied.suggestions.toJournal.length + denied.suggestions.merge.length + denied.suggestions.trim.length > 0)`，外加 `freed` 是数字、`incoming > 0`
   - 理由：任务 C 要求建议**分组**为 `toJournal` / `merge` / `trim`（每组 id + chars + preview + reason），并附释放估算。`suggestions` 因此从平铺数组变成分组对象，原来的 `.length` 不再成立。断言本意（确实给出建议）保留并加强。

2. `tests/store.test.js` — `list reports character occupancy and does not create AGENTS.md`
   - 旧：`assert.ok(listed.entries.some((item) => item.id === 'unfenced'))`
   - 新：断言**没有** `unfenced`，种子正文拆成 `l-` 列表项（含「称呼：主人」那条）和 `p-` 散文块，且每条 id 都非空
   - 理由：任务 A 要求每个 `- ` 列表项成为独立条目，`unfenced` 降级为遗留别名。种子 USER.md 不再是一整块，所以「列表里有 unfenced」这条断言与新契约直接冲突。用它验证拆分结果更有意义。

---

## 2.5 提交前自查修掉的三处

1. **`formatSearch` 仍提示 `p-` 条目「修改请用 anchor」** — M3 已让 `p-` id 可直接改删，这句会把模型支去绕路。已去掉，直接回显 id。
2. **文案写成 `id=新 ← 旧`，实际输出是 `id=旧 → 新`** — 以任务书的 `旧id → 新id` 为准，统一了 `format.js` / `index.js` / `README.md` / `NOTES.md` 的写法。
3. **改名链顺序会让元数据串号** — 场景：把 `甲条` 改写成和邻条 `乙条` 一样的文本，甲会顶到乙原来的 id、乙被挤成 `~2`。原先按文档顺序迁移会先把甲并进乙那一行（`migrate` 默认合并），再整体搬去 `~2`，结果乙的计数被甲吞掉、甲变成孤儿+新行——正是「不能 orphan + new」要避免的。`runtime.applyRenames` 现在先按「谁腾出 id 谁先走」拓扑排序再迁移，并加了回归测试（`a rename chain keeps each entry’s counters when ids collide`）。

---

## 3. 已知缺口

1. **重复文本的重编号**：同一文档里两条完全相同的列表项，删掉/改掉前面那条后，后面那条的 id 会从 `l-xxxx~2` 变成 `l-xxxx`（id = 内容哈希 + 出现次序）。这与「改其他条目不影响它的 id」在「其他条目 = 同文重复项」时有交集。已在 `NOTES.md` 写明，并用 `renames` + `meta.migrate` 保证元数据跟得上；`affectedIds` 会列出被重编号的 id。若要完全不抖，得把后缀固化进文件（写进标记或额外元数据），本次没做。
2. **`unfenced` 整段替换不保证字节级保留**：遗留路径会按「正文在前、标记条目在后」重组文件（v0.1.0 语义）。日常请用 `l-`/`p-` id。
3. **keyfact 是启发式**：`password: 12345` 这类裸冒号+数字会被当成端口；反过来 `config.yaml` 这类不带已知 TLD 的域名不会命中。密钥/token 仍由 `redact.js` 在写入前整段拒绝，不在这里分类。
4. **`memory_search` 的输入是条目原文**（列表项连 `- ` 前缀一起进索引），与 `memory_list` 显示一致；检索层没做词干/别名扩展，仍靠 trigram + bge-m3。
5. **`archive` / `restore` 的返回没有 `diff`**：任务 A 的返回契约明确列的是 add/replace/remove 三类。归档是可逆搬迁（`archive/YYYY-MM.md` 里保留完整条目块），本次未加 diff。
6. **设置页未加「按条目看 diff」**：改删后的 diff 只在工具返回里回显；设置页仍靠条目表 + 打开文件夹人工核对。
7. **`SCHEMA_VERSION` 升到 2 会丢向量**：打开旧索引时自动清空 `docs`/`vecs` 重建（`entry_meta` 保留）。第一次搜索可能稍慢（要重新嵌入）。这是「可重建缓存」的设计代价。

---

## 4. 手动验收步骤（在 dsh 里）

> 只在你自己愿意改真实记忆时做；或先备份 `~/.dsh/memory`。

1. **拆分**：`memory_list`（不带 target）
   - 期望：USER.md / MEMORY.md 的每个 `- ` 列表项各占一行，id 形如 `l-…`；标题/段落是 `p-…`；工具写入的是 `e-…`。不再出现一整块 `id=unfenced`。
   - 每行格式：`- l-… [item] N字 📌 预览`。
2. **`l-` id 改写**：挑一条列表项，`memory_replace(id="l-…", text="改过的正文")`
   - 期望：返回 `已更新 user id=旧 → 新（used/limit 字符）` + `affected:` + 一段 `--- a/USER.md` / `+++ b/USER.md` 的 diff（只有这条变了）。
   - 立刻再 `memory_list`：**其他条目 id 完全不变**，只有这一条变成新 id。
3. **端口事实 → 置顶建议**：`memory_add(target="memory", text="家里电脑代理端口 7890")`
   - 期望：返回里多一行 `💡 像是稳定关键事实（端口），建议 memory_pin id=e-…`。
   - 确认**没有**被自动置顶（`memory_list` 里该条不带 📌）；再 `memory_pin(id="e-…")` 才置顶。
4. **超限建议**：往 `MEMORY.md` 塞到接近 4000 字后，再 `memory_add(target="memory", text=…)` 超限
   - 期望：**整次拒绝**、`已拒绝写入，没有截断`，随后是三组清单（可挪去日记 / 可合并的相似条目 / 可精简的长条目，每项带 id、字数、预览、原因），最后一行是「挪走这些后可释放约 N 字，足以写入本次 M 字。」和「以上只是建议，不会自动删除/合并/挪动」。
   - 确认文件没有被改动，也没有被截断；置顶条目不出现在任何一组里。
5. **锚点改写不再返回 null**：`memory_replace(anchor="<某条里唯一的一小段>", text="…")`
   - 期望：返回真实条目 id（`id=旧 → 新`），不是 `id=null`。

---

## 5. 把插件重新 link 到 dsh（只写步骤，本次未执行）

1. `cd D:\Tool\dsh-memory`，确认在 `m3` 分支、工作区干净。
2. （若将来改了 `src/client.src.js`）`node scripts/build.mjs` 重新生成 `lib/client.js`。本次没改客户端，可跳过。
3. `.\scripts\Install-DshMemory.ps1`（或 `-Profiles web`）。脚本会备份 profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` 为 `*.bak-mem-<时间戳>`，再在 dsh 源码根执行 `pnpm dsh plugin --profile <p> add packages/dsh-memory`。
4. 重启 dsh（插件代码变更需要新会话才生效）。
5. 在 dsh 里跑一遍第 4 节的验收步骤。
6. 如需回滚：用 `*.bak-mem-<时间戳>` 覆盖回去，或 `pnpm dsh plugin --profile <p> remove packages/dsh-memory`。

注意：本次任务**没有**安装/重装插件、没有重启 dsh、没有碰 `D:\Tool\deepseek-harness`、没有读写 `~/.dsh/.credentials.yaml`、没有改 `~/.dsh/AGENTS.md`、没有动 `C:\Users\Gabi\.dsh\memory\*`（冒烟只在 `mkdtemp` 临时目录，并核对正式文件字节不变）。

---

## 6. AGENTS.md 使用说明需同步更新的点

> 我不改 AGENTS.md 本身。以下供你（或贝蒂）按需同步到 `C:\Users\Gabi\.dsh\AGENTS.md` 末尾「记忆工具使用说明」一节。

| # | 旧说法（v0.1.0） | 新说法（M3 / v0.2.0-m3） |
|---|---|---|
| 1 | 「手写的种子正文目前会整块显示成**一条** `id=unfenced`；工具写入的条目各有自己的 `e-…` id。」 | 「USER.md / MEMORY.md 里每个 `- ` / `* ` / `+ ` 列表项都是一条独立条目，id 形如 `l-…`；其余散文按空行分块，id 形如 `p-…`；工具写入的仍是 `e-…`。`memory_list` 一行一条：`- l-… [item] N字 📌 预览`。」 |
| 2 | 「手写的种子正文（`unfenced`）：**用 anchor，不要用 `id=unfenced`**。」 | 「手写正文现在按条目拆开，直接用 `l-…` / `p-…` id 改删即可，最精准。`unfenced` 只剩**遗留**含义（整段替换所有未标记正文，会重组文件），除非明确要整块重写，否则不用。锚点仍可用，但改完会返回它所在条目的 id。」 |
| 3 | 「**已知问题**：当前按 anchor 修改/删除成功后，返回里可能是 `id=null`……改完一定再 `memory_list` 复核。」 | 「已修复：任何成功路径都不会再返回 `id=null`。`memory_replace` 返回 `id=新id`（若 id 变了还会给 `previousId`，并显示 `id=旧 → 新`）；`memory_remove` 返回 `id=被删id`。两次调用都有 `affectedIds` 和一段只覆盖受影响条目的 diff，看返回就能确认改了什么；仍建议改完 `memory_list` 复核一遍。」 |
| 4 | 「成功会返回 `已写入 memory id=e-xxxxxxxx（用量/上限 字符）`。」 | 「写操作返回里除了 id 和用量，还会回显 `affected:` 和一段 unified diff（`--- a/MEMORY.md` / `+++ b/MEMORY.md`）。改写 `l-`/`p-` 条目后 **id 会跟着内容变**，以后请用返回的新 id。」 |
| 5 | 「（无）」 | 「写入主机名、端口、路径、域名、IP、账号这类稳定事实后，如果该条还没置顶，返回里会多一行 `💡 像是稳定关键事实（端口/路径…），建议 memory_pin id=…`。**只是建议，不要默默置顶**；问过主人再 `memory_pin`。USER.md 条目默认已置顶，通常不会提示。」 |
| 6 | 「超限会整次拒绝、不会截断。返回"已拒绝写入，没有截断"并附上最长的几条。」 | 「超限仍然整次拒绝、不截断、不自动腾挪，但返回的是**三组具体建议**：`可挪去日记`（一次性事件/进度/日期叙事）、`可合并的相似条目`（保留长的那条）、`可精简的长条目`；每项带 id、字数、预览、原因。最后一行会估算「挪走这些后可释放约 N 字，足以写入本次 M 字」。置顶条目不会被建议挪走。**只建议，不自动删除/合并/挪动**，按建议动手前先跟主人说一声。」 |
| 7 | 「`memory_replace`：用 `e-…` id 时 `text` 是这条的新全文；用 `anchor` 时只换那一小段。」 | 「`memory_replace` 对 `l-…` / `p-…` / `e-…` id 都可用：`text` 是这条的**新全文**，只改这一条，别的字节不动（列表项保留原来的 `- ` 前缀和缩进）。`tags` 只对 `e-…` 条目有效。用 `anchor` 仍是只换那一小段。」 |
| 8 | 「`memory_list`：列出条目和字符占用。」 | 「`memory_list`：一行一条列出**每个**列表项 / 散文块 / 标记条目（`l-`/`p-`/`e-`），带字数、📌 置顶标记和预览，外加字符占用。id 与 `memory_search` 结果一致，可直接拿去改删。」 |
| 9 | 「`memory_pin`：置顶的条目不参与衰减、不会被列进过时建议。」 | 「`memory_pin`：置顶的条目不参与衰减、不会进过时（stale）建议，也**不会出现在超限时的挪走建议**里。」 |
| 10 | 「删减或合并主人画像前先跟主人说一声。」 | 保留（不变）。补充：同文重复条目删掉前面那条后，后面那条的 id 会重编号（`l-…~2` → `l-…`），使用计数和置顶状态会跟着迁移；返回的 `affectedIds` 会告诉你是哪几条。 |

---

M3_DONE
