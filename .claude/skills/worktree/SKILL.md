---
name: worktree
description: Bootstrap a new isolated git worktree for one task (the one-task-one-worktree rule). Fetches, confirms origin/master is green via the Vercel commit status, creates ../ttq-<slug>, junctions node_modules from the main checkout, copies .env.local, assigns a free dev port, and runs a tsc smoke check. Use whenever starting a fresh, separable task on this Windows repo.
argument-hint: <slug> [branch]
---

# /worktree — one-command worktree bootstrap

Standing rule in this repo: **one task = one worktree.** This skill does the full careful bootstrap that otherwise gets done by hand (and gets done wrong — a missing `.env.local` makes every dev request 500).

## What to run

The argument after `/worktree` is the **slug** (a short task name). An optional second token is the branch name (defaults to the slug).

Run the bootstrap script with the **PowerShell tool** (it is Windows-PowerShell-5.1-safe), from the repo root:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .claude/skills/worktree/bootstrap.ps1 -Slug "<slug>"
```

- If the user gave a branch, add `-Branch "<branch>"`.
- To branch off something other than `origin/master`, add `-BaseRef "origin/<ref>"`.
- To skip the (slow) type-check, add `-SkipTsc`.

The script performs, in order: `git fetch origin` → confirm `origin/master` is green (Vercel commit status via `gh api "repos/{owner}/{repo}/commits/master/status"`; prints the manual Vercel-dashboard check if `gh` is unavailable) → `git worktree add -b <branch> ../ttq-<slug> origin/master` → **junction** `node_modules` from the main checkout → **copy `.env.local`** → probe a free dev port → `npx tsc --noEmit` → print a `WORKTREE READY` summary.

## After it runs — report back to the user

Relay the summary block verbatim (path, branch, port, env, tsc, master), then:

- If **env = MISSING**, flag it loudly — the dev server will 500 on every request until `.env.local` exists in the main checkout and is copied in.
- If **tsc = FAIL**, note that master itself may be red or the base is broken — surface the errors, don't bury them.
- If **master** is not `success` (pending/red/unconfirmed), tell the user they're branching off a non-green master and let them decide.
- Give the next step: `cd` into the worktree and `npm run dev -- -p <port>`.
- Remind: **do all work and commits from the new worktree, never the main checkout** while other sessions are active.

## If the script errors (exit 1)

Common causes and fixes:
- *"Worktree path already exists"* — pick a different slug, or `git worktree remove ../ttq-<slug>` first.
- *"Branch already exists"* — pass a different `-Branch`, or delete the old branch.
- *"main checkout has no node_modules"* — run `npm install` in the main checkout, then re-run.
- *"Not inside a git work tree"* — `cd` into the TuttoHQ repo first.
