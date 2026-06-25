"use client"

import { useEffect, useState } from "react"
import type { Takeoff, TakeoffCategory, TakeoffRoom, TakeoffTag } from "../_lib/types"

// Right-pane controls: takeoff selector + editable Categories / Tags / Rooms lists
// + the active tag/room selectors that a count click is attributed to. All edits
// flow up through callbacks; this component holds only transient input state.

const IconUp = () => <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
const IconDown = () => <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
const IconTrash = () => <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
const IconPlus = () => <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" /></svg>

const iconBtn = "inline-flex items-center justify-center h-6 w-6 rounded text-[#64748B] hover:bg-[#E2E8F0] disabled:opacity-30 transition-colors"
const fieldCls = "min-w-0 flex-1 bg-transparent border-b border-transparent hover:border-[#CBD5E1] focus:border-[#5A7A94] focus:outline-none text-[12px] px-1 py-0.5"

function EditableText({ value, onCommit, allowEmpty, placeholder, className }: {
  value: string
  onCommit: (v: string) => void
  allowEmpty?: boolean
  placeholder?: string
  className?: string
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => {
    const t = v.trim()
    if (t === value) return
    if (!t && !allowEmpty) { setV(value); return }
    onCommit(t)
  }
  return (
    <input
      value={v}
      placeholder={placeholder}
      onChange={e => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") e.currentTarget.blur()
        if (e.key === "Escape") { setV(value); e.currentTarget.blur() }
      }}
      className={className ?? fieldCls}
    />
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="border-t border-[#E2E8F0] pt-3">
      <div className="flex items-center gap-2 mb-1.5">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-[#475569]">{title}</h3>
        {count !== undefined && <span className="text-[10px] text-[#94A3B8]">{count}</span>}
      </div>
      {children}
    </div>
  )
}

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (name: string) => void }) {
  const [v, setV] = useState("")
  const add = () => { const t = v.trim(); if (t) { onAdd(t); setV("") } }
  return (
    <div className="flex items-center gap-1 mt-1">
      <input
        value={v}
        placeholder={placeholder}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") add() }}
        className="flex-1 border border-[#E2E8F0] rounded px-2 py-1 text-[12px] focus:outline-none focus:border-[#5A7A94]"
      />
      <button onClick={add} disabled={!v.trim()} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#5A7A94] text-white text-[11px] font-semibold disabled:opacity-40">
        <IconPlus /> Add
      </button>
    </div>
  )
}

export default function TakeoffControls({
  takeoffs, selectedTakeoffId, onSelectTakeoff, onCreateTakeoff, onDeleteTakeoff,
  categories, rooms, tags,
  activeTagId, activeRoomId, setActiveTagId, setActiveRoomId,
  onAddCategory, onRenameCategory, onRemoveCategory, onMoveCategory,
  onAddRoom, onRenameRoom, onRemoveRoom, onMoveRoom,
  onAddTag, onUpdateTag, onRemoveTag, onMoveTag,
  busy,
}: {
  takeoffs: Takeoff[]
  selectedTakeoffId: string | null
  onSelectTakeoff: (id: string) => void
  onCreateTakeoff: (name: string) => void
  onDeleteTakeoff: (id: string) => void
  categories: TakeoffCategory[]
  rooms: TakeoffRoom[]
  tags: TakeoffTag[]
  activeTagId: string | null
  activeRoomId: string | null
  setActiveTagId: (id: string) => void
  setActiveRoomId: (id: string) => void
  onAddCategory: (name: string) => void
  onRenameCategory: (id: string, name: string) => void
  onRemoveCategory: (id: string) => void
  onMoveCategory: (id: string, dir: -1 | 1) => void
  onAddRoom: (name: string) => void
  onRenameRoom: (id: string, name: string) => void
  onRemoveRoom: (id: string) => void
  onMoveRoom: (id: string, dir: -1 | 1) => void
  onAddTag: () => void
  onUpdateTag: (id: string, patch: { code?: string; description?: string | null; category_id?: string | null }) => void
  onRemoveTag: (id: string) => void
  onMoveTag: (id: string, dir: -1 | 1) => void
  busy?: boolean
}) {
  const [newTakeoff, setNewTakeoff] = useState("")
  const [creating, setCreating] = useState(false)

  return (
    <div className="space-y-4">
      {/* ── Takeoff selector ─────────────────────────────────────────── */}
      <div>
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-[#475569] mb-1.5">Takeoff</h3>
        {takeoffs.length > 0 && (
          <div className="flex items-center gap-1.5">
            <select
              value={selectedTakeoffId ?? ""}
              onChange={e => onSelectTakeoff(e.target.value)}
              className="flex-1 border border-[#E2E8F0] rounded px-2 py-1.5 text-[13px] font-medium focus:outline-none focus:border-[#5A7A94]"
            >
              {takeoffs.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {selectedTakeoffId && (
              <button
                onClick={() => { if (confirm("Delete this takeoff and all its tags, rooms and counts?")) onDeleteTakeoff(selectedTakeoffId) }}
                className={iconBtn} title="Delete takeoff"
              ><IconTrash /></button>
            )}
          </div>
        )}
        {creating ? (
          <div className="flex items-center gap-1 mt-1.5">
            <input
              autoFocus value={newTakeoff} placeholder="e.g. Base Bid"
              onChange={e => setNewTakeoff(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && newTakeoff.trim()) { onCreateTakeoff(newTakeoff.trim()); setNewTakeoff(""); setCreating(false) } if (e.key === "Escape") setCreating(false) }}
              className="flex-1 border border-[#E2E8F0] rounded px-2 py-1 text-[12px] focus:outline-none focus:border-[#5A7A94]"
            />
            <button onClick={() => { if (newTakeoff.trim()) { onCreateTakeoff(newTakeoff.trim()); setNewTakeoff(""); setCreating(false) } }}
              className="px-2 py-1 rounded bg-[#5A7A94] text-white text-[11px] font-semibold">Create</button>
            <button onClick={() => setCreating(false)} className="px-2 py-1 rounded text-[#64748B] text-[11px]">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setCreating(true)} className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-semibold text-[#5A7A94] hover:text-[#3d5a72]">
            <IconPlus /> New takeoff
          </button>
        )}
      </div>

      {!selectedTakeoffId ? null : (
        <>
          {/* ── Categories ─────────────────────────────────────────────── */}
          <Section title="Categories" count={categories.length}>
            <ul className="space-y-0.5">
              {categories.map((c, i) => (
                <li key={c.id} className="flex items-center gap-0.5 group">
                  <EditableText value={c.name} onCommit={v => onRenameCategory(c.id, v)} />
                  <button className={iconBtn} disabled={i === 0} onClick={() => onMoveCategory(c.id, -1)} title="Move up"><IconUp /></button>
                  <button className={iconBtn} disabled={i === categories.length - 1} onClick={() => onMoveCategory(c.id, 1)} title="Move down"><IconDown /></button>
                  <button className={iconBtn} onClick={() => onRemoveCategory(c.id)} title="Remove"><IconTrash /></button>
                </li>
              ))}
            </ul>
            <AddRow placeholder="Add category" onAdd={onAddCategory} />
          </Section>

          {/* ── Tags ───────────────────────────────────────────────────── */}
          <Section title="Tags" count={tags.length}>
            {tags.length === 0 && <p className="text-[11px] text-[#94A3B8] mb-1">No tags yet — add one, then click the sheet to count.</p>}
            <ul className="space-y-1">
              {tags.map((t, i) => {
                const active = t.id === activeTagId
                return (
                  <li key={t.id} className={`flex items-center gap-1 rounded px-1 py-0.5 ${active ? "bg-[#5A7A94]/10 ring-1 ring-[#5A7A94]" : ""}`}>
                    <button
                      onClick={() => setActiveTagId(t.id)}
                      title={active ? "Active tag" : "Set active tag"}
                      className={`h-4 w-4 rounded-full flex-shrink-0 ${active ? "ring-2 ring-offset-1 ring-[#3d5a72]" : "ring-1 ring-white"}`}
                      style={{ backgroundColor: t.color }}
                    />
                    <EditableText value={t.code} onCommit={v => onUpdateTag(t.id, { code: v })} className="w-14 bg-transparent border-b border-transparent hover:border-[#CBD5E1] focus:border-[#5A7A94] focus:outline-none text-[12px] font-semibold px-0.5 py-0.5" />
                    <EditableText value={t.description ?? ""} allowEmpty placeholder="description" onCommit={v => onUpdateTag(t.id, { description: v || null })} />
                    <select
                      value={t.category_id ?? ""}
                      onChange={e => onUpdateTag(t.id, { category_id: e.target.value || null })}
                      className="w-20 text-[11px] border border-[#E2E8F0] rounded px-0.5 py-0.5 focus:outline-none focus:border-[#5A7A94]"
                      title="Category"
                    >
                      <option value="">—</option>
                      {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button className={iconBtn} disabled={i === 0} onClick={() => onMoveTag(t.id, -1)} title="Move up"><IconUp /></button>
                    <button className={iconBtn} disabled={i === tags.length - 1} onClick={() => onMoveTag(t.id, 1)} title="Move down"><IconDown /></button>
                    <button className={iconBtn} onClick={() => onRemoveTag(t.id)} title="Remove tag"><IconTrash /></button>
                  </li>
                )
              })}
            </ul>
            <button onClick={onAddTag} disabled={busy} className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded border border-[#5A7A94] text-[#5A7A94] text-[11px] font-semibold hover:bg-[#5A7A94]/5 disabled:opacity-40">
              <IconPlus /> Add tag
            </button>
          </Section>

          {/* ── Rooms ──────────────────────────────────────────────────── */}
          <Section title="Rooms" count={rooms.length}>
            <ul className="space-y-0.5">
              {rooms.map((rm, i) => {
                const active = rm.id === activeRoomId
                return (
                  <li key={rm.id} className={`flex items-center gap-0.5 rounded px-1 ${active ? "bg-[#5A7A94]/10 ring-1 ring-[#5A7A94]" : ""}`}>
                    <button
                      onClick={() => setActiveRoomId(rm.id)}
                      title={active ? "Active room" : "Set active room"}
                      className={`h-3.5 w-3.5 rounded-full flex-shrink-0 border ${active ? "bg-[#3d5a72] border-[#3d5a72]" : "border-[#94A3B8]"}`}
                    />
                    <EditableText value={rm.name} onCommit={v => onRenameRoom(rm.id, v)} />
                    <button className={iconBtn} disabled={i === 0} onClick={() => onMoveRoom(rm.id, -1)} title="Move up"><IconUp /></button>
                    <button className={iconBtn} disabled={i === rooms.length - 1} onClick={() => onMoveRoom(rm.id, 1)} title="Move down"><IconDown /></button>
                    <button className={iconBtn} onClick={() => onRemoveRoom(rm.id)} title="Remove"><IconTrash /></button>
                  </li>
                )
              })}
            </ul>
            <AddRow placeholder="Add room" onAdd={onAddRoom} />
          </Section>
        </>
      )}
    </div>
  )
}
