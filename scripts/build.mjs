// Wrap the hand-written settings page in dsh's closure-factory envelope.
// Usage: node scripts/build.mjs  (no dependencies; Node >= 20)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'packages', 'dsh-memory')
const src = readFileSync(join(dir, 'src', 'client.src.js'), 'utf8')
const body = [
  'window.__ModuleLoader__.load({ id: "dsh-memory", factory: (require) => {',
  'var module = { exports: {} }; var exports = module.exports;',
  src,
  'return module.exports; } });',
  '',
].join('\n')
mkdirSync(join(dir, 'lib'), { recursive: true })
writeFileSync(join(dir, 'lib', 'client.js'), body)
console.log('built dsh-memory/lib/client.js')
