import { describe, it, expect, vi, beforeEach } from "vitest"

// Control Capacitor's platform detection per-test.
const isNativePlatform = vi.fn<() => boolean>()
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativePlatform() },
}))

import { apiFetch, setAccessTokenProvider, API_BASE_URL } from "./api-client"

describe("apiFetch (ADR-010 client transport)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    setAccessTokenProvider(async () => "tok-abc123")
  })

  it("web: relative URL, cookie-based, NO Authorization header", async () => {
    isNativePlatform.mockReturnValue(false)
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)

    await apiFetch("/api/projects")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/projects")
    expect((init.headers as Headers).get("Authorization")).toBeNull()
  })

  it("native: absolute URL + Bearer header from the session provider", async () => {
    isNativePlatform.mockReturnValue(true)
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)

    await apiFetch("/api/projects")

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${API_BASE_URL}/api/projects`)
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer tok-abc123")
  })

  it("native: omits Authorization when there is no session token", async () => {
    isNativePlatform.mockReturnValue(true)
    setAccessTokenProvider(async () => null)
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)

    await apiFetch("/api/projects")

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Headers).get("Authorization")).toBeNull()
  })

  it("preserves method + caller headers", async () => {
    isNativePlatform.mockReturnValue(true)
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)

    await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe("POST")
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json")
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer tok-abc123")
  })
})
