"use client"

import { FIELD_MODULES, FIELD_MODULE_LABELS, type FieldGrant, type FieldModule } from "@/lib/field-access-shared"

// ADR-020 — the per-project × per-module grants grid for field users. Shared
// between the invite form (Settings → Team → Invite, role=Field) and the
// per-member "Manage access" editor. Controlled component: `value` is the
// grant list, cells toggle view/edit per (project, module). Edit implies view:
// a grant row's presence = view; can_edit=true = edit. Checking Edit forces
// the row present; unchecking View drops the row (and with it Edit).
export default function FieldAccessGrid({ projects, value, onChange, disabled }: {
  projects: { id: string; name: string; number?: string | null }[]
  value: FieldGrant[]
  onChange: (next: FieldGrant[]) => void
  disabled?: boolean
}) {
  const byKey = new Map(value.map(g => [`${g.project_id}:${g.module}`, g]))

  function setCell(project_id: string, module: FieldModule, view: boolean, edit: boolean) {
    const key = `${project_id}:${module}`
    const next = value.filter(g => `${g.project_id}:${g.module}` !== key)
    if (edit) next.push({ project_id, module, can_edit: true })
    else if (view) next.push({ project_id, module, can_edit: false })
    onChange(next)
  }

  if (projects.length === 0) {
    return <p className="text-[12px] text-[#64748B]">No projects yet — create a project before inviting field users.</p>
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-[#E2E8F0] bg-white">
      <table className="w-full text-[12px]">
        <thead className="text-[11px] uppercase tracking-wider text-[#64748B] border-b border-[#E2E8F0] bg-[#F8FAFC]">
          <tr>
            <th className="text-left py-2 px-3 font-semibold">Project</th>
            {FIELD_MODULES.map(m => (
              <th key={m} className="text-center py-2 px-2 font-semibold whitespace-nowrap">{FIELD_MODULE_LABELS[m]}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#E2E8F0]">
          {projects.map(p => (
            <tr key={p.id}>
              <td className="py-2 px-3 text-[#0F172A] whitespace-nowrap">
                {p.name}{p.number ? <span className="text-[#94A3B8]"> — {p.number}</span> : null}
              </td>
              {FIELD_MODULES.map(m => {
                const g = byKey.get(`${p.id}:${m}`)
                const view = !!g
                const edit = g?.can_edit === true
                return (
                  <td key={m} className="py-2 px-2 text-center whitespace-nowrap">
                    <label className="inline-flex items-center gap-1 mr-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={view}
                        disabled={disabled}
                        onChange={e => setCell(p.id, m, e.target.checked, e.target.checked ? edit : false)}
                        className="h-3.5 w-3.5 accent-[#7B9BB5]"
                      />
                      <span className="text-[#64748B]">view</span>
                    </label>
                    <label className="inline-flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={edit}
                        disabled={disabled}
                        onChange={e => setCell(p.id, m, e.target.checked ? true : view, e.target.checked)}
                        className="h-3.5 w-3.5 accent-[#7B9BB5]"
                      />
                      <span className="text-[#64748B]">edit</span>
                    </label>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
