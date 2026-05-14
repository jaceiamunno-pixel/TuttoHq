import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("suppliers")
    .select("*")
    .order("company_name")

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { company_name, specialty, contact_name, phone, email, website, notes } = await req.json()
  if (!company_name?.trim()) return NextResponse.json({ error: "company_name required" }, { status: 400 })

  const { data, error } = await supabase
    .from("suppliers")
    .insert({ company_name: company_name.trim(), specialty: specialty?.trim() || null, contact_name: contact_name?.trim() || null, phone: phone?.trim() || null, email: email?.trim() || null, website: website?.trim() || null, notes: notes?.trim() || null, uploaded_by: user.id })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
