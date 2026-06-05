// Sanity check for the narrowed Stage 2a commitReadiness predicate.
// Inlines the function (mirror src/components/bulk-import/BulkImportModal.tsx)
// and enumerates the per-condition truth table so the user-stated cases all
// resolve as expected: "ready" when placement-critical fields are set,
// "blocked" otherwise. Metadata fields (sub#, approval date, cover split,
// review status) must not affect the outcome.

function commitReadiness(r) {
  if (r.status === "committed" || r.committedRowId) return "done"
  if (r.status === "committing") return "in-flight"
  if (r.matchSkip) return "skip"
  if (r.status !== "ready") return "blocked"
  if (!String(r.section ?? "").trim() || !r.type) return "blocked"
  if (!r.match) return "blocked"
  if (r.match.kind === "no-match")
    return r.pickedTargetRowId ? "ready" : "blocked"
  if (r.match.kind === "ambiguous-distinct")
    return r.pickedTargetRowId ? "ready" : "blocked"
  if (r.match.kind === "auto-match") return "ready"
  return "blocked"
}

function baseRow() {
  return {
    status: "ready",
    section: "09 31 00",
    type: "Sample",
    approvalDate: "2026-01-15",
    submittalNo: "079",
    coverSplit: 2,
    reviewStatus: "Approved",
    matchSkip: false,
    pickedTargetRowId: null,
    committedRowId: undefined,
    match: { kind: "auto-match", targetRowId: "abc", target: {} },
  }
}

const cases = [
  // ── Should be READY ────────────────────────────────────────────────────
  { name: "baseline auto-match — all set",                            row: { ...baseRow() }, expect: "ready" },
  { name: "auto-match, sub# empty (METADATA — should not block)",     row: { ...baseRow(), submittalNo: "" }, expect: "ready" },
  { name: "auto-match, sub# malformed '30-R' (METADATA)",             row: { ...baseRow(), submittalNo: "30-R" }, expect: "ready" },
  { name: "auto-match, approval date empty (METADATA per spec)",      row: { ...baseRow(), approvalDate: "" }, expect: "ready" },
  { name: "auto-match, coverSplit 0",                                  row: { ...baseRow(), coverSplit: 0 }, expect: "ready" },
  { name: "auto-match, reviewStatus 'Rejected'",                       row: { ...baseRow(), reviewStatus: "Rejected" }, expect: "ready" },
  { name: "no-match + user picked a fallback row",                     row: { ...baseRow(), match: { kind: "no-match", reason: "no-spec-row-for-section-type" }, pickedTargetRowId: "rerouted-id" }, expect: "ready" },
  { name: "ambiguous-distinct + user confirmed pick",                  row: { ...baseRow(), match: { kind: "ambiguous-distinct", candidates: [], defaultRowId: "x" }, pickedTargetRowId: "x" }, expect: "ready" },

  // ── Should be BLOCKED (placement-critical missing) ─────────────────────
  { name: "blocked — section empty",                                   row: { ...baseRow(), section: "" }, expect: "blocked" },
  { name: "blocked — section just whitespace",                         row: { ...baseRow(), section: "   " }, expect: "blocked" },
  { name: "blocked — type empty",                                      row: { ...baseRow(), type: "" }, expect: "blocked" },
  { name: "blocked — match is undefined (the bug case — race)",        row: { ...baseRow(), match: undefined }, expect: "blocked" },
  { name: "blocked — no-match without pick",                           row: { ...baseRow(), match: { kind: "no-match", reason: "no-spec-row-for-section-type" }, pickedTargetRowId: null }, expect: "blocked" },
  { name: "blocked — ambiguous without pick",                          row: { ...baseRow(), match: { kind: "ambiguous-distinct", candidates: [], defaultRowId: "x" }, pickedTargetRowId: null }, expect: "blocked" },
  { name: "blocked — match errored",                                   row: { ...baseRow(), match: { kind: "error", message: "x" } }, expect: "blocked" },
  { name: "blocked — status not ready (still matching)",               row: { ...baseRow(), status: "matching" }, expect: "blocked" },
  { name: "blocked — status not ready (analyzing)",                    row: { ...baseRow(), status: "analyzing" }, expect: "blocked" },
  { name: "blocked — status error",                                    row: { ...baseRow(), status: "error" }, expect: "blocked" },

  // ── Other terminal states ──────────────────────────────────────────────
  { name: "done — already committed",                                  row: { ...baseRow(), status: "committed", committedRowId: "x" }, expect: "done" },
  { name: "in-flight — committing now",                                row: { ...baseRow(), status: "committing" }, expect: "in-flight" },
  { name: "skip — user marked no-match skip",                          row: { ...baseRow(), matchSkip: true }, expect: "skip" },
]

let pass = 0, fail = 0
for (const c of cases) {
  const actual = commitReadiness(c.row)
  const ok = actual === c.expect
  if (ok) pass++; else fail++
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + c.name.padEnd(64) + "  expect=" + c.expect + "  actual=" + actual)
}
console.log("\n" + (fail === 0 ? "ALL PASS" : fail + " FAILED") + " (" + pass + "/" + cases.length + ")")
process.exit(fail === 0 ? 0 : 1)
