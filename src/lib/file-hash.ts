// SHA-256 of file bytes for exact-duplicate detection — BROWSER + SHARED.
//
// IMPORT-SAFE FROM CLIENT COMPONENTS. This module uses ONLY Web Crypto
// (crypto.subtle) and pure JS — no Node built-ins. The Node-crypto path
// lives in a SEPARATE module (./file-hash-node) so a `node:` import can
// never leak into the client bundle.
//
// WHY THE SPLIT EXISTS: file-hash.ts originally also held
// hashBufferInNode (which did `await import("node:crypto")`).
// LibrarySubmittalsModule is a "use client" component and imports
// hashFileInBrowser from here — webpack therefore bundled the whole
// module for the browser, pulling `node:crypto` into the client bundle
// and breaking the Vercel build ("You may need an additional plugin to
// handle node: URIs"). Keeping this file Node-free fixes that class of
// bug permanently.
//
// Server code that needs to hash a Buffer imports hashBufferInNode from
// "./file-hash-node". Server code that only validates a hash string can
// import isValidSha256 from HERE (it's pure and isomorphic).

/** Hex string, lowercase. SHA-256 = 256 bits = 64 hex chars. */
export type Sha256Hex = string

/**
 * Hash a File using Web Crypto. Requires a secure context (HTTPS or
 * localhost), which the app always runs in.
 */
export async function hashFileInBrowser(file: File): Promise<Sha256Hex> {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return bufferToHex(new Uint8Array(digest))
}

export function bufferToHex(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0")
  }
  return out
}

/** Quick shape check before sending to the API. Never trust caller input. */
export function isValidSha256(hex: unknown): hex is Sha256Hex {
  return typeof hex === "string" && /^[0-9a-f]{64}$/.test(hex)
}
