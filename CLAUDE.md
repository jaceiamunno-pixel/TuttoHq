# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Knowledge Base — TuttoHQ Vault (Notion)

The canonical knowledge base is the **Notion TuttoHQ Vault** — root page ID `36ea2f15-d107-81e7-9fe7-f72850497f41`. Product strategy, current build state, session updates, ADRs, feature/design pages, customer notes, and the roadmap all live there.

**At session start:** fetch the Notion root page and read the **most recent `SESSION UPDATE` block** for the current build state and prod HEAD. Blocks are dated; newer blocks supersede older ones — read the latest one.

**When you need product context, look in the Notion vault for:**
- Product state / current build / prod HEAD → the latest `SESSION UPDATE` block on the root page
- A specific feature you're working on → its feature/design page
- A customer that's mentioned → that customer's page
- Roadmap or priorities → the roadmap page
- Architectural decisions → all ADRs live in Notion. **ADR-001 and ADR-002 are the locked/foundational ones; ADR-003 onward are DRAFT/design-first.**

A local Obsidian export (`C:\Users\jacei_7431w1\Documents\TuttoHQ_Vault`) may still exist, but it's a mirror we do not maintain and may be stale — **Notion is the source of truth.**

**Do NOT modify vault content** unless explicitly asked. The vault is canonical product knowledge; code changes happen in this repo only.

## Commands

```bash
npm run dev       # Start dev server (Next.js, port 3000)
npm run build     # Production build (also type-checks)
npx tsc --noEmit  # Type-check without building
```

There are no tests. TypeScript is the primary correctness check — always run `npx tsc --noEmit` before committing.

## Worktrees

**One task = one worktree.** Never run parallel tasks in the main checkout — concurrent sessions in the same tree cause mixed-commit sweeps (unrelated changes landing in the wrong commit).

- Create with the **`/worktree <slug>`** skill — it does the full careful bootstrap: fetch, confirm `origin/master` is green (Vercel commit status), `git worktree add ../ttq-<slug>`, **junction** `node_modules` from the main checkout (Windows junction, not symlink), **copy `.env.local`**, assign a free dev port, and run a `tsc` smoke check.
- `node_modules` is junctioned, so **never `npm install` inside a worktree** — install once in the main checkout and every worktree sees it.
- `.env.local` is git-ignored and per-checkout; a fresh worktree has none until copied. **Missing `.env.local` is the #1 repeated failure — the dev server 500s on every request.**
- **Never commit from the main checkout while other worktree sessions are active.** Commit from the task's own worktree. The SessionStart hook (`.claude/hooks/session-status.ps1`) warns when you're sitting in the main checkout with other worktrees present, and when a merge/rebase is mid-flight.
- Worktrees live at `../ttq-<slug>` (siblings of the repo). Remove finished ones with `git worktree remove <path>`.

## Windows shell rules

Dev environment is **Windows + PowerShell 5.1** (Windows PowerShell, *not* PS7). Two shells are available — the **PowerShell tool** (PS 5.1) and the **Bash tool** (Git Bash / POSIX sh). Pick per task:

- **Use the Bash tool for:** git commits with multi-line messages (heredoc), `tsc`/build output filtering, and anything with pipes. PS 5.1 wraps a native command's stderr in ErrorRecords and flips `$?` to `$false` even on exit 0 when you redirect/pipe it — so piping native tools through PowerShell is error-prone.
- **Use the PowerShell tool for:** Windows-only operations — junctions (`New-Item -ItemType Junction`), `.env.local` copies, and process/port management.
- **PS 5.1 has no** `&&` / `||`, ternary (`?:`), or null-coalescing (`??`). Chain with `;` then `if ($?) { ... }`.
- **`pkill` / `kill` do NOT stop Windows processes.** To kill a dev server on a port: `Get-NetTCPConnection -LocalPort <port> | Select-Object -Expand OwningProcess | Stop-Process -Force`.

## Migration lifecycle

SQL migrations live in `sql/migrations.sql`. **The Supabase MCP is READ-ONLY — it cannot run DDL/DML.** To apply a migration:

1. Write the SQL (idempotent where possible) into `sql/migrations.sql`.
2. **Hand Jace the SQL to run in the Supabase SQL Editor** — you cannot run it yourself.
3. After Jace runs it, **verify via introspection** — read-only MCP queries against `information_schema` / `pg_policies` — that the table/column/policy actually landed.
4. Every new table needs explicit SELECT/INSERT/UPDATE/**DELETE** policies (see RLS pattern below).

## Stack

- **Next.js 15** App Router, TypeScript, Tailwind CSS v4
- **Supabase** — database (Postgres + RLS), auth (cookie-based SSR), storage (`submittals` bucket for all user files, `company-assets` for logos)
- **Anthropic SDK** — Claude Haiku for AI classification (`/api/classify`) and search expansion (`/api/search`)
- **pdf-lib** — server-side PDF generation via shared `src/lib/pdf-builder.ts` (`PDFBuilder` class). Used for submittals, RFIs, COs, punch items, daily reports, drawing transmittals.
- **Google APIs** — Gmail watch + Pub/Sub for automated email intake; Drive for legacy file import

## Architecture

### Project-first IA (ADR-006)
The app is **project-first**, routed under `/projects/[id]/...` — *not* a single dashboard "module shell." (The old top-nav-with-`activeModule`-state shell described in earlier versions of this file was replaced by the ADR-006 router migration.) Key surfaces:

- **`/` (`src/app/page.tsx`)** — marketing landing page (Framer Motion, Lucide icons). Not the app.
- **`/dashboard` (`src/app/dashboard/page.tsx`)** — the **project landing grid**: a searchable, favoritable list of the company's projects wrapped in `<AppChrome>`. Pick a project → its work modules open in the project shell. This file is intentionally thin (a grid + picker), no longer a module host.
- **`/projects/[id]/<module>`** — the **project shell**. `src/app/projects/[id]/project-chrome` (`useProjectShell()`) owns per-project chrome, nav, and shared state (`projectId`, `appProjects`, `teamMembers`, `userEmail`, view toggles). Each module is a real route page under `src/app/projects/[id]/`: `submittals`, `rfis`, `change-orders`, `punch`, `daily`, `drawings`, `commitments`, `closeout`, `purchase-orders`, `manpower`, `schedule`, `takeoff`. Bare `/projects/[id]` redirects to `…/submittals`.
- **`/library` (`src/app/library/page.tsx`)** — the cross-project **Library** (the only cross-project work surface).

**Module components are shared, not duplicated.** The route pages above are thin wrappers that render module components which still physically live in **`src/app/dashboard/_modules/*`** — e.g. `projects/[id]/submittals/page.tsx` renders `LibrarySubmittalsModule` (the same component backs both `/library` and the per-project Submittal Log). Treat `src/app/dashboard/_modules/` as the module *library*, imported cross-tree — not as a live "/dashboard" shell. Shared code (types, CSI data, formatters, UI primitives, badges, icons) lives in `src/app/dashboard/_shared/` and `src/app/projects/[id]/_shared/`.

### Spec books
Spec book management is **per-project setup**, not a dashboard module. It lives in **Settings → Projects** as an inline expandable panel on each project row (`src/components/project-spec-books.tsx`): list uploaded volumes, "Upload another volume" (presigned-URL flow — projects routinely carry 2–4 volumes), re-parse, delete. Parsed submittals land in the dashboard's Submittals → Pending Review. Projects without `project_scope_sections` rows show an amber "Scope not set" badge with a one-click scope wizard.

### API routes (`src/app/api/`)
All data mutations go through Next.js API routes that use the **server-side Supabase client** (`@/lib/supabase/server`) so auth cookies are read server-side. The browser client (`@/lib/supabase/client`) is used only in client components for auth state (never in API routes).

Key route groups:
| Route | Purpose |
|---|---|
| `/api/classify` | POST — sends PDF/filename to Claude Haiku, returns CSI division+section+metadata |
| `/api/search` | GET — AI query expansion via Haiku, then parallel `ilike` DB queries |
| `/api/folders` | GET — merges static CSI MasterFormat 2016 sections with live DB section data for sidebar |
| `/api/generate-cover` | POST — generates submittal cover sheet PDF, uploads to storage |
| `/api/rfis/[id]/pdf` | POST — generates RFI PDF, saves to `rfis/{id}/rfi_{number}.pdf` in storage |
| `/api/change-orders/[id]/pdf` | POST — generates CO PDF, saves to `change-orders/{id}/co_{number}.pdf` |
| `/api/punch/[id]/pdf` | POST — generates punch item PDF |
| `/api/daily-reports/[id]/pdf` | POST — generates daily field report PDF |
| `/api/drawings/[id]/pdf` | POST — generates drawing transmittal PDF (reads from `drawing_log` table) |
| `/api/gmail-intake` | POST — receives Google Pub/Sub push notifications, decodes the envelope, downloads attachments, auto-classifies, and inserts submittals |

### Gmail intake flow
`POST /api/gmail-intake?token=$GMAIL_WEBHOOK_SECRET` → validates the shared secret → decodes the Pub/Sub envelope → calls `src/lib/gmail-intake.ts` which looks up the `gmail_connections` row, fetches Gmail history, downloads PDF attachments, deduplicates by `gmail_message_id + file_name`, classifies via Claude Haiku, uploads to Supabase storage, inserts into `submittals` table. Auto-renews Gmail watch if expiring within 24 hours.

Webhook uses `GMAIL_WEBHOOK_SECRET` query-param for request validation. Endpoint is allow-listed in `src/middleware.ts` so it bypasses the auth redirect.

### PDF generation pattern
All PDF routes follow the same pattern: fetch record + project + company logo → build with `pdf-lib` (navy header, LBLUE section headers, signature lines) → upload to `submittals` bucket → update record's `generated_pdf_path` → return 7-day signed URL.

### Supabase client usage
- `src/lib/supabase/server.ts` — use in all API routes (reads auth cookies)
- `src/lib/supabase/client.ts` — browser-side only, for client components that read auth state (e.g. `dashboard/page.tsx`, `projects/[id]/project-chrome`). Never used in API routes.
- `/api/gmail-intake` uses `createClient(url, SERVICE_ROLE_KEY)` directly to bypass RLS (Google calls this endpoint, no user session)

### RLS pattern
Every table has RLS enabled. All tables need explicit policies for each operation (SELECT, INSERT, UPDATE, DELETE). Missing DELETE policies cause silent no-ops — the delete appears to succeed but the row persists on refresh. Always add DELETE policies when creating new tables.

### Search
Search intentionally avoids `textSearch` on `search_vector` (the column includes `ai_reasoning` text which causes false positives). It also avoids division-level queries (too broad). Only `ilike` on `file_name` + AI-expanded CSI section code matches are used.

## Environment Variables

See `.env.local.example`. Required vars:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY` — Claude Haiku for classify + search
- `GMAIL_WEBHOOK_SECRET` — validates incoming Pub/Sub POSTs
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth for Gmail connection
- `NEXT_PUBLIC_APP_URL` — used for OAuth redirect URIs

## Database Tables

Core tables: `submittals`, `rfis`, `change_orders`, `punch_items`, `daily_reports`, `drawing_log` (not `drawings`), `projects`, `team_members`, `company_settings`, `gmail_connections`

`submittals` soft-delete: `status = 'deleted'` (never hard-deleted). Active records have `status = 'active'`.

All user-created records include `uploaded_by UUID REFERENCES auth.users(id)`.

SQL migrations live in `sql/migrations.sql` — run manually in Supabase SQL Editor.
