<#
.SYNOPSIS
  One-command git-worktree bootstrap for TuttoHQ (one task = one worktree).

.DESCRIPTION
  Does the full careful bootstrap so a fresh worktree actually runs:
    1. git fetch origin
    2. Confirm origin/<base> is green  (Vercel commit status via `gh`; if gh is
       unavailable, prints the manual Vercel dashboard check instead)
    3. git worktree add -b <branch> ../ttq-<slug> <base>
    4. Junction node_modules from the MAIN checkout  (Windows junction, NOT a
       symlink -- works on PowerShell 5.1 without admin)
    5. Copy .env.local from the MAIN checkout  (the dev server 500s on every
       request without it -- the #1 repeated failure)
    6. Probe for a free dev port and print it
    7. Run `npx tsc --noEmit` as a smoke check and report pass/fail
    8. Print a summary (path, branch, port, tsc, master state)

  Designed for Windows PowerShell 5.1: no &&, no ternary, no null-coalescing.

.PARAMETER Slug
  Short task slug. The worktree is created at ../ttq-<slug>.

.PARAMETER Branch
  Branch to create for the worktree. Defaults to the slug.

.PARAMETER BaseRef
  Base ref for the new branch/worktree. Defaults to origin/master.

.PARAMETER SkipTsc
  Skip the tsc smoke check (faster; use when you know TS is unaffected).

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .claude/skills/worktree/bootstrap.ps1 -Slug dx-batch-2
#>
param(
  [Parameter(Mandatory = $true)][string]$Slug,
  [string]$Branch = "",
  [string]$BaseRef = "origin/master",
  [switch]$SkipTsc
)

# ---- helpers ---------------------------------------------------------------

function Write-Step { param([string]$m) Write-Host "`n>> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "   $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "!! $m" -ForegroundColor Yellow }
function Write-Err  { param([string]$m) Write-Host "XX $m" -ForegroundColor Red }

function Normalize-Path {
  param([string]$p)
  if ([string]::IsNullOrWhiteSpace($p)) { return "" }
  try { return ([System.IO.Path]::GetFullPath($p)).TrimEnd('\', '/') } catch { return $p }
}

function Test-PortFree {
  # A port is free only if the OS shows no LISTENING socket on it. An IPv4
  # 127.0.0.1 bind test is NOT enough: `next dev` listens on IPv6 :: (all
  # interfaces), which an IPv4-loopback probe misses -> it would report an
  # occupied port as free and `npm run dev` then dies with EADDRINUSE.
  param([int]$Port)
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    return (-not $listening)
  }
  # Fallback (no NetTCPIP module): dual-stack bind, conflicts with IPv4 + IPv6 :: listeners.
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::IPv6Any, $Port)
    $listener.Server.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::IPv6, [System.Net.Sockets.SocketOptionName]::IPv6Only, 0)
    $listener.Start(); $listener.Stop()
    return $true
  }
  catch {
    if ($listener) { try { $listener.Stop() } catch { } }
    return $false
  }
}

# ---- main ------------------------------------------------------------------

try {
  # Validate slug (filesystem + branch safe)
  if ($Slug -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$') {
    throw "Invalid slug '$Slug' -- use letters, digits, . _ - / only."
  }
  if (-not $Branch) { $Branch = $Slug }
  $baseBranch = ($BaseRef -replace '^origin/', '')

  # Confirm we're inside a git repo
  $inRepo = & git rev-parse --is-inside-work-tree 2>$null
  if ($LASTEXITCODE -ne 0 -or $inRepo -ne "true") {
    throw "Not inside a git work tree. Run this from the TuttoHQ repo (or a worktree of it)."
  }

  # Resolve the MAIN checkout (first entry of `git worktree list` is the main tree).
  # node_modules + .env.local are always sourced from MAIN, even if invoked from a linked worktree.
  $wtListRaw = & git worktree list --porcelain 2>$null
  $mainRoot = ($wtListRaw | Where-Object { $_ -like 'worktree *' } | Select-Object -First 1) -replace '^worktree ', ''
  $mainRoot = (Resolve-Path $mainRoot).Path
  if (-not (Test-Path (Join-Path $mainRoot 'package.json'))) {
    throw "Could not locate the main checkout (no package.json at '$mainRoot')."
  }
  Write-Ok "main checkout: $mainRoot"

  # 1. Fetch --------------------------------------------------------------
  Write-Step "git fetch origin"
  & git fetch origin --quiet
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed (exit $LASTEXITCODE)." }
  Write-Ok "fetched"

  # 2. Green check --------------------------------------------------------
  Write-Step "Checking origin/$baseBranch is green (Vercel commit status)"
  $masterState = "unknown"
  $masterNote = ""
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if ($null -eq $gh) {
    $masterNote = "gh CLI not found"
  }
  else {
    $st = & gh api "repos/{owner}/{repo}/commits/$baseBranch/status" --jq ".state" 2>$null
    if ($LASTEXITCODE -eq 0 -and $st) {
      $masterState = ("$st").Trim()
    }
    else {
      $masterNote = "no commit status posted (gh unauthed, or repo has no CI status)"
    }
  }
  switch ($masterState) {
    "success" { Write-Ok "origin/$baseBranch is GREEN" }
    "pending" { Write-Warn "origin/$baseBranch is PENDING (deploy still building) -- proceeding, but master may not be settled." }
    "failure" { Write-Warn "origin/$baseBranch is RED (failure) -- you are branching off a broken master. Consider waiting for a fix." }
    "error"   { Write-Warn "origin/$baseBranch reported ERROR -- you are branching off a broken master. Consider waiting for a fix." }
    default {
      Write-Warn "Could not confirm origin/$baseBranch is green ($masterNote)."
      Write-Host "     Manual check: open the Vercel dashboard and confirm the latest '$baseBranch' deployment is READY,"
      Write-Host "     or run:  gh api ""repos/{owner}/{repo}/commits/$baseBranch/status"" --jq .state"
    }
  }

  # 3. Create worktree ----------------------------------------------------
  $parent = Split-Path -Parent $mainRoot
  $wtPath = Join-Path $parent ("ttq-" + ($Slug -replace '/', '-'))
  Write-Step "git worktree add -b $Branch `"$wtPath`" $BaseRef"
  if (Test-Path $wtPath) { throw "Worktree path already exists: $wtPath" }
  $branchExists = & git rev-parse --verify --quiet "refs/heads/$Branch" 2>$null
  if ($LASTEXITCODE -eq 0 -and $branchExists) { throw "Branch '$Branch' already exists. Pass -Branch <other> or delete it first." }

  & git worktree add -b $Branch $wtPath $BaseRef
  if ($LASTEXITCODE -ne 0) { throw "git worktree add failed (exit $LASTEXITCODE)." }
  Write-Ok "worktree created"

  # 4. Junction node_modules ---------------------------------------------
  Write-Step "Junction node_modules from main checkout"
  $srcNM = Join-Path $mainRoot 'node_modules'
  $dstNM = Join-Path $wtPath 'node_modules'
  if (-not (Test-Path $srcNM)) {
    Write-Warn "main checkout has no node_modules -- run 'npm install' in $mainRoot first, then re-junction."
  }
  elseif (Test-Path $dstNM) {
    Write-Ok "node_modules already present in worktree (skipped)"
  }
  else {
    New-Item -ItemType Junction -Path $dstNM -Target $srcNM -ErrorAction Stop | Out-Null
    Write-Ok "junction -> $srcNM"
  }

  # 5. Copy .env.local ----------------------------------------------------
  Write-Step "Copy .env.local from main checkout"
  $srcEnv = Join-Path $mainRoot '.env.local'
  $envCopied = $false
  if (Test-Path $srcEnv) {
    Copy-Item $srcEnv (Join-Path $wtPath '.env.local') -Force -ErrorAction Stop
    $envCopied = $true
    Write-Ok ".env.local copied"
  }
  else {
    Write-Warn "MAIN checkout has NO .env.local -- the dev server will 500 on every request."
    Write-Host "     Create $srcEnv (see .env.local.example) then copy it into $wtPath."
  }

  # 6. Free dev port ------------------------------------------------------
  Write-Step "Probing for a free dev port"
  $port = 0
  for ($p = 3000; $p -le 3100; $p++) {
    if (Test-PortFree -Port $p) { $port = $p; break }
  }
  if ($port -eq 0) { Write-Warn "No free port found in 3000-3100." } else { Write-Ok "free port: $port" }

  # 7. tsc smoke check ----------------------------------------------------
  $tscLabel = "skipped"
  if (-not $SkipTsc) {
    Write-Step "npx tsc --noEmit (smoke check)"
    Push-Location $wtPath
    try {
      & npx tsc --noEmit
      $tscExit = $LASTEXITCODE
    }
    finally {
      Pop-Location
    }
    if ($tscExit -eq 0) { $tscLabel = "PASS"; Write-Ok "tsc clean" }
    else { $tscLabel = "FAIL (exit $tscExit)"; Write-Warn "tsc reported errors (exit $tscExit) -- see output above." }
  }

  # 8. Summary ------------------------------------------------------------
  $envLabel = if ($envCopied) { ".env.local copied" } else { "MISSING -- dev will 500" }
  $portLabel = if ($port -eq 0) { "none free (3000-3100)" } else { "$port" }
  $masterLabel = if ($masterState -eq "unknown") { "unconfirmed ($masterNote)" } else { $masterState }

  Write-Host ""
  Write-Host "================ WORKTREE READY ================" -ForegroundColor Cyan
  Write-Host ("  path    : {0}" -f $wtPath)
  Write-Host ("  branch  : {0}   (base {1})" -f $Branch, $BaseRef)
  Write-Host ("  port    : {0}" -f $portLabel)
  Write-Host ("  env     : {0}" -f $envLabel)
  Write-Host ("  tsc     : {0}" -f $tscLabel)
  Write-Host ("  master  : {0}" -f $masterLabel)
  Write-Host "================================================" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Next:"
  Write-Host ("  cd `"{0}`"" -f $wtPath)
  if ($port -ne 0) { Write-Host ("  npm run dev -- -p {0}" -f $port) }
  Write-Host "  # do all work + commits from this worktree, NOT the main checkout"
  exit 0
}
catch {
  Write-Err $_.Exception.Message
  exit 1
}
