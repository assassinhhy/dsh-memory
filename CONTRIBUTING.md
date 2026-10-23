# 参与开发

## 构建

设置页的源文件是 `packages/dsh-memory/src/client.src.js`。改完后在仓库根目录运行：

```sh
node scripts/build.mjs
```

这会覆盖 `packages/dsh-memory/lib/client.js`。该文件已提交，克隆后不必为了安装先构建。需要 Node 20 或更新。

## 测试

```sh
node --test tests/*.test.js
node scripts/smoke-memory.mjs
node scripts/smoke-m2.mjs
```

测试使用临时目录，并需要带 `node:sqlite` 的 Node。不要把 `node_modules/`、`models/` 或本机 `~/.dsh` 里的记忆文件提交进来。

## 边界

- Markdown 是事实来源。条目的使用次数、置顶和归档状态放在 `index.sqlite`，不要把这些字段写进 Markdown。
- 不要改写 `AGENTS.md`，不要读或写 `.credentials.yaml`。
- 疑似密钥整段拒绝，不要打码后写入。
- 周整理只产生建议。置顶条目不能进入 stale。
