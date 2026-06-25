"use client"

import { useCallback, useEffect, useState, type CSSProperties } from "react"
import {
  apiFetch,
  setAccessTokenProvider,
  isNative,
  API_BASE_URL,
} from "@/lib/api-client"
import { getNativeSupabaseClient } from "@/lib/supabase/native"

type Project = { id: string; name: string; number: string | null }

/**
 * Minimal v1 native shell screen — just enough to prove the ADR-010 auth loop
 * end-to-end: session-gated entry → an authed screen that calls GET /api/projects
 * through the shared api-client wrapper (absolute URL + bearer on native) and
 * renders the list. The "active project" is held in CLIENT STATE, never read
 * from an [id] path param, so there is no dynamic route to break the static
 * export. Module porting + the native camera swap come in the next step.
 */
export default function NativeShell() {
  const [ready, setReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  const loadProjects = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch("/api/projects")
      if (!res.ok) {
        setError(`GET /api/projects → ${res.status}`)
        return
      }
      const json = (await res.json()) as { projects?: Project[] }
      const list = json.projects ?? []
      setProjects(list)
      // projectId lives in client state, not the URL.
      setActiveProjectId((prev) => prev ?? list[0]?.id ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const supabase = getNativeSupabaseClient()

    // Wire the wrapper's bearer source to the live session.
    setAccessTokenProvider(async () => {
      const { data } = await supabase.auth.getSession()
      return data.session?.access_token ?? null
    })

    supabase.auth.getSession().then(({ data }) => {
      const hasSession = !!data.session
      setSignedIn(hasSession)
      setReady(true)
      if (hasSession) void loadProjects()
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(!!session)
      if (session) void loadProjects()
      else {
        setProjects([])
        setActiveProjectId(null)
      }
    })

    return () => sub.subscription.unsubscribe()
  }, [loadProjects])

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const supabase = getNativeSupabaseClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (signInError) {
      setError(signInError.message)
      setLoading(false)
    }
    // onAuthStateChange drives the transition + project load on success.
  }

  async function handleSignOut() {
    await getNativeSupabaseClient().auth.signOut()
  }

  if (!ready) {
    return (
      <main style={wrap}>
        <p style={muted}>Loading…</p>
      </main>
    )
  }

  if (!signedIn) {
    return (
      <main style={wrap}>
        <div style={card}>
          <h1 style={h1}>TuttoHQ</h1>
          <p style={muted}>
            {isNative() ? `Native shell → ${API_BASE_URL}` : "Web preview"}
          </p>
          <form onSubmit={handleSignIn} style={form}>
            <input
              style={input}
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
            <input
              style={input}
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error && <p style={errStyle}>{error}</p>}
            <button style={btn} type="submit" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </main>
    )
  }

  return (
    <main style={wrap}>
      <div style={{ ...card, width: 420 }}>
        <div style={headerRow}>
          <h1 style={h1}>Projects</h1>
          <button style={linkBtn} onClick={handleSignOut}>
            Sign out
          </button>
        </div>
        {loading && <p style={muted}>Loading projects…</p>}
        {error && <p style={errStyle}>{error}</p>}
        <ul style={list}>
          {projects.map((p) => (
            <li key={p.id}>
              <button
                style={{ ...row, ...(p.id === activeProjectId ? rowActive : {}) }}
                onClick={() => setActiveProjectId(p.id)}
              >
                <span>{p.name}</span>
                {p.number && <span style={muted}>#{p.number}</span>}
              </button>
            </li>
          ))}
        </ul>
        {!loading && !error && projects.length === 0 && (
          <p style={muted}>No projects.</p>
        )}
        {activeProjectId && (
          <p style={{ ...muted, marginTop: 12 }}>
            Active project (client state): {activeProjectId}
          </p>
        )}
      </div>
    </main>
  )
}

const wrap: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
}
const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #E2E8F0",
  borderRadius: 12,
  boxShadow: "0 10px 30px rgba(15,23,42,0.08)",
  width: 360,
  padding: 28,
}
const h1: CSSProperties = { fontSize: 18, fontWeight: 700, margin: 0 }
const muted: CSSProperties = { fontSize: 13, color: "#64748B", margin: "4px 0 0" }
const form: CSSProperties = { display: "grid", gap: 10, marginTop: 16 }
const input: CSSProperties = {
  height: 40,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid #E2E8F0",
  fontSize: 14,
}
const btn: CSSProperties = {
  height: 40,
  borderRadius: 8,
  border: "none",
  background: "#7B9BB5",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
}
const linkBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#7B9BB5",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
}
const errStyle: CSSProperties = { fontSize: 12, color: "#DC2626", margin: 0 }
const headerRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
}
const list: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "12px 0 0",
  display: "grid",
  gap: 6,
}
const row: CSSProperties = {
  width: "100%",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #E2E8F0",
  background: "#fff",
  fontSize: 14,
  cursor: "pointer",
}
const rowActive: CSSProperties = {
  borderColor: "#7B9BB5",
  background: "#7B9BB510",
}
