"use client"

import { useEffect, useState } from "react"

// TEMPORARY native-debug overlay (native shell tree). Registers global
// window.onerror + unhandledrejection handlers and paints whatever they catch
// into a fixed on-screen <pre> — for async rejections that never reach a React
// boundary. Dependency-free. Mounted in native/app/layout.tsx so it is live
// before the shell page's mount effect runs. REMOVE after diagnosing.
export default function DiagErrorOverlay() {
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    const push = (label: string, msg: string, stack?: string) =>
      setErrors((prev) => [...prev, `[${label}] ${msg}\n${stack ?? "(no stack)"}`])

    const prevOnError = window.onerror
    window.onerror = (message, source, lineno, colno, error) => {
      push("onerror", `${String(message)} @ ${source ?? "?"}:${lineno ?? "?"}:${colno ?? "?"}`, error?.stack)
      return false // don't suppress default logging
    }

    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason
      push(
        "unhandledrejection",
        r instanceof Error ? r.message : String(r),
        r instanceof Error ? r.stack : undefined,
      )
    }
    window.addEventListener("unhandledrejection", onRejection)

    return () => {
      window.onerror = prevOnError
      window.removeEventListener("unhandledrejection", onRejection)
    }
  }, [])

  if (errors.length === 0) return null

  return (
    <pre
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: "55vh",
        overflow: "auto",
        margin: 0,
        padding: 12,
        background: "#1a0000",
        color: "#ff6b6b",
        font: "12px/1.4 monospace",
        whiteSpace: "pre-wrap",
        zIndex: 2147483647,
        borderTop: "2px solid #b00",
      }}
    >
      <b>Diagnostic — uncaught errors ({errors.length}):</b>
      {"\n\n"}
      {errors.join("\n\n———\n\n")}
    </pre>
  )
}
