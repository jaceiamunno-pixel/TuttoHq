# TuttoHQ native shell (Capacitor / ADR-010)

This is the **separate static-export build target** for the iOS native shell. It is
intentionally isolated from the root web/Vercel app so that `output: export` (global
per build) never touches the web build, and so the web app's API route handlers +
dynamic routes (`/projects/[id]`, `/invite/[token]`) — which have no static form —
don't block the export.

## Build

```bash
npm run build:native     # next build native  → native/out  (static bundle)
npm run cap:sync         # cap sync ios        → copies native/out into ios/App
```

`capacitor.config.ts` (repo root) sets `webDir: "native/out"`, so the shell's
HTML/JS/CSS ship on-device. Only `/api` is remote (absolute `API_BASE_URL`, bearer
auth — see `src/lib/api-client.ts`).

`native/out/` and `native/.next/` are build output and are git-ignored.

## What's here (v1 scope)

A single client screen that proves the ADR-010 auth loop end-to-end:
session-gated entry → sign in → `GET /api/projects` through `apiFetch` → render the
list. The active project id lives in **client state**, never an `[id]` path param,
so there is no dynamic route to break the export. Module porting + the native camera
swap come in the next step.

Shared transport/session code lives in the root app and is imported via `@/*`:
- `src/lib/api-client.ts` — platform-aware fetch wrapper (absolute URL + bearer on native)
- `src/lib/supabase/native.ts` — supabase-js client with a `@capacitor/preferences` storage adapter

The Xcode build / device install / TestFlight happen later on a Mac.
