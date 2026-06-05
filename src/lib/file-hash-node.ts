// SHA-256 of file bytes — SERVER-ONLY (Node crypto).
//
// DO NOT import this module from a client ("use client") component. It
// pulls in `node:crypto`, which webpack cannot bundle for the browser
// (the "You may need an additional plugin to handle node: URIs" build
// error). The only legitimate importer is a Next.js API route / server
// module. The browser path lives in ./file-hash (Web Crypto, isomorphic).
//
// There is no `import "server-only"` guard here only because that
// package isn't installed in this project; the separation is enforced
// by convention + the import graph (this file is imported solely by
// src/app/api/bulk-import/analyze/route.ts).

import { createHash } from "node:crypto"
import type { Sha256Hex } from "./file-hash"

/**
 * Hash a Buffer (or Uint8Array) using Node's crypto. Used by the
 * bulk-import /analyze route, which already holds the staged PDF buffer
 * in memory for text extraction — adding a hash pass is ~50 ms even on
 * a 30-page PDF.
 */
export async function hashBufferInNode(buffer: Buffer | Uint8Array): Promise<Sha256Hex> {
  return createHash("sha256").update(buffer).digest("hex")
}
