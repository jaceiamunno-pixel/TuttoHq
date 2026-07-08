import { NextRequest, NextResponse } from "next/server"
import { getCtx, isResponse, badRequest, takeoffExists } from "../../_helpers"

// Scale calibration (Phase B) — one row per (takeoff, sheet, page). A scale belongs
// to a SHEET (`source_ref` = drawing_sheets id, matching a mark's source_ref), so
// two sheets that both open at page 0 keep independent scales. POST upserts on the
// UNIQUE (takeoff_id, source_ref, page) key (recalibrating overwrites that sheet
// page's single row); DELETE clears it. company_id is stamped server-side from the
// caller's session — never sent by the client — and RLS (get_my_company_id() + the
// restrictive demo write-blocks) scopes every write to the caller's tenant.
//
// units_per_px = real-world units per unit of aspect-corrected normalized page
// distance (computed client-side from the drawn calibration segment + the entered
// real length). cal_* is that drawn segment (normalized), kept re-editable. A null
// source_ref (ad-hoc PDF with no ingested sheet) collapses to one row per page via
// the DB's NULLS NOT DISTINCT unique — handled the same way marks handle null.

const SCALE_SELECT = "id, takeoff_id, source_ref, page, units_per_px, unit, cal_x1, cal_y1, cal_x2, cal_y2"
const UNITS = new Set(["ft", "in", "m"])

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase, companyId } = ctx
  const { id: takeoffId } = await params
  if (!(await takeoffExists(supabase, takeoffId))) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const sourceRef = typeof body.source_ref === "string" ? body.source_ref : null
  const page = Number.isFinite(body.page) ? Math.trunc(Number(body.page)) : NaN
  const unitsPerPx = Number(body.units_per_px)
  const unit = typeof body.unit === "string" && UNITS.has(body.unit) ? body.unit : "ft"
  const cal = ["cal_x1", "cal_y1", "cal_x2", "cal_y2"].map(k => Number(body[k]))
  if (!Number.isInteger(page) || page < 0) return badRequest("page is required")
  if (!Number.isFinite(unitsPerPx) || unitsPerPx <= 0) return badRequest("units_per_px must be a positive number")
  if (cal.some(n => !Number.isFinite(n))) return badRequest("calibration segment (cal_x1..cal_y2) is required")

  const { data, error } = await supabase
    .from("takeoff_page_scales")
    .upsert({
      takeoff_id: takeoffId, company_id: companyId, source_ref: sourceRef, page,
      units_per_px: unitsPerPx, unit,
      cal_x1: cal[0], cal_y1: cal[1], cal_x2: cal[2], cal_y2: cal[3],
    }, { onConflict: "takeoff_id,source_ref,page" })
    .select(SCALE_SELECT).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ scale: data })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx()
  if (isResponse(ctx)) return ctx
  const { supabase } = ctx
  const { id: takeoffId } = await params
  const params_ = req.nextUrl.searchParams
  const pageParam = params_.get("page")
  const page = pageParam == null ? NaN : Math.trunc(Number(pageParam))
  const sourceRef = params_.get("source_ref") // absent → null (matches an ad-hoc PDF row)
  if (!Number.isInteger(page) || page < 0) return badRequest("page is required")

  let q = supabase.from("takeoff_page_scales").delete().eq("takeoff_id", takeoffId).eq("page", page)
  q = sourceRef == null ? q.is("source_ref", null) : q.eq("source_ref", sourceRef)
  const { error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
