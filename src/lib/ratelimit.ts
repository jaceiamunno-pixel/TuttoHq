import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"
import { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"

// ─────────────────────────────────────────────────────────────────────────────
// API rate limiting — Upstash Redis sliding-window. (ADR: "API rate limiting".)
//
// TWO TIERS, two intentionally DIFFERENT outage behaviors:
//
//   TIER 1 — abuse protection (auth surface + write methods), enforced in
//            middleware.ts. FAILS OPEN: an Upstash hiccup must never lock users
//            out of the app. Keyed by IP (pre-auth) or user id (post-auth).
//
//   TIER 2 — cost protection (routes that call Claude Haiku or render/parse/OCR
//            PDFs), enforced per-route via enforceAiLimit(). FAILS CLOSED: if the
//            limiter cannot run, the request is REJECTED (503) so an outage can
//            never become an uncapped Anthropic/compute bill. Keyed by company_id.
//
// The asymmetry is deliberate. Do not collapse the two into one wrapper.
// ─────────────────────────────────────────────────────────────────────────────

// A sliding-window duration string accepted by @upstash/ratelimit, e.g. "60 s".
type Duration = `${number} ${"ms" | "s" | "m" | "h" | "d"}`

interface LimitConfig {
  /** Max requests allowed per window. */
  tokens: number
  /** Sliding window length. */
  window: Duration
}

// ── PLACEHOLDER LIMITS ───────────────────────────────────────────────────────
// These are deliberately GENEROUS so normal workflows never trip them — they are
// abuse / cost ceilings, not throttles. Jace sets the REAL numbers before merge
// (see the PR description). Each window is per-key (per IP / per user / per
// company), not global.

/** Tier 1 — auth surface (login/signup/oauth), keyed by client IP. */
export const AUTH_LIMIT: LimitConfig = { tokens: 30, window: "60 s" }

/** Tier 1 — authenticated write methods (POST/PATCH/PUT/DELETE), keyed by user. */
export const WRITE_LIMIT: LimitConfig = { tokens: 240, window: "60 s" }

/** Tier 2 — expensive Claude / PDF-parse routes, keyed by company_id. */
export const AI_PARSE_LIMIT: LimitConfig = { tokens: 60, window: "60 s" }

// ── Redis + limiter singletons (reused across warm invocations) ──────────────
//
// Built lazily from env. If UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// are absent the limiter is "unconfigured": Tier 1 treats that as fail-open
// (allow), Tier 2 as fail-closed (503). Both env vars are server-only — never
// expose them via NEXT_PUBLIC_*.
let cachedRedis: Redis | null | undefined
function getRedis(): Redis | null {
  if (cachedRedis === undefined) {
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN
    cachedRedis = url && token ? new Redis({ url, token }) : null
    if (!cachedRedis) {
      console.warn(
        "[ratelimit] UPSTASH_REDIS_REST_URL/TOKEN not set — Tier 1 fails open (allow), Tier 2 fails closed (503).",
      )
    }
  }
  return cachedRedis
}

const limiterCache = new Map<string, Ratelimit>()
function getLimiter(prefix: string, cfg: LimitConfig): Ratelimit | null {
  const redis = getRedis()
  if (!redis) return null
  const key = `${prefix}:${cfg.tokens}:${cfg.window}`
  let limiter = limiterCache.get(key)
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(cfg.tokens, cfg.window),
      prefix: `rl:${prefix}`,
      analytics: false,
    })
    limiterCache.set(key, limiter)
  }
  return limiter
}

interface RateResult {
  /** Whether the request is under the limit. */
  ok: boolean
  /** Seconds until the window frees up (for Retry-After). */
  retryAfter: number
  /** True when Upstash env is present (limiter is wired). */
  configured: boolean
  /** True when the Upstash call threw (network/outage). */
  errored: boolean
}

// Low-level check. Returns a neutral result; the Tier-1/Tier-2 callers decide
// what an unconfigured/errored limiter means (open vs closed).
async function rateCheck(prefix: string, cfg: LimitConfig, identifier: string): Promise<RateResult> {
  const limiter = getLimiter(prefix, cfg)
  if (!limiter) return { ok: true, retryAfter: 0, configured: false, errored: false }
  try {
    const { success, reset } = await limiter.limit(identifier)
    const retryAfter = success ? 0 : Math.max(1, Math.ceil((reset - Date.now()) / 1000))
    return { ok: success, retryAfter, configured: true, errored: false }
  } catch (err) {
    console.error(`[ratelimit] ${prefix} check failed:`, err)
    return { ok: true, retryAfter: 0, configured: true, errored: true }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 1 — middleware helpers. FAIL OPEN. Return { blocked, retryAfter }; the
// middleware builds the 429 response itself (so it can attach CORS on the native
// bearer path).
// ─────────────────────────────────────────────────────────────────────────────

export interface Tier1Verdict {
  blocked: boolean
  retryAfter: number
}

/** Auth surface (login/signup/oauth) — keyed by client IP. */
export async function checkAuthLimit(ip: string): Promise<Tier1Verdict> {
  const r = await rateCheck("auth", AUTH_LIMIT, ip)
  // FAIL OPEN: unconfigured or errored → allow.
  if (!r.configured || r.errored) return { blocked: false, retryAfter: 0 }
  return { blocked: !r.ok, retryAfter: r.retryAfter }
}

/** Authenticated write methods — keyed by user id (cookie) or JWT sub (native). */
export async function checkWriteLimit(userKey: string): Promise<Tier1Verdict> {
  const r = await rateCheck("write", WRITE_LIMIT, userKey)
  // FAIL OPEN: unconfigured or errored → allow.
  if (!r.configured || r.errored) return { blocked: false, retryAfter: 0 }
  return { blocked: !r.ok, retryAfter: r.retryAfter }
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 2 — per-route guard for the expensive (Claude / PDF-parse) surface.
// FAIL CLOSED. Call AFTER the route's own getUser() 401 gate, BEFORE any
// expensive work:
//
//     const limited = await enforceAiLimit(supabase)
//     if (limited) return limited
//
// Keyed by company_id (resolved via the same get_my_company_id() the routes
// already trust). Returns a ready-to-return NextResponse (503 or 429) when the
// request must be stopped, or null to proceed.
// ─────────────────────────────────────────────────────────────────────────────

export async function enforceAiLimit(supabase: SupabaseClient): Promise<NextResponse | null> {
  // DEMO COST GATE — checked FIRST, before company_id resolution and before any
  // Upstash call. The public read-only demo tenant (role='demo') must never
  // INVOKE the expensive Claude / PDF-parse / OCR surface, even though
  // migrations 0026/0027 already block the resulting writes at the DB. Placing
  // this at the top of the single Tier-2 chokepoint covers the whole expensive
  // surface from one place and cannot drift out of sync with the rate-limited
  // set. Wrapped in try/catch — a failed is_demo_user() lookup must NOT 403 a
  // real paying user, so on throw we fall through to the existing limiter
  // (worst case: a demo user who slips an rpc error still hits the DB
  // write-block + definer guards, so there is no data-integrity hole — only the
  // cost protection degrades, and only during an rpc error).
  try {
    const { data: isDemo } = await supabase.rpc("is_demo_user")
    if (isDemo === true) {
      return NextResponse.json(
        { error: "This action isn't available on the demo account." },
        { status: 403 },
      )
    }
  } catch {
    // is_demo_user() lookup failed — treat as NOT demo and fall through.
  }

  // Tier-2 key = company_id. Resolve it through the caller's authed client so
  // RLS / auth.uid() picks the tenant exactly as the route does.
  let companyId: string | null = null
  try {
    const { data } = await supabase.rpc("get_my_company_id")
    companyId = data ? String(data) : null
  } catch {
    companyId = null
  }

  // No resolvable tenant is an auth/company problem, NOT a limiter outage —
  // defer to the route's own handling rather than fail-closing for the wrong
  // reason. (The fail-closed below is specifically for Upstash being down.)
  if (!companyId) return null

  const r = await rateCheck("ai", AI_PARSE_LIMIT, companyId)

  // FAIL CLOSED: an unconfigured OR unreachable limiter must not become an
  // uncapped-cost window for the AI/PDF surface.
  if (!r.configured || r.errored) {
    return NextResponse.json(
      { error: "Rate limiter unavailable. This protected endpoint is temporarily disabled." },
      { status: 503, headers: { "Retry-After": "30" } },
    )
  }

  if (!r.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded for AI/parse operations. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(r.retryAfter) } },
    )
  }

  return null
}
