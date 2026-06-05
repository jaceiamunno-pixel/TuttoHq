// SHA-256 of file bytes for exact-duplicate detection.
//
// TWO ENTRY POINTS, deliberately separate because the underlying APIs are:
//
//   - hashFileInBrowser(file)    — Web Crypto SubtleCrypto.digest in the
//                                  browser; the bytes already live in
//                                  memory from the <input type=file>.
//                                  Used by direct Library uploads BEFORE
//                                  the file is PUT to storage so the dupe
//                                  check can fire pre-upload.
//
//   - hashBufferInNode(buffer)   — Node 'crypto' module; used by the
//                                  bulk-import /analyze route which is
//                                  already downloading and parsing the
//                                  staged PDF — adding the hash here is
//                                  essentially free.
//
// Hex-string format (64 lowercase hex chars) for both, so the DB column
// and dupe-check comparisons are uniform.

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

/**
 * Hash a Buffer (or Uint8Array) using Node's crypto. Server-side path.
 * Synchronous-style implementation, but exposed async to keep call sites
 * uniform with the browser version.
 */
export async function hashBufferInNode(buffer: Buffer | Uint8Array): Promise<Sha256Hex> {
  const { createHash } = await import("node:crypto")
  return createHash("sha256").update(buffer).digest("hex")
}

function bufferToHex(bytes: Uint8Array): string {
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
