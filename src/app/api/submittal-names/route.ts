import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()

  const [matls, mfrs, dims] = await Promise.all([
    supabase.from("submittals").select("material_name").eq("status", "active").is("deleted_at", null).not("material_name", "is", null),
    supabase.from("submittals").select("manufacturer").eq("status", "active").is("deleted_at", null).not("manufacturer", "is", null),
    supabase.from("submittals").select("dimensions").eq("status", "active").is("deleted_at", null).not("dimensions", "is", null),
  ])

  function unique(rows: Record<string, string | null>[], key: string): string[] {
    return [...new Set(rows.map(r => r[key]).filter((v): v is string => !!v))].sort()
  }

  return NextResponse.json({
    materials:     unique(matls.data ?? [], "material_name"),
    manufacturers: unique(mfrs.data  ?? [], "manufacturer"),
    dimensions:    unique(dims.data  ?? [], "dimensions"),
  })
}
