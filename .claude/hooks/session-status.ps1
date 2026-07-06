# SessionStart status hook — fast, read-only, always exits 0.
#
# Prints the current worktree's branch + short status at turn zero, and WARNS on
# the two contamination traps this repo hits:
#   1. a merge or rebase left in progress (.git/MERGE_HEAD or rebase-* dir)
#   2. sitting in the MAIN checkout while linked worktrees exist
#      (the mixed-commit-sweep trap — unrelated changes land in the wrong commit)
#
# Wired in .claude/settings.json as a SessionStart command hook. Windows PS 5.1.

$ErrorActionPreference = "SilentlyContinue"

function Normalize-Path {
  param([string]$p)
  if ([string]::IsNullOrWhiteSpace($p)) { return "" }
  try { return ([System.IO.Path]::GetFullPath($p)).TrimEnd('\', '/') } catch { return $p }
}

try {
  $inRepo = & git rev-parse --is-inside-work-tree 2>$null
  if ($LASTEXITCODE -ne 0 -or $inRepo -ne "true") { exit 0 }

  $branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
  $top    = (& git rev-parse --show-toplevel 2>$null)
  $gitDir = (& git rev-parse --absolute-git-dir 2>$null)
  $status = (& git status --short 2>$null)

  Write-Host "-- worktree status ------------------------------"
  Write-Host ("branch: {0}" -f $branch)
  Write-Host ("path  : {0}" -f $top)
  if ([string]::IsNullOrWhiteSpace(($status | Out-String))) {
    Write-Host "tree  : clean"
  }
  else {
    Write-Host "tree  : DIRTY"
    $status | ForEach-Object { Write-Host ("  {0}" -f $_) }
  }

  # 1. merge / rebase in progress
  if (Test-Path (Join-Path $gitDir "MERGE_HEAD")) {
    Write-Host "!! MERGE IN PROGRESS -- resolve it or run 'git merge --abort' before starting new work."
  }
  if ((Test-Path (Join-Path $gitDir "rebase-merge")) -or (Test-Path (Join-Path $gitDir "rebase-apply"))) {
    Write-Host "!! REBASE IN PROGRESS -- finish it or run 'git rebase --abort' before starting new work."
  }

  # 2. main checkout while other worktrees exist
  $wtRaw = & git worktree list --porcelain 2>$null
  $wtPaths = @($wtRaw | Where-Object { $_ -like 'worktree *' } | ForEach-Object { $_ -replace '^worktree ', '' })
  if ($wtPaths.Count -gt 1) {
    $mainRoot = $wtPaths[0]
    if ((Normalize-Path $top) -ieq (Normalize-Path $mainRoot)) {
      Write-Host ("!! You are in the MAIN checkout and {0} other worktree(s) exist." -f ($wtPaths.Count - 1))
      Write-Host "   New task? Isolate it:  /worktree <slug>"
      Write-Host "   Do NOT commit here while other sessions are active (mixed-commit-sweep trap)."
    }
  }
  Write-Host "-------------------------------------------------"
}
catch { }

exit 0
