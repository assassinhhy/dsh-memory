# 更新记录

## 0.1.0 — 2026-10-23

首个可安装版本，面向 DeepSeek Harness `>=0.2.1-0 <0.3.0`。

- `USER.md`（2000 字符）、`MEMORY.md`（4000 字符）与按日日记。超限拒绝，不截断。疑似密钥整段拒绝，错误不回显原文。
- 工具：`memory_add`、`memory_replace`、`memory_remove`、`memory_list`、`memory_search`、`memory_pin`、`memory_consolidate`、`memory_reindex`、`session_search`。
- 新会话开头冻结注入 `USER.md` 与 `MEMORY.md`。本会话内改文件不刷新这段提示词。
- 索引为可重建的 FTS5 trigram，加上本地 bge-m3 q8。检索按使用情况衰减重排；置顶不衰减，衰减不删除文件。
- 默认每 6 个已完成回合做一次回合整理。失败只记日志。
- 周整理写出 merge / stale / promote / conflict 建议，需在设置页人工同意后才执行。归档可恢复。
- 设置 → 记忆：占用、条目、衰减参数、整理建议、归档、打开目录、重建索引。
