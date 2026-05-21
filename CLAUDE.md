# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server (Next.js, port 3000)
npm run build     # Production build (also type-checks)
npx tsc --noEmit  # Type-check without building
```

There are no tests. TypeScript is the primary correctness check — always run `npx tsc --noEmit` before committing.

## Stack

- **Next.js 15** App Router, TypeScript, Tailwind CSS v4
- **Supabase** — database (Postgres + RLS), auth (cookie-based SSR), storage (`submittals` bucket for all user files, `company-assets` for logos)
- **Anthropic SDK** — Claude Haiku for AI classification (`/api/classify`) and search expansion (`/api/search`)
- **pdf-lib** — server-side PDF generation via shared `src/lib/pdf-builder.ts` (`PDFBuilder` class). Used for submittals, RFIs, COs, punch items, daily reports, drawing transmittals.
- **Google APIs** — Gmail watch + Pub/Sub for automated email intake; Drive for legacy file import

## Architecture

### Dashboard shell + modules
`src/app/dashboard/page.tsx` is a thin (~290-line) `"use client"` **shell**. It owns the horizontal top module nav, the slim left sidebar (project selector, Settings, sign-out), shared state (`activeModule`, `globalProjectId`, auth, projects, team), and renders the active module. On mobile the top nav collapses to a hamburger dropdown; the project selector stays visible.

Module code lives in `src/app/dashboard/_modules/` — one self-contained component each: `LibrarySubmittalsModule` (handles both the cross-project Library and the project-scoped Submittal Log), `RfisModule`, `ChangeOrdersModule`, `PunchModule`, `DailyModule`, `DrawingsModule`, `CommitmentsModule`, `CloseoutModule`. Shared code (types, CSI data, formatters, UI primitives, badges, icons) lives in `src/app/dashboard/_shared/`.

Modules receive `globalProjectId` as a prop. **Library is the only cross-project module**; every other module requires a project to be selected — the shell renders `<SelectProjectEmptyState>` (from `_shared/ui.tsx`) when none is.

`src/app/page.tsx` is a **marketing landing page** (Framer Motion, Lucide icons) — not the app.

Modules toggled by `activeModule` state: `library | submittals | rfis | changeorders | punch | daily | drawings | commitments | closeout`

### Spec books
Spec book management is **per-project setup**, not a dashboard module. It lives in **Settings → Projects** as an inline expandable panel on each project row (`src/components/project-spec-books.tsx`): list uploaded volumes, "Upload another volume" (presigned-URL flow — projects routinely carry 2–4 volumes), re-parse, delete. Parsed submittals land in the dashboard's Submittals → Pending Review. Projects without `project_scope_sections` rows show an amber "Scope not set" badge with a one-click scope wizard.

### API routes (`src/app/api/`)
All data mutations go through Next.js API routes that use the **server-side Supabase client** (`@/lib/supabase/server`) so auth cookies are read server-side. The client (`@/lib/supabase/client`) is only used in `dashboard/page.tsx` for auth state.

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
| `/api/gmail/webhook` | POST — receives Google Pub/Sub push notifications, triggers Gmail intake |
| `/api/gmail-intake` | POST — processes Gmail history, downloads attachments, auto-classifies and inserts submittals |

### Gmail intake flow
`POST /api/gmail/webhook` → decodes Pub/Sub notification → looks up `gmail_connections` row → calls `src/lib/gmail-intake.ts` which fetches Gmail history, downloads PDF attachments, deduplicates by `gmail_message_id + file_name`, classifies via Claude Haiku, uploads to Supabase storage, inserts into `submittals` table. Auto-renews Gmail watch if expiring within 24 hours.

Webhook uses `GMAIL_WEBHOOK_SECRET` env var for request validation.

### PDF generation pattern
All PDF routes follow the same pattern: fetch record + project + company logo → build with `pdf-lib` (navy header, LBLUE section headers, signature lines) → upload to `submittals` bucket → update record's `generated_pdf_path` → return 7-day signed URL.

### Supabase client usage
- `src/lib/supabase/server.ts` — use in all API routes (reads auth cookies)
- `src/lib/supabase/client.ts` — use only in `dashboard/page.tsx` (browser-side, for `getUser()`)
- Gmail webhook uses `createClient(url, SERVICE_ROLE_KEY)` directly to bypass RLS (Google calls this endpoint, no user session)

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
