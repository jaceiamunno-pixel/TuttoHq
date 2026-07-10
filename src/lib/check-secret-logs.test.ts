import { describe, it, expect } from "vitest";
// Import the zero-dependency guard from tools/ (typed via check-secret-logs.d.mts).
import { findSecretLogViolations, findSuppressedSecretLogs } from "../../tools/check-secret-logs.mjs";

const matched = (src: string) =>
  findSecretLogViolations(src, "sample.ts").map((v) => v.matched.toLowerCase());

describe("check-secret-logs — the exact line it exists to catch", () => {
  it("FIRES on `console.log(\"[apiFetch] bearer json=\", JSON.stringify(bearer))` (b074c2a)", () => {
    const src = [
      "const bearer = `Bearer ${token}`",
      'console.log("[apiFetch] bearer json=", JSON.stringify(bearer))',
    ].join("\n");
    const v = findSecretLogViolations(src, "src/lib/api-client.ts");
    expect(v).toHaveLength(1);
    expect(v[0].method).toBe("log");
    expect(v[0].line).toBe(2); // the console line, not the `const bearer` line
    expect(v[0].matched.toLowerCase()).toContain("bearer");
  });

  // The full diagnostic block from b074c2a, verbatim. Exactly two of its nine
  // console.* lines log a credential value (the token probe + the bearer line);
  // the rest log path/url/status/error metadata and must stay silent.
  it("flags exactly the 2 credential lines in the real b074c2a block", () => {
    const block = String.raw`
    console.log("[apiFetch] path=", JSON.stringify(path), " url=", JSON.stringify(url))
    console.log(
      "[apiFetch] fetch-patched?=",
      !String(g.fetch).includes("[native code]"),
      " CapacitorWebFetch=",
      typeof g.CapacitorWebFetch,
    )
    try {
      token = await getAccessToken()
    } catch (e) {
      const err = e as Error
      console.error("[apiFetch] getAccessToken() THREW:", err?.name, err?.message, err?.stack)
      throw e
    }
    const bearer = ` + "`Bearer ${token}`" + String.raw`
    console.log(
      "[apiFetch] token: typeof=",
      typeof token,
      " len=",
      token?.length,
      " asciiPrintable=",
      token == null ? "n/a" : /^[\x20-\x7E]*$/.test(token),
      " json=",
      JSON.stringify(token),
    )
    console.log("[apiFetch] bearer json=", JSON.stringify(bearer))
    try {
      const res = await fetch(url, { ...init, headers })
      console.log("[apiFetch] fetch() OK status=", res.status)
      return res
    } catch (e) {
      const err = e as Error
      console.error("[apiFetch] fetch() THREW:", err?.name, err?.message, err?.stack)
      console.warn("[apiFetch] retrying via un-patched CapacitorWebFetch — success here CONFIRMS H2 (CapacitorHttp)")
      console.warn("[apiFetch] CapacitorWebFetch status=", res2.status)
    }
    `;
    const hits = matched(block);
    expect(hits.sort()).toEqual(["bearer", "token"]);
  });
});

describe("check-secret-logs — other credential shapes it must catch", () => {
  it("object spread of a session into console (the sneaky case)", () => {
    expect(matched("console.log({ ...session })")).toContain("session");
  });
  it("bare identifier argument", () => {
    expect(matched("console.debug(accessToken)")).toContain("accesstoken");
  });
  it("template-string interpolation of a token", () => {
    expect(matched("console.log(`auth=${authToken}`)")).toContain("authtoken");
  });
  it("JSON.stringify of a password", () => {
    expect(matched("console.error('dump', JSON.stringify(password))")).toContain("password");
  });
  it("camelCase refreshToken", () => {
    expect(matched("console.log('x', refreshToken)")).toContain("refreshtoken");
  });
});

describe("check-secret-logs — must NOT fire on benign prod lines", () => {
  // These are the real lines from the 9 files the sweep flagged as benign:
  // the credential word lives inside a descriptive string, never a value.
  const benign = [
    'console.log("[gmail-intake] webhook: rejected — bad or missing token")',
    'console.error("[cron/send-reminders] FAIL CRON_SECRET not configured")',
    'console.log("[2/6] Minting a session JWT for the first user via admin API…")',
    "console.error(`[dispatch] getValidToken failed for user ${user.id}`, err)",
    'console.log("  strong match (>=2 token overlap): " + strong.length)',
  ];
  for (const line of benign) {
    it(`silent on: ${line.slice(0, 48)}…`, () => {
      expect(findSecretLogViolations(line, "f.ts")).toHaveLength(0);
    });
  }

  it("silent on a non-console Bearer header assignment", () => {
    expect(findSecretLogViolations('headers.set("Authorization", `Bearer ${token}`)', "f.ts")).toHaveLength(0);
  });
});

describe("check-secret-logs — suppression hatch", () => {
  it("respects an inline allow-secret-log comment", () => {
    expect(findSecretLogViolations("console.log(token) // allow-secret-log: debugging local only", "f.ts")).toHaveLength(0);
  });
  it("respects allow-secret-log on the line above", () => {
    const src = "// allow-secret-log: intentional\nconsole.log(JSON.stringify(session))";
    expect(findSecretLogViolations(src, "f.ts")).toHaveLength(0);
  });

  // A hatch that nobody can see becomes the default — so suppressions must be
  // trackable, not merely silent. --list-suppressions surfaces these.
  it("records a suppressed line so it can be listed (not silently dropped)", () => {
    const src = "console.log(token) // allow-secret-log: debugging local only";
    const sup = findSuppressedSecretLogs(src, "f.ts");
    expect(sup).toHaveLength(1);
    expect(sup[0].matched.toLowerCase()).toContain("token");
    expect(findSecretLogViolations(src, "f.ts")).toHaveLength(0); // not double-counted
  });
  it("does not record a non-secret console line as a suppression", () => {
    expect(findSuppressedSecretLogs('console.log("hello") // allow-secret-log: n/a', "f.ts")).toHaveLength(0);
  });
});
