import { describe, it, expect, beforeEach, vi } from "vitest"

// In-memory stand-in for the native @capacitor/preferences store.
const store = new Map<string, string>()
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: store.has(key) ? store.get(key)! : null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value)
    },
    remove: async ({ key }: { key: string }) => {
      store.delete(key)
    },
  },
}))

import { preferencesStorage } from "./native"

describe("preferencesStorage (supabase-js session persistence)", () => {
  beforeEach(() => store.clear())

  it("round-trips set → get → remove", async () => {
    expect(await preferencesStorage.getItem("sb-session")).toBeNull()

    await preferencesStorage.setItem("sb-session", '{"access_token":"x"}')
    expect(await preferencesStorage.getItem("sb-session")).toBe('{"access_token":"x"}')

    await preferencesStorage.removeItem("sb-session")
    expect(await preferencesStorage.getItem("sb-session")).toBeNull()
  })
})
