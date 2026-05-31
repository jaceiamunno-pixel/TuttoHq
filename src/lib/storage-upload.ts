// Browser-only helper for uploading a file straight to a Supabase Storage
// signed upload URL. The spec-book upload flows use this to bypass Vercel's
// 4.5 MB serverless function body limit — the file never transits an API route.

export interface UploadProgress {
  loaded: number
  total: number
  percent: number // 0–100, integer
}

/**
 * PUTs `file` to a Supabase Storage signed upload URL, reporting progress.
 * Resolves on a 2xx response; rejects with a descriptive Error on an HTTP
 * error, network failure, or abort.
 *
 * Uses XMLHttpRequest rather than fetch() because fetch exposes no
 * upload-progress event — essential UX for large (30+ MB) spec books.
 */
export function uploadFileToSignedUrl(
  signedUrl: string,
  file: File,
  onProgress?: (p: UploadProgress) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", signedUrl, true)
    xhr.setRequestHeader("Content-Type", file.type || "application/pdf")
    // Allow a retry to overwrite a partial object left by an earlier attempt.
    xhr.setRequestHeader("x-upsert", "true")

    xhr.upload.onprogress = (e) => {
      if (!onProgress || !e.lengthComputable) return
      onProgress({
        loaded: e.loaded,
        total: e.total,
        percent: Math.round((e.loaded / e.total) * 100),
      })
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Upload failed (HTTP ${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error("Network error during upload"))
    xhr.onabort = () => reject(new Error("Upload was cancelled"))

    xhr.send(file)
  })
}

/**
 * Requests a signed upload URL from /api/storage/presigned-url, then PUTs `file`
 * straight to Supabase Storage. Resolves with the stored object path, which the
 * caller hands to the feature's own POST route (in place of the raw file).
 *
 * This is the standard way to upload a user file: the bytes never transit a
 * Vercel function, so the 4.5 MB serverless body limit never applies.
 */
export async function presignAndUpload(
  bucket: string,
  prefix: string,
  file: File,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ path: string }> {
  const res = await fetch("/api/storage/presigned-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bucket, prefix, file_name: file.name }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.signed_url || !data?.path) {
    throw new Error(data?.error ?? "Could not start the upload")
  }

  await uploadFileToSignedUrl(data.signed_url, file, onProgress)
  return { path: data.path as string }
}

/**
 * Blob variant used by the offline photo sync runner. Unlike presignAndUpload,
 * this takes an explicit `client_id` (the IDB photo's UUID) so:
 *
 *   - The storage path is deterministic — retries write to the same object,
 *     `upsert: true` makes the PUT idempotent at the bucket level.
 *   - The downstream /api/photos POST uses the same id, so the DB row insert
 *     is naturally dedupe-able if the runner retries after a partial failure.
 *
 * Bytes come from IndexedDB (always a Blob), not from a browser File picker,
 * so this is its own helper — the porting boundary for a native shell that
 * would produce bytes via its camera plugin rather than an HTML file input.
 */
export async function presignAndUploadBlob(
  bucket: string,
  prefix: string,
  blob: Blob,
  fileName: string,
  clientId: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ path: string }> {
  const res = await fetch("/api/storage/presigned-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bucket, prefix, file_name: fileName, client_id: clientId }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.signed_url || !data?.path) {
    throw new Error(data?.error ?? "Could not start the upload")
  }

  // Reuse the same XHR helper. uploadFileToSignedUrl reads from file.type,
  // but a generic Blob may or may not carry a type — fall back to a sane
  // default for the photo path. Wrap as File so the existing helper sets
  // Content-Type from blob.type when present.
  const fileLike = new File([blob], fileName, { type: blob.type || "image/jpeg" })
  await uploadFileToSignedUrl(data.signed_url, fileLike, onProgress)
  return { path: data.path as string }
}
