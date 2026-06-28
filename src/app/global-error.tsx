"use client"
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }, reset: () => void }) {
  return (
    <html><body style={{ padding: 16, font: "13px monospace", whiteSpace: "pre-wrap", color: "#b00" }}>
      <h2>Runtime error (diagnostic)</h2>
      <div><b>message:</b> {String(error?.message)}</div>
      <div><b>name:</b> {String(error?.name)}</div>
      <div><b>stack:</b>{"\n"}{String(error?.stack)}</div>
      <div><b>digest:</b> {String(error?.digest)}</div>
      <button onClick={() => reset()} style={{ marginTop: 12 }}>retry</button>
    </body></html>
  )
}
