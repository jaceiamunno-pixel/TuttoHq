// Web Worker for the historical-PCO import parse (the 49-file folder case).
//
// WHY A WORKER: parseWorkbookFile is pure CPU — exceljs `wb.xlsx.load` + dense
// grid build + extraction. Run on the main thread (as it was) a dropped folder
// of dozens of .xlsx froze the UI for the whole batch and, on a backgrounded
// desktop tab, the timer-driven UI updates throttled. A dedicated worker keeps
// the main thread free AND keeps running at full speed in a backgrounded tab.
//
// The pure parse logic is imported, NOT duplicated — this worker is only a
// thread boundary around the exact same parseWorkbookFile the sync path uses,
// so there is one source of truth. The workbook bytes stay inside the browser
// (a worker is more contained than the page, never less) — nothing is uploaded.

import { parseWorkbookFile } from "./parse"
import type { ParsedFileResult } from "./types"

export interface ParseWorkerRequest {
  files: File[]
}

export type ParseWorkerMessage =
  | { type: "progress"; done: number; total: number; fileName: string }
  | { type: "result"; results: ParsedFileResult[] }
  | { type: "error"; message: string }

// The lib config is ["dom", ...] (no "webworker"), so `self` is typed as a
// Window here. Cast to the minimal worker surface we use to avoid the DOM
// `postMessage(message, targetOrigin)` signature clashing with the worker's
// `postMessage(message)`.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ParseWorkerRequest>) => void) | null
  postMessage: (msg: ParseWorkerMessage) => void
}

ctx.onmessage = async (e) => {
  const files = e.data?.files ?? []
  const total = files.length
  const results: ParsedFileResult[] = []
  try {
    for (let i = 0; i < total; i++) {
      const file = files[i]
      // parseWorkbookFile never throws — it returns a result carrying a
      // parse_error flag on a bad workbook — so a single corrupt file can't
      // abort the batch. The try/catch below is only a backstop.
      results.push(await parseWorkbookFile(file))
      ctx.postMessage({ type: "progress", done: i + 1, total, fileName: file.name })
    }
    ctx.postMessage({ type: "result", results })
  } catch (err) {
    ctx.postMessage({ type: "error", message: (err as Error)?.message ?? "parse failed" })
  }
}
