// Strip-at-upload: generate the stripped Library copy ONCE and store it.
//
// SERVER-ONLY. Imports pdf-strip (→ unpdf / pdf-lib / node), so it must
// never be imported by a client component. Used by:
//   - /api/upload      (via next/server `after()` — runs post-response so a
//                       strip failure can never block or fail the upload)
//   - scripts/backfill-stripped-copies.mjs (one-time, existing files)
//
// CONTRACT: best-effort, NEVER throws to the caller. On any failure (download
// error, no stamp anchor, strip error, upload error, update error) it returns
// { stripped: false } and leaves stripped_storage_path NULL — the view then
// serves the original. The original object is never modified.
//
// Uses a SERVICE-ROLE client (not the request's cookie client): in `after()`
// the request/cookie scope is unreliable post-response, and ownership was
// already validated by the calling route before insert. Same pattern as
// gmail-intake.

import { createClient } from "@supabase/supabase-js"
import { stripFrontMatter } from "./pdf-strip"

export interface StripAndStoreResult {
  stripped: boolean
  strippedPath?: string
  reason?: "no-anchor" | "download-failed" | "strip-failed" | "upload-failed" | "update-failed" | "config"
}

/** Filesystem-safe base name from a display/file name. */
function safeBase(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80)
  return base || "submittal"
}

export async function stripAndStore(opts: {
  submittalId: string
  storagePath: string
  fileName: string
  companyId: string
}): Promise<StripAndStoreResult> {
  // One observable line per upload so a silently-broken strip is visible
  // (and distinguishable from a legitimate no-anchor). The default
  // best-effort design swallows failures; this is the only signal.
  const log = (r: StripAndStoreResult) => {
    const tag = r.stripped ? "stripped" : (r.reason ?? "unknown")
    console.log(`[strip-at-upload] ${tag} submittal=${opts.submittalId} file=${JSON.stringify(opts.fileName).slice(0, 80)}${r.strippedPath ? ` → ${r.strippedPath}` : ""}`)
    return r
  }
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return log({ stripped: false, reason: "config" })
    const sb = createClient(url, key, { auth: { persistSession: false } })

    // 1. Download the original.
    const { data: blob, error: dlErr } = await sb.storage.from("submittals").download(opts.storagePath)
    if (dlErr || !blob) return log({ stripped: false, reason: "download-failed" })
    const original = Buffer.from(await blob.arrayBuffer())

    // 2. Strip. stripFrontMatter is itself best-effort (returns the original
    //    buffer + null plan when there's no anchor or on any catchable error).
    const { buffer: strippedBuffer, plan } = await stripFrontMatter(original)
    if (!plan) return log({ stripped: false, reason: "no-anchor" })  // nothing to strip → original serves

    // 3. Store the stripped copy under a dedicated prefix (separate from
    //    uploads/ so it's easy to identify + never collides with originals).
    const strippedPath = `${opts.companyId}/library-stripped/${crypto.randomUUID()}_${safeBase(opts.fileName)}.pdf`
    const { error: upErr } = await sb.storage
      .from("submittals")
      .upload(strippedPath, strippedBuffer, { contentType: "application/pdf", upsert: false })
    if (upErr) return log({ stripped: false, reason: "upload-failed" })

    // 4. Record it. View serves stripped_storage_path when set.
    const { error: updErr } = await sb
      .from("submittals")
      .update({ stripped_storage_path: strippedPath })
      .eq("id", opts.submittalId)
    if (updErr) {
      // Roll back the orphaned stripped object (best-effort).
      await sb.storage.from("submittals").remove([strippedPath]).catch(() => {})
      return log({ stripped: false, reason: "update-failed" })
    }

    return log({ stripped: true, strippedPath })
  } catch {
    // Absolute backstop — never throw to the caller.
    return log({ stripped: false, reason: "strip-failed" })
  }
}
