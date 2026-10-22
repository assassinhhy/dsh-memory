import assert from 'node:assert/strict'
import test from 'node:test'
import { scanSecrets, secretError } from '../packages/dsh-memory/src/redact.js'

const SEED_USER = `# USER.md — 主人画像（种子）

- 称呼：主人（对话里不要叫真名）
- 时区：Asia/Shanghai（UTC+8）
- 家庭电脑：DESKTOP-9C0DKID；代理 127.0.0.1:7890
`
const SEED_MEMORY = `# MEMORY.md — 环境与约定（种子）

- 凭据与配置在 ~/.dsh/；不要把密钥写进本文件
- Claude Code：Windows 本机；经 CC Switch 代理 127.0.0.1:15721
`

test('seed prose is not a secret', () => {
  assert.equal(scanSecrets(SEED_USER).ok, true)
  assert.equal(scanSecrets(SEED_MEMORY).ok, true)
  assert.equal(scanSecrets('不要把密钥写进本文件').ok, true)
  assert.equal(scanSecrets('token 这个词可以出现在句子里').ok, true)
})

test('high-confidence secrets are refused without echoing the value', () => {
  const samples = [
    ['sk-' + 'a'.repeat(24), 'api_key'],
    ['ghp_' + 'b'.repeat(20), 'github_token'],
    ['AKIA' + 'C'.repeat(16), 'aws_access_key'],
    ['-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', 'private_key'],
    ['Authorization: Bearer abcdefghijklmnop', 'bearer'],
    ['password=hunter2hunter', 'credential_assignment'],
    ['api_key: sk-live-not-quite-but-long', 'credential_assignment'],
  ]
  for (const [text, kind] of samples) {
    const scanned = scanSecrets(text)
    assert.equal(scanned.ok, false, text.slice(0, 24))
    assert.ok(scanned.kinds.includes(kind), `${kind} missing in ${scanned.kinds}`)
    const message = secretError(scanned.kinds)
    assert.equal(message.includes('hunter2'), false)
    assert.equal(message.includes('ghp_'), false)
    assert.equal(message.includes(text), false)
  }
})

test('placeholders and short flags are not secrets', () => {
  assert.equal(scanSecrets('password=***').ok, true)
  assert.equal(scanSecrets('token=TODO').ok, true)
  assert.equal(scanSecrets('password=yes').ok, true)
  assert.equal(scanSecrets('token: 不要把密钥写进文件').ok, true)
  assert.equal(scanSecrets('password=我的秘密口令').ok, false)
})
