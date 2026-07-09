import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { signPaths } from "@/lib/package-pdf"
import { normalizeSubmittalTitle } from "@/lib/title-normalize"

// GET /api/submittal-packages/[id]/files — the package's generation history.
// Reads submittal_package_files (append-only), newest first, grouped by
// generation_id, each file carrying a fresh signed URL. Backs the "Past
// generations" UI. Read-only; RLS scopes to the caller's company.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: rows, error } = await supabase
    .from("submittal_package_files")
    .select("submittal_id, generation_id, coversheet_mode, storage_path, file_name, file_size, generated_at, submittals(submittal_seq, file_name)")
    .eq("package_id", id)
    .order("generated_at", { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (rows ?? []) as any[]
  const signed = await signPaths(supabase, list.map(r => r.storage_path))

  // Group by generation_id, preserving the newest-first order.
  const order: string[] = []
  const groups = new Map<string, {
    generationId: string
    generatedAt: string
    coversheetMode: string
    files: Array<{ submittalId: string | null; label: string; fileName: string; fileSize: number | null; url: string | null }>
  }>()

  for (const r of list) {
    const gid = r.generation_id as string
    if (!groups.has(gid)) {
      order.push(gid)
      groups.set(gid, {
        generationId: gid,
        generatedAt: r.generated_at,
        coversheetMode: r.coversheet_mode,
        files: [],
      })
    }
    // 'package' rows are the whole-package PDF. 'per_item' rows label from the
    // linked submittal (which may be NULL if the submittal was later deleted —
    // ON DELETE SET NULL — in which case we fall back to the stored file name).
    const label = r.coversheet_mode === "package"
      ? "Full package"
      : (r.submittals?.file_name
          ? normalizeSubmittalTitle(String(r.submittals.file_name))
          : r.file_name)
    groups.get(gid)!.files.push({
      submittalId: r.submittal_id ?? null,
      label,
      fileName: r.file_name,
      fileSize: r.file_size ?? null,
      url: signed.get(r.storage_path) ?? null,
    })
  }

  return NextResponse.json({ generations: order.map(gid => groups.get(gid)!) })
}
