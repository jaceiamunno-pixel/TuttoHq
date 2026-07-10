"use client"

import { useState } from "react"
import { downloadFilesAsZip } from "@/lib/zip"

// Delivery UI for one generation of a transmittal package.
//   'package'  → one PDF: inline preview (optional) + a Download button.
//   'per_item' → N PDFs: one Download per item + a single "Download all" that
//                bundles them client-side into a .zip (browsers block firing N
//                downloads from one click).
// Shared by the create modal and the package detail's "Past generations" list.

export interface GenFile {
  submittalId: string | null
  fileName: string
  url: string | null
  label: string
}

export default function GenerationFiles({
  packageNumber, coversheetMode, files, preview = false, zipBaseName,
}: {
  packageNumber: string
  coversheetMode: "per_item" | "package"
  files: GenFile[]
  /** Show an inline iframe for the single 'package' PDF. */
  preview?: boolean
  /** Human-readable base name for the "Download all" zip (no extension). Falls
   *  back to the tracking-ref packageNumber when not supplied. */
  zipBaseName?: string
}) {
  const [zipping, setZipping] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const open = (url: string | null) => { if (url) window.open(url, "_blank") }

  async function downloadAll() {
    const ready = files.filter(f => f.url).map(f => ({ name: f.fileName, url: f.url! }))
    if (ready.length === 0) return
    setZipping(true); setErr(null)
    try {
      await downloadFilesAsZip(ready, `${zipBaseName || packageNumber}.zip`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not build the zip")
    } finally { setZipping(false) }
  }

  if (coversheetMode === "package") {
    const file = files[0]
    return (
      <div className="space-y-2">
        {preview && file?.url && (
          <iframe src={file.url} title="Package PDF" className="w-full rounded-lg border border-[#E2E8F0]" style={{ height: 440 }} />
        )}
        <button
          onClick={() => open(file?.url ?? null)}
          disabled={!file?.url}
          className="h-9 px-4 rounded-md bg-emerald-600 text-white text-[13px] font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50">
          Download package PDF
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-[#E2E8F0] overflow-clip divide-y divide-[#E2E8F0]/70">
        {files.map((f, i) => (
          <div key={`${f.submittalId ?? "pkg"}-${i}`} className="flex items-center gap-2 px-3 py-2">
            <span className="flex-1 min-w-0 text-[13px] text-[#0F172A] truncate" title={f.label}>{f.label}</span>
            <button
              onClick={() => open(f.url)}
              disabled={!f.url}
              className="text-[12px] font-semibold text-[#7B9BB5] hover:text-[#5A7A94] px-2 py-1 rounded hover:bg-[#F8F9FA] transition-colors disabled:opacity-40">
              Download
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={downloadAll}
          disabled={zipping || files.every(f => !f.url)}
          className="h-9 px-4 rounded-md bg-emerald-600 text-white text-[13px] font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50">
          {zipping ? "Zipping…" : `Download all (${files.length})`}
        </button>
        {err && <span className="text-[12px] text-red-600">{err}</span>}
      </div>
    </div>
  )
}
