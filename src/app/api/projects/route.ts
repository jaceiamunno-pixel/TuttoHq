import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("projects")
    .select("id, name, number, location, gc_name, architect, created_at, created_by")
    .order("created_at", { ascending: true })

  if (error) {
    console.error("Failed to load projects:", error)
    return NextResponse.json({ error: "Failed to load projects" }, { status: 500 })
  }

  return NextResponse.json({ projects: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()

  const { name, number, location, gc_name, architect } = body

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({
      name: name.trim(),
      number: number?.trim() ?? null,
      location: location?.trim() ?? null,
      gc_name: gc_name?.trim() ?? null,
      architect: architect?.trim() ?? null,
    })
    .select("id, name, number, location, gc_name, architect, created_at")
    .single()

  if (error) {
    console.error("Failed to create project:", error)
    return NextResponse.json({ error: "Failed to create project" }, { status: 500 })
  }

  return NextResponse.json({ project: data }, { status: 201 })
}
