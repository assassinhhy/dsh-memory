<#
.SYNOPSIS
  构建并把 dsh-memory（长期记忆）装进 dsh profile。

.DESCRIPTION
  1. node scripts/build.mjs 生成 lib/client.js。
  2. 在插件目录用 npmmirror + 代理安装依赖（transformers / undici），供 link: 安装解析。
  3. 对每个 profile：先把 package.json / cordis.patch.yml / pnpm-lock.yaml 备份成 *.bak-mem-<时间戳>，
     再在 dsh 源码目录里执行 `pnpm dsh plugin --profile <p> add <插件目录>`。已装过的会跳过。
     desktop profile 由桌面应用独占：脚本只提示在应用里「插件 → 添加插件」link 本地目录。
  不会修改 llm provider、agent-default-model，也不会碰 .credentials.yaml。
  插件自己的 cordis.patch.yml 会把 session-query-sqlite 的 openAt 调成 first-search，
  否则 session_search 搜不到旧对话。profile 自己的 cordis.patch.yml 若再次声明该行，以那边为准。

.EXAMPLE
  .\scripts\Install-DshMemory.ps1
  .\scripts\Install-DshMemory.ps1 -Profiles web
#>
[CmdletBinding()]
param(
  [string]$DshRoot,
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string[]]$Profiles = @('desktop', 'web'),
  [string]$Proxy = 'http://127.0.0.1:7890',
  [string]$Registry = 'https://registry.npmmirror.com'
)
$ErrorActionPreference = 'Continue'
$PSDefaultParameterValues['*:ErrorAction'] = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$repo = Split-Path -Parent $PSScriptRoot
if (-not $DshRoot) { $DshRoot = Split-Path -Parent $repo }
$Profiles = @($Profiles | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$env:HTTP_PROXY = $Proxy
$env:HTTPS_PROXY = $Proxy
$env:http_proxy = $Proxy
$env:https_proxy = $Proxy
$env:npm_config_registry = $Registry

Write-Host "== 构建插件 ==" -ForegroundColor Cyan
& node (Join-Path $repo 'scripts\build.mjs')
if ($LASTEXITCODE -ne 0) { throw "插件构建失败（node scripts/build.mjs）" }

$pkg = Join-Path $repo 'packages\dsh-memory'
Write-Host "== 安装插件依赖（npmmirror / $Proxy） ==" -ForegroundColor Cyan
Push-Location $pkg
try {
  & pnpm install --ignore-workspace --config.auto-install-peers=false --config.strictDepBuilds=false --registry $Registry
  if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败" }
} finally { Pop-Location }

if (-not (Test-Path (Join-Path $DshRoot 'package.json'))) { throw "找不到 dsh 源码目录：$DshRoot" }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

foreach ($prof in $Profiles) {
  $dir = Join-Path $DshHome "profiles\$prof"
  Write-Host "== profile: $prof ($dir) ==" -ForegroundColor Cyan
  if (-not (Test-Path $dir)) { Write-Warning "profile 不存在，跳过：$dir（先启动一次对应的 dsh 让它生成）"; continue }
  $manifest = Join-Path $dir 'package.json'
  $installed = @()
  if (Test-Path $manifest) {
    $deps = (Get-Content $manifest -Raw | ConvertFrom-Json).dependencies
    if ($deps) { $installed = $deps.PSObject.Properties.Name }
  }
  if ($installed -contains 'dsh-memory') {
    Write-Host "  已安装 dsh-memory，跳过（link: 安装，重新 build / pnpm install 即生效）"
    continue
  }
  if ($prof -eq 'desktop') {
    Write-Warning "  desktop profile 只能在桌面应用里装插件：打开 DeepSeek Harness → 插件 → 添加插件，输入："
    Write-Host "    $pkg" -ForegroundColor Yellow
    Write-Host "  点“安装”→“立即启用”。之后更新只需重新运行本脚本（link: 安装会直接读取新 build）。"
    continue
  }
  foreach ($file in 'package.json', 'cordis.patch.yml', 'pnpm-lock.yaml') {
    $path = Join-Path $dir $file
    if (Test-Path $path) { Copy-Item $path "$path.bak-mem-$stamp"; Write-Host "  备份 $file -> $file.bak-mem-$stamp" }
  }
  Write-Host "  dsh plugin --profile $prof add $pkg"
  Push-Location $DshRoot
  $prevHome = $env:DSH_HOME
  try {
    $env:DSH_HOME = $DshHome
    & pnpm dsh plugin --profile $prof add $pkg 2>&1 | ForEach-Object { "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "安装 dsh-memory 到 profile $prof 失败" }
  } finally {
    if ($null -eq $prevHome) { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue } else { $env:DSH_HOME = $prevHome }
    Pop-Location
  }
}
Write-Host "完成。重启 DeepSeek Harness 后生效。设置 → 记忆 可查看条目、开关自动整理、打开 $DshHome\memory 。" -ForegroundColor Green
Write-Host "模型权重在首次 memory_search 时下载到 $DshHome\memory\models ，不进 git。" -ForegroundColor Green
