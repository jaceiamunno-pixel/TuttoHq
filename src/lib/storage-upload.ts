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
