// The unit of currency for a captured photo, decoupled from the browser
// `File` API. The web capture path produces this from an `<input type="file">`
// File via photo-compression.ts; a future native shell (@capacitor/camera or
// a React Native bridge) would produce the same shape from its native camera
// plugin without touching the rest of the pipeline.
//
// Per ADR-003 — keep this layer thin and platform-independent. Anything that
// uploads or persists a captured photo MUST take an UploadablePhoto, never a
// File. Adding browser-only fields here defeats the abstraction.
export interface UploadablePhoto {
  /** Already-compressed JPEG bytes. */
  bytes: Blob
  /** Always "image/jpeg" today — kept as a field so future formats are non-breaking. */
  mime: string
  /** Suggested filename, extension already normalized to .jpg. */
  filename: string
}
