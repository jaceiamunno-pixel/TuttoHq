// Client entry point for the PCO import parse. Runs parseWorkbookFile in a
// dedicated Web Worker so a multi-file folder parse never blocks the UI and
// completes even when the desktop tab is backgrounded. Falls back to the
// synchronous main-thread path when a worker can't be constructed (SSR, an
// ancient browser, or a bundler hiccup) so the import always works.

import { parseWorkbookFiles } from "./parse"
import type { ParsedFileResult } from "./types"
import type { ParseWorkerMessage } from "./parse.worker"

export interface ParseProgress {
  done: number
  total: number
  fileName: string
}

export function parseWorkbookFilesAsync(
  files: File[],
  onProgress?: (p: ParseProgress) => void,
): Promise<ParsedFileResult[]> {
  // No worker support (SSR / very old browser) → main thread, same result.
  if (typeof Worker === "undefined") return parseWorkbookFiles(files)

  return new Promise<ParsedFileResult[]>((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" })
    } catch {
      // Couldn't construct the worker — degrade to the main-thread parse.
      parseWorkbookFiles(files).then(resolve, reject)
      return
    }

    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      worker.terminate()
      fn()
    }

    worker.onmessage = (e: MessageEvent<ParseWorkerMessage>) => {
      const msg = e.data
      if (msg.type === "progress") {
        onProgress?.({ done: msg.done, total: msg.total, fileName: msg.fileName })
      } else if (msg.type === "result") {
        finish(() => resolve(msg.results))
      } else if (msg.type === "error") {
        // A worker-level failure loses the in-progress batch — re-parse on the
        // main thread so the user still gets their cards.
        finish(() => parseWorkbookFiles(files).then(resolve, reject))
      }
    }
    worker.onerror = () => {
      // Worker failed to load/run entirely — fall back so the import survives.
      finish(() => parseWorkbookFiles(files).then(resolve, reject))
    }

    worker.postMessage({ files })
  })
}
