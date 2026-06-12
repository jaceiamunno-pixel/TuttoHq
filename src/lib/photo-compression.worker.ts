// Web Worker for daily-report photo compression.
//
// WHY A WORKER: compressFileToUploadablePhoto decodes (createImageBitmap),
// downscales (drawImage) and transcodes HEIC (heic2any WASM). Looped over a
// batch of phone photos on the main thread, the decodes janked the capture UI.
// All three APIs run inside a worker, so the whole pipeline moves off-thread
// and keeps running when a desktop tab is backgrounded.
//
// The exact same compressFileToUploadablePhoto is imported (one source of
// truth). It only takes its document.createElement('canvas') fallback when
// OffscreenCanvas is absent — and the client only routes here when
// OffscreenCanvas IS present, so that branch never executes in the worker.

import { compressFileToUploadablePhoto } from "./photo-compression"
import type { UploadablePhoto } from "./uploadable-photo"

export interface PhotoWorkerRequest {
  id: number
  file: File
}

export type PhotoWorkerMessage =
  | { id: number; ok: true; photo: UploadablePhoto }
  | { id: number; ok: false; error: string }

// lib is ["dom", ...] (no "webworker"); cast to the minimal worker surface to
// avoid the DOM postMessage(message, targetOrigin) signature.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<PhotoWorkerRequest>) => void) | null
  postMessage: (msg: PhotoWorkerMessage) => void
}

ctx.onmessage = async (e) => {
  const { id, file } = e.data
  try {
    const photo = await compressFileToUploadablePhoto(file)
    // photo.bytes is a Blob — structured-cloneable, so a plain postMessage
    // transfers it without a manual ArrayBuffer dance.
    ctx.postMessage({ id, ok: true, photo })
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: (err as Error)?.message ?? "compression failed" })
  }
}
