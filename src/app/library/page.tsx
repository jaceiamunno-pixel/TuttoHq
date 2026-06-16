"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import AppChrome from "@/components/app-chrome"
import LibrarySubmittalsModule from "@/app/dashboard/_modules/LibrarySubmittalsModule"
import { createClient } from "@/lib/supabase/client"
import type { Project, TeamMember } from "@/app/dashboard/_shared/types"

// Top-level Library — cross-project reusable submittal content. Mounts the
// existing module in "library" mode (unchanged). Library is company-scoped and
// has no single active project, so a navigate to the project-scoped Submittal
// Log sends the user back to the project picker.
export default function LibraryPage() {
  const router = useRouter()
  const [appProjects, setAppProjects] = useState<Project[]>([])
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [userEmail, setUserEmail]     = useState<string | null>(null)
  const [submittalsView, setSubmittalsView] = useState<"log" | "pending" | "packages">("log")

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null))
    fetch("/api/projects").then(r => r.json()).then(d => setAppProjects(d.projects ?? [])).catch(() => {})
    fetch("/api/team").then(r => r.json()).then(d => setTeamMembers(d.members ?? [])).catch(() => {})
  }, [])

  function onNavigate(m: "library" | "submittals") {
    if (m === "submittals") router.push("/dashboard")
  }

  return (
    <AppChrome>
      <div className="flex-1 min-h-0 flex flex-col">
        <LibrarySubmittalsModule
          activeModule="library"
          globalProjectId=""
          appProjects={appProjects}
          teamMembers={teamMembers}
          userEmail={userEmail}
          submittalsView={submittalsView}
          setSubmittalsView={setSubmittalsView}
          onNavigate={onNavigate}
        />
      </div>
    </AppChrome>
  )
}
