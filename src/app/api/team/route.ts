import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("team_members")
    .select("id, name, title, email, created_at")
    .order("created_at", { ascending: true })

  if (error) {
    console.error("Failed to load team members:", error)
    return NextResponse.json({ error: "Failed to load team members" }, { status: 500 })
  }

  return NextResponse.json({ members: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()

  const { name, title, email } = body

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("team_members")
    .insert({ name: name.trim(), title: title?.trim() ?? null, email: email?.trim() ?? null })
    .select("id, name, title, email, created_at")
    .single()

  if (error) {
    console.error("Failed to create team member:", error)
    return NextResponse.json({ error: "Failed to create team member" }, { status: 500 })
  }

  return NextResponse.json({ member: data }, { status: 201 })
}
