"use client"

import type { TakeoffMatrix } from "../_lib/matrix"

// The live deliverable: tags (grouped by category) × rooms, with a leading TOTAL
// column, per-category subtotal rows and a final grand-total row. Mirrors the
// Excel export exactly (both read computeMatrix). Non-total cells blank at zero;
// total/subtotal/grand cells always show a number.

const cell = "px-2 py-1 text-[12px] text-center tabular-nums border-b border-[#EEF1F4] whitespace-nowrap"
const totalCol = "bg-[#F8FAFC] font-semibold"

export default function TakeoffMatrix({ matrix, onExport, exporting }: {
  matrix: TakeoffMatrix
  onExport: () => void
  exporting?: boolean
}) {
  const { rooms, groups, grandPerRoom, grandTotal } = matrix
  const blank = (n: number) => (n === 0 ? "" : n)

  return (
    <div className="border-t border-[#E2E8F0] pt-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-[#475569]">Matrix</h3>
        <button
          onClick={onExport}
          disabled={exporting || (rooms.length === 0)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#16A34A] text-white text-[11px] font-semibold hover:bg-[#15803d] disabled:opacity-40"
        >
          {exporting ? "Exporting…" : "Export to Excel"}
        </button>
      </div>

      <div className="overflow-x-auto border border-[#E2E8F0] rounded">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[#1A2840] text-white">
              <th className="px-2 py-1.5 text-left text-[11px] font-semibold sticky left-0 bg-[#1A2840] z-10">Tag</th>
              <th className="px-2 py-1.5 text-center text-[11px] font-semibold">TOTAL</th>
              {rooms.map(r => (
                <th key={r.id} className="px-2 py-1.5 text-center text-[11px] font-semibold whitespace-nowrap">{r.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td colSpan={2 + rooms.length} className="px-2 py-3 text-center text-[12px] text-[#94A3B8]">Add categories and tags to build the matrix.</td></tr>
            )}
            {groups.map(group => (
              <GroupRows key={group.id} group={group} roomCount={rooms.length} blank={blank} />
            ))}
            {groups.length > 0 && (
              <tr className="bg-[#DDE6EE] font-bold">
                <td className="px-2 py-1 text-[12px] text-left sticky left-0 bg-[#DDE6EE] z-10">GRAND TOTAL — PER ROOM</td>
                <td className={`${cell} bg-[#cfdbe6]`}>{grandTotal}</td>
                {grandPerRoom.map((n, i) => <td key={i} className={cell}>{n}</td>)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function GroupRows({ group, roomCount, blank }: {
  group: TakeoffMatrix["groups"][number]
  roomCount: number
  blank: (n: number) => number | string
}) {
  return (
    <>
      <tr className="bg-[#EAF0F5]">
        <td colSpan={2 + roomCount} className="px-2 py-1 text-[11px] font-bold text-[#1A2840] sticky left-0 bg-[#EAF0F5]">{group.name}</td>
      </tr>
      {group.rows.map(row => (
        <tr key={row.tag.id} className="hover:bg-[#F8FAFC]">
          <td className="px-2 py-1 text-[12px] text-left sticky left-0 bg-white z-10">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: row.tag.color }} />
              <span className="font-semibold">{row.tag.code}</span>
            </span>
          </td>
          <td className={`${cell} ${totalCol}`}>{row.total}</td>
          {row.perRoom.map((n, i) => <td key={i} className={cell}>{blank(n)}</td>)}
        </tr>
      ))}
      <tr className="bg-[#F1F5F9] font-semibold">
        <td className="px-2 py-1 text-[12px] text-left sticky left-0 bg-[#F1F5F9] z-10">{group.name} — TOTAL</td>
        <td className={`${cell} ${totalCol}`}>{group.subtotalTotal}</td>
        {group.subtotalPerRoom.map((n, i) => <td key={i} className={cell}>{n}</td>)}
      </tr>
    </>
  )
}
