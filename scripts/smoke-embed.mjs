/**
 * One-shot proof that local bge-m3 ranks a paraphrase above an unrelated note.
 * Downloads weights into DSH_HOME/memory/models on first run. Does not write
 * USER.md, MEMORY.md, or AGENTS.md.
 *
 *   node scripts/smoke-embed.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmbedder } from '../packages/dsh-memory/src/embed.js'
import { resolveMemoryRoot } from '../packages/dsh-memory/src/paths.js'
import { cosine } from '../packages/dsh-memory/src/search.js'

const cacheDir = join(resolveMemoryRoot(), 'models')
const embedder = createEmbedder({ cacheDir, logger: console })
console.log('cache', cacheDir)
const vectors = await embedder.embed([
  '默认包管理器是 pnpm',
  '用哪种命令拉取第三方库',
  '今天天气不错，出去走了走',
])
const same = cosine(vectors[0], vectors[1])
const other = cosine(vectors[0], vectors[2])
console.log(JSON.stringify({ dim: vectors[0].length, synonym: same, unrelated: other, status: embedder.status() }))
if (!(same > other + 0.05)) {
  console.error('vector ranking failed')
  process.exit(1)
}
console.log('bge-m3 synonym ranking ok')
