// Client factory for off-thread photo compression. Returns a small compressor
// backed by a single reusable Web Worker (id-correlated requests, so callers
// can compress a batch through one worker). Degrades to the synchronous
// main-thread pipeline when a worker can't run — and mid-batch if the worker
// crashes — so photo capture never breaks.

import { compressFileToUploadablePhoto } from "./photo-compression"
import type { UploadablePhoto } from "./uploadable-photo"
import type { PhotoWorkerMessage } from "./photo-compression.worker"

export interface PhotoCompressor {
  compress(file: File): Promise<UploadablePhoto>
  /** Terminate the backing worker. Safe to call always (no-op on fallback). */
  dispose(): void
}

// The worker's encode path needs OffscreenCanvas (its document fallback can't
// run off-thread). Only route to the worker when BOTH Worker and OffscreenCanvas
// exist — older Safari lacks OffscreenCanvas, so it uses the main-thread path.
function workerSupported(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined"
}

const mainThreadCompressor: PhotoCompressor = {
  compress: compressFileToUploadablePhoto,
  dispose() {},
}

export function createPhotoCompressor(): PhotoCompressor {
  if (!workerSupported()) return mainThreadCompressor

  let worker: Worker
  try {
    worker = new Worker(new URL("./photo-compression.worker.ts", import.meta.url), { type: "module" })
  } catch {
    return mainThreadCompressor
  }

  let seq = 0
  let dead = false
  const pending = new Map<number, { resolve: (p: UploadablePhoto) => void; reject: (e: Error) => void }>()

  worker.onmessage = (e: MessageEvent<PhotoWorkerMessage>) => {
    const msg = e.data
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.ok) entry.resolve(msg.photo)
    else entry.reject(new Error(msg.error))
  }
  worker.onerror = () => {
    // Fatal worker error — reject everything in flight and mark dead so the
    // rest of the batch runs on the main thread instead of hanging.
    dead = true
    for (const entry of pending.values()) entry.reject(new Error("photo worker crashed"))
    pending.clear()
  }

  return {
    compress(file) {
      if (dead) return compressFileToUploadablePhoto(file)
      return new Promise<UploadablePhoto>((resolve, reject) => {
        const id = seq++
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, file })
      })
    },
    dispose() {
      try { worker.terminate() } catch { /* already gone */ }
    },
  }
}
