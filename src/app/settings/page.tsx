"use client"

import { useState, useEffect, useRef, Fragment } from "react"
import Link from "next/link"
import Papa from "papaparse"
import { createClient } from "@/lib/supabase/client"
import { DivisionChecklist, SectionAccordion, isDefaultInScopeDivision } from "@/components/scope-selection"
import { CSI_DIVISIONS } from "@/app/dashboard/_shared/csi"
import ProjectSpecBooks from "@/components/project-spec-books"
import { useNavRegion } from "@/components/keyboard-nav"
import LaborRatesTab from "@/components/labor-rates-tab"
import BidDefaultsTab from "@/components/bid-defaults-tab"
import GcTemplateTab from "@/components/gc-template-tab"
import ProfileSignature from "@/components/profile-signature"
import ProfilePoNumbering from "@/components/profile-po-numbering"
import CompanyDetailsCard from "@/components/company-details-card"
import VendorsDirectory from "@/components/vendors-directory"
import FieldAccessGrid from "@/components/field-access-grid"
import type { FieldGrant } from "@/lib/field-access-shared"
import type { TocEntry, TocDivision, ScopeDiagnosis } from "@/lib/scope-types"
import { uploadFileToSignedUrl, presignAndUpload } from "@/lib/storage-upload"
import {
  formatCadence,
  parseCadenceInput,
  validateCompanyDefaultsBody,
  MAX_CADENCE_DAY,
  MAX_REMINDER_COUNT,
} from "@/lib/reminder-settings"
import { LOGO_SCALE_MIN, LOGO_SCALE_MAX, LOGO_SCALE_DEFAULT, clampLogoScalePct } from "@/lib/logo-scale"
import {
  DEFAULT_TRANSMITTAL_EMAIL_SUBJECT,
  DEFAULT_TRANSMITTAL_EMAIL_BODY,
  TRANSMITTAL_MERGE_FIELDS,
} from "@/lib/transmittal-email"

// Live logo-size preview geometry (mirrors the PDF header so the on-screen
// approximation matches generated output): the submittal coversheet's 42pt base
// height, the 526pt content width, drawn into a 460px-wide mock header.
const LOGO_PREVIEW_BASE_MAXH = 42
const LOGO_PREVIEW_PX_PER_PT = 460 / 526

// Settings is organized into 5 left-rail sections (ADR-006: 11 flat tabs → 5
// grouped sections). Each "View" is a leaf page under a section; single-page
// sections (Account, Integrations) have one leaf. The Directories section's
// three former entity tabs (subs/suppliers/cms) collapse into ONE panel
// switched by `DirEntity`.
// "people-team" = the multi-user accounts surface; "people-contacts" = the
// legacy team_members directory (cover-sheet reviewers).
type SectionId = "account" | "company" | "people" | "directories" | "integrations"
type View =
  | "account"
  | "company-identity" | "company-labor" | "company-reminders" | "company-cover"
  | "company-bid-defaults" | "company-gc-template"
  | "people-team" | "people-contacts"
  | "dir-companies" | "dir-projects"
  | "gmail"
// The former "subcontractors" + "suppliers" entities are merged into one
// "vendors" entity (unified vendors master). CMs remain a separate directory.
type DirEntity = "vendors" | "cms"

function sectionOfView(v: View): SectionId {
  if (v.startsWith("company-")) return "company"
  if (v.startsWith("people-")) return "people"
  if (v.startsWith("dir-")) return "directories"
  if (v === "gmail") return "integrations"
  return "account"
}

// Left-rail structure. A section header navigates to its `defaultView`; sub
// links (when present) render beneath the active section.
const SETTINGS_NAV: { id: SectionId; label: string; defaultView: View; subs: { view: View; label: string }[] }[] = [
  { id: "account", label: "Account", defaultView: "account", subs: [] },
  { id: "company", label: "Company", defaultView: "company-identity", subs: [
    { view: "company-identity",  label: "Identity" },
    { view: "company-labor",     label: "Labor Rates" },
    { view: "company-bid-defaults", label: "Bid Defaults" },
    { view: "company-gc-template",  label: "GC Template" },
    { view: "company-reminders", label: "Reminders" },
    { view: "company-cover",     label: "Cover Page" },
  ] },
  { id: "people", label: "People & Access", defaultView: "people-team", subs: [
    { view: "people-team",     label: "Team" },
    { view: "people-contacts", label: "Contacts" },
  ] },
  { id: "directories", label: "Directories", defaultView: "dir-companies", subs: [
    { view: "dir-companies", label: "Companies" },
    { view: "dir-projects",  label: "Projects" },
  ] },
  { id: "integrations", label: "Integrations", defaultView: "gmail", subs: [] },
]

// Old ?tab= deep-link keys → new view (+ directory entity) so existing links
// from the dashboard and the OAuth redirect keep resolving.
const TAB_TO_VIEW: Record<string, { view: View; entity?: DirEntity }> = {
  company:        { view: "company-identity" },
  labor:          { view: "company-labor" },
  profile:        { view: "account" },
  team:           { view: "people-team" },
  contacts:       { view: "people-contacts" },
  projects:       { view: "dir-projects" },
  vendors:        { view: "dir-companies", entity: "vendors" },
  // Legacy deep-links now resolve to the unified Vendors directory.
  subcontractors: { view: "dir-companies", entity: "vendors" },
  suppliers:      { view: "dir-companies", entity: "vendors" },
  cms:            { view: "dir-companies", entity: "cms" },
  gmail:          { view: "gmail" },
}

const inputCls = "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 placeholder:text-[#64748B] transition-all"
const labelCls = "block text-[12px] font-medium text-[#64748B] mb-1"

interface AccountMember {
  user_id:   string
  email:     string | null
  full_name: string | null
  role:      "admin" | "member" | "field"
  joined_at: string
  is_self:   boolean
}
interface PendingInvite {
  id:         string
  email:      string
  role:       "admin" | "member" | "field"
  expires_at: string
  created_at: string
  invite_url: string
}
interface InviteResult {
  email:      string
  invite_url: string
  gmail_sent: boolean
}

interface Toc { sections: TocEntry[]; divisions: TocDivision[] }

/**
 * Merges the tables of contents of every spec book volume on a project into one
 * section list (deduped by spec number) with recomputed division counts. A
 * project routinely carries 2–4 volumes, each with its own TOC.
 */
function mergeTocs(tocs: Toc[]): Toc {
  const sectionByNumber = new Map<string, TocEntry>()
  const nameByCode = new Map<string, string>()
  for (const t of tocs) {
    for (const d of t.divisions) if (!nameByCode.has(d.code)) nameByCode.set(d.code, d.name)
    for (const s of t.sections) if (!sectionByNumber.has(s.specNumber)) sectionByNumber.set(s.specNumber, s)
  }
  const sections = [...sectionByNumber.values()].sort((a, b) => a.specNumber.localeCompare(b.specNumber))
  const counts = new Map<string, number>()
  for (const s of sections) counts.set(s.divisionCode, (counts.get(s.divisionCode) ?? 0) + 1)
  const divisions: TocDivision[] = [...counts.entries()]
    .map(([code, sectionCount]) => ({ code, name: nameByCode.get(code) ?? `Division ${code}`, sectionCount }))
    .sort((a, b) => a.code.localeCompare(b.code))
  return { sections, divisions }
}

/**
 * Builds a Toc from a spec book's ALREADY-PARSED spec_sections — the
 * authoritative post-parse list (every division incl. 00–04, correct titles,
 * no TOC annotation suffixes). Used for the post-parse scope picker instead of
 * re-parsing the table of contents, whose front-matter density gap can drop
 * the early divisions. Division names come from the CSI table (same as the
 * saved-scope reconstruction).
 */
function tocFromSpecSections(rows: { spec_number: string; spec_title: string }[]): Toc {
  const sections: TocEntry[] = rows
    .map(s => ({ specNumber: s.spec_number, specTitle: s.spec_title, divisionCode: s.spec_number.slice(0, 2) }))
    .sort((a, b) => a.specNumber.localeCompare(b.specNumber))
  const counts = new Map<string, number>()
  for (const s of sections) counts.set(s.divisionCode, (counts.get(s.divisionCode) ?? 0) + 1)
  const divisions: TocDivision[] = [...counts.entries()]
    .map(([code, sectionCount]) => ({
      code,
      name: CSI_DIVISIONS.find(dv => dv.num === code)?.name ?? `Division ${code}`,
      sectionCount,
    }))
    .sort((a, b) => a.code.localeCompare(b.code))
  return { sections, divisions }
}

interface ConstructionManager {
  id: string; company_name: string; contact_name: string | null
  phone: string | null; email: string | null; address: string | null; notes: string | null; created_at: string
}

interface Subcontractor {
  id: string; company_name: string; trade: string | null; contact_name: string | null
  phone: string | null; email: string | null; license_number: string | null; notes: string | null; created_at: string
}
interface Supplier {
  id: string; company_name: string; specialty: string | null; contact_name: string | null
  phone: string | null; email: string | null; website: string | null; notes: string | null; created_at: string
}

interface GmailConnection {
  connected: boolean
  gmail_address?: string
  watch_expiry?: string
  created_at?: string
}

interface TeamMember {
  id: string
  name: string
  title: string | null
  email: string | null
  created_at: string
}

interface Project {
  id: string
  name: string
  number: string | null
  location: string | null
  gc_name: string | null
  architect: string | null
  cm_name: string | null
  created_at: string
  created_by: string | null
}

interface TeamImportRow {
  name: string
  title: string
  email: string
}

interface ProjectImportRow {
  name: string
  number: string
  location: string
  gc_name: string
  architect: string
}

function XIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M9 13l6.5-6.5a2.121 2.121 0 013 3L12 16H9v-3z" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  )
}

interface DirField {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  required?: boolean
  autoFocus?: boolean
  fullWidth?: boolean
}

/**
 * Generic directory CRUD panel (ADR-006 "Directories dedup"). One component for
 * the three flat global directories — subcontractors, suppliers, construction
 * managers — that used to be three near-identical CRUD tabs. Each entity
 * supplies its own fields, columns, and the page's EXISTING handlers/state; this
 * component only unifies the header + add/edit form + list rendering. It owns no
 * data layer — every fetch/mutation still runs through the same handlers and API
 * routes as before.
 */
function DirectoryPanel<T extends { id: string }>({
  title, subtitle, addLabel, formTitle, emptyText,
  rows, loading, showForm, editing, saving, canSubmit,
  fields, columns, message, switcher,
  onAdd, onCancel, onSubmit, onEdit, onDelete,
}: {
  title: string
  subtitle: string
  addLabel: string
  formTitle: string
  emptyText: string
  rows: T[]
  loading: boolean
  showForm: boolean
  editing: boolean
  saving: boolean
  canSubmit: boolean
  fields: DirField[]
  columns: { header: string; render: (row: T) => React.ReactNode }[]
  message: { text: string; ok: boolean } | null
  switcher: React.ReactNode
  onAdd: () => void
  onCancel: () => void
  onSubmit: (e: React.FormEvent) => void
  onEdit: (row: T) => void
  onDelete: (row: T) => void
}) {
  return (
    <div className="space-y-4">
      {switcher}
      {message && <div className={`px-4 py-2.5 rounded-lg text-[13px] ${message.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>{message.text}</div>}
      <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E2E8F0]">
          <div>
            <h2 className="text-[14px] font-semibold text-[#0F172A]">{title}</h2>
            <p className="text-[12px] text-[#64748B] mt-0.5">{subtitle}</p>
          </div>
          {!showForm && <button onClick={onAdd} className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[13px] font-medium hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5"><PlusIcon /> {addLabel}</button>}
        </div>

        {showForm && (
          <div className="px-5 py-4 border-b border-[#E2E8F0] bg-[#F4F5F7]/50">
            <p className="text-[13px] font-semibold text-[#0F172A] mb-3">{formTitle}</p>
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {fields.map((f, i) => (
                  <div key={i} className={f.fullWidth ? "sm:col-span-2" : ""}>
                    <label className={labelCls}>{f.label}{f.required && <span className="text-red-400"> *</span>}</label>
                    <input
                      value={f.value}
                      onChange={e => f.onChange(e.target.value)}
                      required={f.required}
                      autoFocus={f.autoFocus}
                      placeholder={f.placeholder}
                      className={inputCls}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={onCancel} className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] transition-colors">Cancel</button>
                <button type="submit" disabled={saving || !canSubmit} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">{saving ? "Saving…" : editing ? "Save changes" : addLabel}</button>
              </div>
            </form>
          </div>
        )}

        {loading && <div className="px-5 py-4 text-[13px] text-[#64748B]">Loading…</div>}
        {!loading && rows.length === 0 && !showForm && (
          <div className="px-5 py-8 text-center"><p className="text-[13px] text-[#64748B]">{emptyText}</p></div>
        )}
        {!loading && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-[#F8F9FA]">
                <tr className="border-b border-[#E2E8F0]">
                  {columns.map(c => <th key={c.header} className="text-left px-4 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider whitespace-nowrap">{c.header}</th>)}
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.id} className={`${i < rows.length - 1 ? "border-b border-[#E2E8F0]" : ""} hover:bg-[#F8F9FA] transition-colors group`}>
                    {columns.map((c, ci) => (
                      <td key={c.header} className={ci === 0 ? "px-4 py-2.5 text-[13px] font-medium text-[#0F172A]" : "px-4 py-2.5 text-[12px] text-[#64748B]"}>{c.render(row)}</td>
                    ))}
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button onClick={() => onEdit(row)} className="p-1 rounded text-[#64748B] hover:text-[#0F172A] transition-colors mr-1"><PencilIcon /></button>
                      <button onClick={() => onDelete(row)} className="p-1 rounded text-[#64748B] hover:text-red-400 transition-colors"><XIcon /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const [activeView, setActiveView] = useState<View>("account")
  const [dirEntity, setDirEntity]   = useState<DirEntity>("vendors")

  // Keyboard-nav region: the settings left-rail. Arrows move between the 5
  // top-level sections; Enter/→ switches view. Sub-page buttons are NOT marked
  // (they stay Tab/click-reachable). Single region on /settings — order 10.
  const { regionProps: settingsNavProps } = useNavRegion({ id: "settings-nav", order: 10 })

  const [logoUrl, setLogoUrl]           = useState<string | null>(null)
  const [hasCoverPage, setHasCoverPage] = useState(false)
  const [displayName, setDisplayName]       = useState("")
  const [savedDisplayName, setSavedDisplayName] = useState("")
  const [savingDisplayName, setSavingDisplayName] = useState(false)
  const [loadingCompany, setLoadingCompany] = useState(true)
  const [uploadingLogo, setUploadingLogo]   = useState(false)
  const [uploadingCover, setUploadingCover] = useState(false)
  const [companyMessage, setCompanyMessage] = useState<{ text: string; ok: boolean } | null>(null)

  // ── Per-tenant logo size (company_settings.logo_scale_pct) ────────────────
  const [logoScalePct, setLogoScalePct]           = useState<number>(LOGO_SCALE_DEFAULT)
  const [savedLogoScalePct, setSavedLogoScalePct] = useState<number>(LOGO_SCALE_DEFAULT)
  const [savingLogoScale, setSavingLogoScale]     = useState(false)

  // ── Per-tenant transmittal "Send via Email" template ──────────────────────
  const [emailSubjectTpl, setEmailSubjectTpl]           = useState(DEFAULT_TRANSMITTAL_EMAIL_SUBJECT)
  const [savedEmailSubjectTpl, setSavedEmailSubjectTpl] = useState(DEFAULT_TRANSMITTAL_EMAIL_SUBJECT)
  const [emailBodyTpl, setEmailBodyTpl]                 = useState(DEFAULT_TRANSMITTAL_EMAIL_BODY)
  const [savedEmailBodyTpl, setSavedEmailBodyTpl]       = useState(DEFAULT_TRANSMITTAL_EMAIL_BODY)
  const [savingEmailTpl, setSavingEmailTpl]             = useState(false)
  // Natural pixel dims of the uploaded logo — the live preview needs them to run
  // the exact PDF fit math (Math.min(maxH/h, 150/w, 1)). Captured on img load.
  const [logoNatural, setLogoNatural]   = useState<{ w: number; h: number } | null>(null)
  const [previewSheetUrl, setPreviewSheetUrl] = useState<string | null>(null)
  const [previewingSheet, setPreviewingSheet] = useState(false)

  // ── Company-wide reminder defaults (Session K2) ───────────────────────────
  // Saved values from /api/settings/reminders are mirrored into the input
  // strings; "dirty" is computed against the saved snapshot so Save disables
  // until something actually changed.
  const [reminderDefaultsLoaded, setReminderDefaultsLoaded] = useState(false)
  const [savedCadence,  setSavedCadence]  = useState<number[]>([])
  const [savedMax,      setSavedMax]      = useState<number>(2)
  const [savedAttach,   setSavedAttach]   = useState<boolean>(false)
  const [cadenceInput,  setCadenceInput]  = useState<string>("")
  const [maxInput,      setMaxInput]      = useState<string>("")
  const [attachInput,   setAttachInput]   = useState<boolean>(false)
  const [savingReminders, setSavingReminders] = useState(false)
  const [reminderMessage, setReminderMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [teamMembers, setTeamMembers]   = useState<TeamMember[]>([])
  const [teamLoading, setTeamLoading]   = useState(false)
  const [teamLoaded, setTeamLoaded]     = useState(false)
  const [showTeamForm, setShowTeamForm] = useState(false)
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null)
  const [memberForm, setMemberForm]     = useState({ name: "", title: "", email: "" })

  // ── Team (multi-user accounts) — Phase 3 ─────────────────────────────────
  const [accountMembers, setAccountMembers]     = useState<AccountMember[]>([])
  const [pendingInvites, setPendingInvites]     = useState<PendingInvite[]>([])
  const [accountsLoaded, setAccountsLoaded]     = useState(false)
  const [accountsLoading, setAccountsLoading]   = useState(false)
  const [inviteFormOpen, setInviteFormOpen]     = useState(false)
  const [inviteEmail, setInviteEmail]           = useState("")
  const [inviteRole, setInviteRole]             = useState<"admin" | "member" | "field">("member")
  // ADR-020: invite-time per-project module grants (role = field only).
  const [inviteGrants, setInviteGrants]         = useState<FieldGrant[]>([])
  // ADR-020: per-member "Manage access" editor (field members only).
  const [accessEditorUserId, setAccessEditorUserId] = useState<string | null>(null)
  const [accessEditorGrants, setAccessEditorGrants] = useState<FieldGrant[]>([])
  const [accessEditorLoading, setAccessEditorLoading] = useState(false)
  const [accessEditorSaving, setAccessEditorSaving]   = useState(false)
  const [accessEditorError, setAccessEditorError]     = useState<string | null>(null)
  const [inviting, setInviting]                 = useState(false)
  const [inviteError, setInviteError]           = useState<string | null>(null)
  const [lastInvite, setLastInvite]             = useState<InviteResult | null>(null)
  const [copiedInviteId, setCopiedInviteId]     = useState<string | null>(null)
  const [roleChangingUserId, setRoleChangingUserId] = useState<string | null>(null)
  const [removingUserId, setRemovingUserId]     = useState<string | null>(null)
  const [memberActionError, setMemberActionError] = useState<string | null>(null)
  // Current user identity for UI-side admin/creator checks. Server still
  // enforces; this is purely for affordance hiding (e.g. project Delete
  // button is hidden from members on projects they didn't create).
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [currentRole, setCurrentRole]     = useState<string | null>(null)
  const [savingMember, setSavingMember] = useState(false)
  const [teamMessage, setTeamMessage]   = useState<{ text: string; ok: boolean } | null>(null)

  const [projects, setProjects]         = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsLoaded, setProjectsLoaded]   = useState(false)
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [editingProject, setEditingProject]   = useState<Project | null>(null)
  const [projectForm, setProjectForm]   = useState({ name: "", number: "", location: "", gc_name: "", architect: "", cm_name: "" })
  const [savingProject, setSavingProject] = useState(false)
  const [projectMessage, setProjectMessage] = useState<{ text: string; ok: boolean } | null>(null)
  // Spec book management — inline expandable panel per project row.
  const [expandedSpecBooks, setExpandedSpecBooks] = useState<string | null>(null)
  const [specBookCounts, setSpecBookCounts]       = useState<Record<string, number>>({})

  // Spec-book scope wizard (new-project flow only)
  const [wizardStep, setWizardStep]           = useState<1 | 2 | 3>(1)
  const [wizardProjectId, setWizardProjectId] = useState<string | null>(null)
  const [specBookFile, setSpecBookFile]       = useState<File | null>(null)
  const [specBookDocId, setSpecBookDocId]     = useState<string | null>(null)
  const [tocSections, setTocSections]         = useState<TocEntry[]>([])
  const [tocDivisions, setTocDivisions]       = useState<TocDivision[]>([])
  const [tocBusy, setTocBusy]                 = useState(false)
  const [tocError, setTocError]               = useState<string | null>(null)
  const [scopeUploadProgress, setScopeUploadProgress] = useState(0)
  const [scopeDivisions, setScopeDivisions]   = useState<Set<string>>(new Set())
  const [scopeSections, setScopeSections]     = useState<Set<string>>(new Set())
  const [scopeSaving, setScopeSaving]         = useState(false)
  const [wizardScopeOnly, setWizardScopeOnly] = useState(false)   // set scope on an existing project
  const [scopeChecking, setScopeChecking]     = useState(false)   // probing for an already-uploaded book
  const [scopeExistingDocIds, setScopeExistingDocIds] = useState<string[]>([])
  const [wizardProjectName, setWizardProjectName] = useState("")
  const [scopedProjectIds, setScopedProjectIds]   = useState<Set<string>>(new Set())
  const [wizardEditScope, setWizardEditScope] = useState(false)   // editing scope already set on a project
  const [scopeClearing, setScopeClearing]     = useState(false)   // DELETE in flight on the clear path
  // Per-section diagnosis from the last parse (spec_number → diagnosis), shown
  // inline on scope rows. Only populated by loadSavedScope (Edit-scope flow);
  // empty for a fresh wizard, where nothing has parsed yet.
  const [scopeDiagnosis, setScopeDiagnosis]   = useState<Record<string, ScopeDiagnosis>>({})

  // Retained for the project-edit form's per-project assignment UI only; the
  // global Directory CRUD moved to <VendorsDirectory>.
  const [subcontractors, setSubcontractors] = useState<Subcontractor[]>([])
  const [subsLoading, setSubsLoading]       = useState(false)
  const [subsLoaded, setSubsLoaded]         = useState(false)

  const [suppliers, setSuppliers]           = useState<Supplier[]>([])
  const [supplLoading, setSupplLoading]     = useState(false)
  const [supplLoaded, setSupplLoaded]       = useState(false)

  const [cms, setCms]                       = useState<ConstructionManager[]>([])
  const [cmsLoading, setCmsLoading]         = useState(false)
  const [cmsLoaded, setCmsLoaded]           = useState(false)
  const [showCmForm, setShowCmForm]         = useState(false)
  const [editingCm, setEditingCm]           = useState<ConstructionManager | null>(null)
  const [cmForm, setCmForm]                 = useState({ company_name: "", contact_name: "", phone: "", email: "", address: "", notes: "" })
  const [savingCm, setSavingCm]             = useState(false)
  const [cmMessage, setCmMessage]           = useState<{ text: string; ok: boolean } | null>(null)

  const [projectSubIds, setProjectSubIds]   = useState<string[]>([])
  const [projectSupIds, setProjectSupIds]   = useState<string[]>([])
  const [projectCmIds, setProjectCmIds]     = useState<string[]>([])
  const [quickAddSubOpen, setQuickAddSubOpen]   = useState(false)
  const [quickAddSupplOpen, setQuickAddSupplOpen] = useState(false)
  const [quickAddCmOpen, setQuickAddCmOpen] = useState(false)
  const [quickAddName, setQuickAddName]     = useState("")
  const [quickAddField, setQuickAddField]   = useState("")

  const [gmailConn, setGmailConn]         = useState<GmailConnection | null>(null)
  const [gmailLoading, setGmailLoading]   = useState(false)
  const [gmailLoaded, setGmailLoaded]     = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [renewingWatch, setRenewingWatch] = useState(false)
  const [gmailMessage, setGmailMessage]   = useState<{ text: string; ok: boolean } | null>(null)

  const [teamImportRows, setTeamImportRows]       = useState<TeamImportRow[] | null>(null)
  const [teamImporting, setTeamImporting]         = useState(false)
  const [teamImportResult, setTeamImportResult]   = useState<{ imported: number; errors: string[] } | null>(null)

  const [projectImportRows, setProjectImportRows]     = useState<ProjectImportRow[] | null>(null)
  const [projectImporting, setProjectImporting]       = useState(false)
  const [projectImportResult, setProjectImportResult] = useState<{ imported: number; errors: string[] } | null>(null)

  const logoInputRef        = useRef<HTMLInputElement>(null)
  const coverInputRef       = useRef<HTMLInputElement>(null)
  const teamCsvInputRef     = useRef<HTMLInputElement>(null)
  const projectCsvInputRef  = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then(d => {
        setLogoUrl(d.logo_url); setHasCoverPage(d.has_cover_page)
        setDisplayName(d.display_name ?? ""); setSavedDisplayName(d.display_name ?? "")
        const pct = clampLogoScalePct(d.logo_scale_pct)
        setLogoScalePct(pct); setSavedLogoScalePct(pct)
        const subj = d.transmittal_email_subject_template ?? DEFAULT_TRANSMITTAL_EMAIL_SUBJECT
        const bodyTpl = d.transmittal_email_body_template ?? DEFAULT_TRANSMITTAL_EMAIL_BODY
        setEmailSubjectTpl(subj); setSavedEmailSubjectTpl(subj)
        setEmailBodyTpl(bodyTpl); setSavedEmailBodyTpl(bodyTpl)
      })
      .finally(() => setLoadingCompany(false))

    fetch("/api/settings/reminders")
      .then(r => r.json())
      .then((d: { reminder_cadence_days: number[]; reminder_max_count: number; reminder_default_attach_pdf: boolean }) => {
        setSavedCadence(d.reminder_cadence_days)
        setSavedMax(d.reminder_max_count)
        setSavedAttach(d.reminder_default_attach_pdf)
        setCadenceInput(formatCadence(d.reminder_cadence_days))
        setMaxInput(String(d.reminder_max_count))
        setAttachInput(d.reminder_default_attach_pdf)
      })
      .finally(() => setReminderDefaultsLoaded(true))

    // Handle redirect params: OAuth callback (?tab=gmail&connected=1) or a
    // direct deep-link to a specific tab (e.g. ?tab=projects from the dashboard).
    const params = new URLSearchParams(window.location.search)
    const tabParam = params.get("tab")
    if (tabParam === "gmail") {
      setActiveView("gmail")
      const connected = params.get("connected")
      const err = params.get("error")
      if (connected === "1") {
        setGmailMessage({ text: "Gmail account connected successfully.", ok: true })
        setTimeout(() => setGmailMessage(null), 5000)
      } else if (err) {
        setGmailMessage({ text: `Connection failed: ${decodeURIComponent(err)}`, ok: false })
        setTimeout(() => setGmailMessage(null), 8000)
      }
      window.history.replaceState({}, "", "/settings?tab=gmail")
    } else if (tabParam && TAB_TO_VIEW[tabParam]) {
      // Map an old flat-tab key to the new section/sub-page (and entity).
      const dest = TAB_TO_VIEW[tabParam]
      setActiveView(dest.view)
      if (dest.entity) setDirEntity(dest.entity)
    }
  }, [])

  // Fetch current user's id + role once on mount. Cheap (SELECT-own RLS on
  // user_profiles), used for affordance gating. Server still enforces.
  useEffect(() => {
    (async () => {
      const sb = createClient()
      const { data: { user } } = await sb.auth.getUser()
      if (!user) { setCurrentRole(null); return }
      setCurrentUserId(user.id)
      const { data: profile } = await sb.from("user_profiles").select("role").eq("user_id", user.id).maybeSingle()
      setCurrentRole(profile?.role ?? null)
      // ADR-020: field users get only the Account (profile) section. Deep
      // links to any other view snap back. Server routes behind the hidden
      // tabs are admin-gated / RLS-locked regardless.
      if (profile?.role === "field") setActiveView("account")
    })()
  }, [])

  // Lazy-load each surface's data when first shown. Same load functions and
  // fetch call paths as before — only the trigger key changed (tab → view).
  useEffect(() => {
    if (activeView === "people-team" && !accountsLoaded) loadAccounts()
    if (activeView === "people-contacts" && !teamLoaded) loadTeam()
    if (activeView === "dir-projects" && !projectsLoaded) loadProjects()
    if (activeView === "dir-companies") {
      // Vendors loads its own data inside <VendorsDirectory>.
      if (dirEntity === "cms" && !cmsLoaded) loadCms()
    }
    if (activeView === "gmail" && !gmailLoaded) loadGmailConnection()
  }, [activeView, dirEntity])

  async function loadAccounts() {
    setAccountsLoading(true)
    try {
      const res = await fetch("/api/team/members")
      if (!res.ok) {
        // Members will see a 403 here; the page will just render empty
        // sections. Phase 5 will add proper UI gating once members exist.
        setAccountsLoaded(true)
        return
      }
      const data = await res.json()
      setAccountMembers(data.members ?? [])
      setPendingInvites(data.pending_invites ?? [])
      setAccountsLoaded(true)
    } catch {
      setAccountsLoaded(true)
    } finally {
      setAccountsLoading(false)
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    if (inviteRole === "field" && inviteGrants.length === 0) {
      setInviteError("A field invite needs at least one project/module grant.")
      return
    }
    setInviting(true)
    setInviteError(null)
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail,
          role: inviteRole,
          ...(inviteRole === "field" ? { project_grants: inviteGrants } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to send invite")
      setLastInvite({ email: inviteEmail, invite_url: data.invite_url, gmail_sent: data.gmail_sent })
      setInviteEmail("")
      setInviteRole("member")
      setInviteGrants([])
      setInviteFormOpen(false)
      await loadAccounts()
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to send invite")
    } finally {
      setInviting(false)
    }
  }

  // ADR-020 — per-member access editor (field members). Reads/writes
  // project_access through the admin session; RLS enforces admin-only writes.
  async function openAccessEditor(userId: string) {
    setAccessEditorUserId(userId)
    setAccessEditorError(null)
    setAccessEditorLoading(true)
    if (!projectsLoaded) loadProjects()
    try {
      const res = await fetch(`/api/team/members/${userId}/access`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to load access")
      setAccessEditorGrants(data.grants ?? [])
    } catch (err) {
      setAccessEditorError(err instanceof Error ? err.message : "Failed to load access")
      setAccessEditorGrants([])
    } finally {
      setAccessEditorLoading(false)
    }
  }

  async function saveAccessEditor() {
    if (!accessEditorUserId) return
    if (accessEditorGrants.length === 0 && !confirm("No grants selected — this field user will lose access to every project. Save anyway?")) return
    setAccessEditorSaving(true)
    setAccessEditorError(null)
    try {
      const res = await fetch(`/api/team/members/${accessEditorUserId}/access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grants: accessEditorGrants }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to save access")
      setAccessEditorUserId(null)
    } catch (err) {
      setAccessEditorError(err instanceof Error ? err.message : "Failed to save access")
    } finally {
      setAccessEditorSaving(false)
    }
  }

  async function handleRevokeInvite(id: string) {
    if (!confirm("Revoke this invite?")) return
    const res = await fetch(`/api/invites/${id}`, { method: "DELETE" })
    if (res.ok) await loadAccounts()
  }

  function copyInviteLink(invite: PendingInvite) {
    navigator.clipboard.writeText(invite.invite_url)
    setCopiedInviteId(invite.id)
    setTimeout(() => setCopiedInviteId(prev => prev === invite.id ? null : prev), 1500)
  }

  async function handleRoleChange(m: AccountMember, newRole: "admin" | "member") {
    if (m.role === newRole) return
    const who = m.is_self ? "yourself" : (m.full_name ?? m.email ?? "this member")
    if (!confirm(`Change ${who}'s role to ${newRole}?`)) return
    setRoleChangingUserId(m.user_id)
    setMemberActionError(null)
    try {
      const res = await fetch(`/api/team/members/${m.user_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to update role")
      await loadAccounts()
    } catch (err) {
      setMemberActionError(err instanceof Error ? err.message : "Failed to update role")
    } finally {
      setRoleChangingUserId(null)
    }
  }

  async function handleRemoveMember(m: AccountMember) {
    const who = m.is_self ? "yourself" : (m.full_name ?? m.email ?? "this member")
    if (!confirm(`Remove ${who}? They lose access; their work stays.`)) return
    setRemovingUserId(m.user_id)
    setMemberActionError(null)
    try {
      const res = await fetch(`/api/team/members/${m.user_id}`, { method: "DELETE" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to remove member")
      if (m.is_self) {
        // Self-removed: sign out and hard-redirect to /login. Without
        // signOut the JWT stays valid client-side but every subsequent
        // request hits get_my_company_id()=null and breaks.
        await createClient().auth.signOut()
        window.location.href = "/login"
        return
      }
      await loadAccounts()
    } catch (err) {
      setMemberActionError(err instanceof Error ? err.message : "Failed to remove member")
    } finally {
      setRemovingUserId(null)
    }
  }

  function loadTeam() {
    setTeamLoading(true)
    fetch("/api/team")
      .then(r => r.json())
      .then(d => { setTeamMembers(d.members ?? []); setTeamLoaded(true) })
      .catch(() => {})
      .finally(() => setTeamLoading(false))
  }

  function loadProjects() {
    setProjectsLoading(true)
    fetch("/api/projects")
      .then(r => r.json())
      .then(d => { setProjects(d.projects ?? []); setProjectsLoaded(true) })
      .catch(() => {})
      .finally(() => setProjectsLoading(false))
    loadScopeStatus()
  }

  function loadScopeStatus() {
    fetch("/api/projects/scope-status")
      .then(r => r.json())
      .then(d => setScopedProjectIds(new Set<string>(d.scoped ?? [])))
      .catch(() => {})
  }

  function flashCompany(text: string, ok = true) {
    setCompanyMessage({ text, ok })
    setTimeout(() => setCompanyMessage(null), 3000)
  }

  async function saveDisplayName() {
    setSavingDisplayName(true)
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName }),
      })
      if (res.ok) { setSavedDisplayName(displayName.trim()); flashCompany("Display name saved") }
      else flashCompany("Could not save display name", false)
    } catch { flashCompany("Could not save display name", false) }
    finally { setSavingDisplayName(false) }
  }

  // Persist the logo size %. Admin-gated server-side (PATCH /api/settings). The
  // value is clamped both here-adjacent (the slider enforces 50–200) and again
  // on the server. Returns whether the write succeeded.
  async function saveLogoScale(): Promise<boolean> {
    setSavingLogoScale(true)
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logo_scale_pct: logoScalePct }),
      })
      if (res.ok) { setSavedLogoScalePct(logoScalePct); flashCompany("Logo size saved"); return true }
      flashCompany("Could not save logo size", false); return false
    } catch { flashCompany("Could not save logo size", false); return false }
    finally { setSavingLogoScale(false) }
  }

  // Persist the transmittal "Send via Email" template. Admin-gated server-side.
  // Server stores trimmed text and NULLs an empty value (→ falls back to the
  // built-in default); we snapshot the raw field values so the dirty check works.
  async function saveEmailTemplate() {
    setSavingEmailTpl(true)
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transmittal_email_subject_template: emailSubjectTpl,
          transmittal_email_body_template: emailBodyTpl,
        }),
      })
      if (res.ok) {
        setSavedEmailSubjectTpl(emailSubjectTpl); setSavedEmailBodyTpl(emailBodyTpl)
        flashCompany("Transmittal email template saved")
      } else flashCompany("Could not save the email template", false)
    } catch { flashCompany("Could not save the email template", false) }
    finally { setSavingEmailTpl(false) }
  }

  // Repopulate the fields with the built-in default — the user still clicks Save
  // to persist (which stores the default text; NULL and default text render the
  // same).
  function resetEmailTemplate() {
    setEmailSubjectTpl(DEFAULT_TRANSMITTAL_EMAIL_SUBJECT)
    setEmailBodyTpl(DEFAULT_TRANSMITTAL_EMAIL_BODY)
  }

  const emailTplDirty =
    emailSubjectTpl !== savedEmailSubjectTpl || emailBodyTpl !== savedEmailBodyTpl
  const emailTplIsDefault =
    emailSubjectTpl === DEFAULT_TRANSMITTAL_EMAIL_SUBJECT &&
    emailBodyTpl === DEFAULT_TRANSMITTAL_EMAIL_BODY

  // Render ONE real coversheet at the chosen size, on demand. Saves first when
  // the slider is dirty so the generated sheet (generate-cover reads the stored
  // value) reflects exactly what's on screen. No submittal/project ids are sent,
  // so the route renders a cover only and writes nothing to the DB or storage.
  async function handlePreviewSheet() {
    setPreviewingSheet(true)
    try {
      if (logoScalePct !== savedLogoScalePct) {
        const ok = await saveLogoScale()
        if (!ok) return
      }
      const res = await fetch("/api/generate-cover", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName: "Sample Project",
          projectNumber: "2025-001",
          gcName: displayName || "",
          specSectionTitle: "Logo Size Preview",
          specSectionNo: "01 00 00",
          description: "Representative coversheet rendered at your selected logo size.",
          submittalNo: "1",
          revisionNo: "0",
        }),
      })
      if (!res.ok) { flashCompany("Could not render preview sheet", false); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      setPreviewSheetUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url })
    } catch { flashCompany("Could not render preview sheet", false) }
    finally { setPreviewingSheet(false) }
  }

  function flashTeam(text: string, ok = true) {
    setTeamMessage({ text, ok })
    setTimeout(() => setTeamMessage(null), 3000)
  }

  function flashProject(text: string, ok = true) {
    setProjectMessage({ text, ok })
    setTimeout(() => setProjectMessage(null), 3000)
  }

  function flashGmail(text: string, ok = true) {
    setGmailMessage({ text, ok })
    setTimeout(() => setGmailMessage(null), 5000)
  }

  function loadGmailConnection() {
    setGmailLoading(true)
    fetch("/api/gmail/connection")
      .then(r => r.json())
      .then(d => { setGmailConn(d); setGmailLoaded(true) })
      .catch(() => {})
      .finally(() => setGmailLoading(false))
  }

  async function disconnectGmail() {
    if (!window.confirm("Disconnect your Gmail account? TuttoHQ will stop receiving email notifications.")) return
    setDisconnecting(true)
    try {
      const res = await fetch("/api/gmail/connection", { method: "DELETE" })
      if (!res.ok) throw new Error("Delete failed")
      setGmailConn({ connected: false })
      flashGmail("Gmail account disconnected.")
    } catch (err) {
      console.error("[settings] disconnectGmail failed", err)
      flashGmail("Failed to disconnect. Please try again.", false)
    } finally {
      setDisconnecting(false)
    }
  }

  async function renewWatch() {
    setRenewingWatch(true)
    try {
      const res = await fetch("/api/gmail/watch", { method: "POST" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      setGmailConn(prev => prev ? { ...prev, watch_expiry: data.watch_expiry } : prev)
      flashGmail("Gmail watch renewed successfully.")
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Renewal failed"
      flashGmail(msg, false)
    } finally {
      setRenewingWatch(false)
    }
  }

  async function uploadAsset(type: "logo" | "cover_page", file: File) {
    const { path } = await presignAndUpload("company-assets", type === "logo" ? "logos" : "covers", file)
    const res  = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, file_path: path, file_name: file.name }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? "Upload failed")
    return data
  }

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingLogo(true)
    try {
      const data = await uploadAsset("logo", file)
      if (data.logo_url) { setLogoUrl(data.logo_url); setLogoNatural(null) }
      flashCompany("Logo updated successfully")
    } catch (err) {
      console.error("[settings] logo upload failed", err)
      flashCompany("Logo upload failed", false)
    } finally {
      setUploadingLogo(false)
      e.target.value = ""
    }
  }

  async function handleCoverChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.type !== "application/pdf") {
      flashCompany("Cover page must be a PDF file", false)
      e.target.value = ""
      return
    }
    setUploadingCover(true)
    try {
      await uploadAsset("cover_page", file)
      setHasCoverPage(true)
      flashCompany("Cover page updated successfully")
    } catch (err) {
      console.error("[settings] cover page upload failed", err)
      flashCompany("Cover page upload failed", false)
    } finally {
      setUploadingCover(false)
      e.target.value = ""
    }
  }

  // ── Company reminder defaults (Session K2) ───────────────────────────────
  // TODO(multi-user): gate to admin role once user_profiles.role exists —
  // see multi-user spec. This handler writes company-wide defaults that
  // affect every PM in the tenant.
  async function saveReminderDefaults() {
    setSavingReminders(true)
    setReminderMessage(null)
    try {
      const cadenceParsed = parseCadenceInput(cadenceInput)
      const body = {
        reminder_cadence_days:       cadenceParsed ?? [],
        reminder_max_count:          maxInput.trim() === "" ? NaN : Number(maxInput),
        reminder_default_attach_pdf: attachInput,
      }
      const res = await fetch("/api/settings/reminders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setReminderMessage({ text: d.error ?? "Could not save reminder defaults", ok: false })
        return
      }
      // Snapshot the saved values so dirty-check resets.
      setSavedCadence(body.reminder_cadence_days as number[])
      setSavedMax(body.reminder_max_count as number)
      setSavedAttach(body.reminder_default_attach_pdf)
      setReminderMessage({ text: "Reminder defaults saved.", ok: true })
      setTimeout(() => setReminderMessage(null), 3000)
    } catch (e) {
      setReminderMessage({ text: e instanceof Error ? e.message : "Network error", ok: false })
    } finally {
      setSavingReminders(false)
    }
  }

  function revertReminderDefaults() {
    setCadenceInput(formatCadence(savedCadence))
    setMaxInput(String(savedMax))
    setAttachInput(savedAttach)
    setReminderMessage(null)
  }

  function openAddMember() {
    setEditingMember(null)
    setMemberForm({ name: "", title: "", email: "" })
    setShowTeamForm(true)
  }

  function openEditMember(m: TeamMember) {
    setEditingMember(m)
    setMemberForm({ name: m.name, title: m.title ?? "", email: m.email ?? "" })
    setShowTeamForm(true)
  }

  function cancelMemberForm() {
    setShowTeamForm(false)
    setEditingMember(null)
    setMemberForm({ name: "", title: "", email: "" })
  }

  async function saveMember(e: React.FormEvent) {
    e.preventDefault()
    if (!memberForm.name.trim()) return
    setSavingMember(true)
    try {
      const url    = editingMember ? `/api/team/${editingMember.id}` : "/api/team"
      const method = editingMember ? "PATCH" : "POST"
      const res    = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: memberForm.name.trim(), title: memberForm.title.trim() || null, email: memberForm.email.trim() || null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Save failed")
      if (editingMember) {
        setTeamMembers(prev => prev.map(m => m.id === editingMember.id ? data.member : m))
        flashTeam("Member updated")
      } else {
        setTeamMembers(prev => [...prev, data.member])
        flashTeam("Member added")
      }
      cancelMemberForm()
    } catch (err) {
      console.error("[settings] team member save failed", err)
      flashTeam("Save failed", false)
    } finally {
      setSavingMember(false)
    }
  }

  async function deleteMember(m: TeamMember) {
    if (!window.confirm(`Delete ${m.name}?`)) return
    const res = await fetch(`/api/team/${m.id}`, { method: "DELETE" })
    if (res.ok) {
      setTeamMembers(prev => prev.filter(x => x.id !== m.id))
      flashTeam("Member deleted")
    } else {
      flashTeam("Delete failed", false)
    }
  }

  function openAddProject() {
    setEditingProject(null)
    setProjectForm({ name: "", number: "", location: "", gc_name: "", architect: "", cm_name: "" })
    setProjectSubIds([])
    setProjectSupIds([])
    if (!subsLoaded) loadSubs()
    if (!supplLoaded) loadSuppliers()
    resetWizard()
    setShowProjectForm(true)
  }

  function openEditProject(p: Project) {
    setEditingProject(p)
    setProjectForm({ name: p.name, number: p.number ?? "", location: p.location ?? "", gc_name: p.gc_name ?? "", architect: p.architect ?? "", cm_name: p.cm_name ?? "" })
    setProjectSubIds([]); setProjectSupIds([]); setProjectCmIds([])
    if (!subsLoaded) loadSubs()
    if (!supplLoaded) loadSuppliers()
    if (!cmsLoaded) loadCms()
    Promise.all([
      fetch(`/api/projects/${p.id}/subcontractors`).then(r => r.json()),
      fetch(`/api/projects/${p.id}/suppliers`).then(r => r.json()),
      fetch(`/api/projects/${p.id}/cms`).then(r => r.json()),
    ]).then(([subs, supps, pcms]) => {
      setProjectSubIds((subs ?? []).map((s: { id: string }) => s.id))
      setProjectSupIds((supps ?? []).map((s: { id: string }) => s.id))
      setProjectCmIds((pcms ?? []).map((c: { id: string }) => c.id))
    }).catch(() => {})
    setShowProjectForm(true)
  }

  function resetWizard() {
    setWizardStep(1)
    setWizardProjectId(null)
    setSpecBookFile(null)
    setSpecBookDocId(null)
    setTocSections([]); setTocDivisions([])
    setTocBusy(false); setTocError(null)
    setScopeDivisions(new Set()); setScopeSections(new Set())
    setScopeDiagnosis({})
    setScopeSaving(false)
    setWizardScopeOnly(false); setWizardProjectName("")
    setScopeChecking(false); setScopeExistingDocIds([])
    setWizardEditScope(false); setScopeClearing(false)
  }

  // Launch the wizard for an existing project's "Set scope" / "Edit scope"
  // action. When scope is already set we reload the saved selections so the user
  // can modify or clear them; otherwise, if the project has spec books uploaded,
  // scope is read straight from their tables of contents (no re-upload needed).
  async function openScopeWizard(p: Project) {
    resetWizard()
    setEditingProject(null)
    setProjectForm({ name: "", number: "", location: "", gc_name: "", architect: "", cm_name: "" })
    setProjectSubIds([]); setProjectSupIds([]); setProjectCmIds([])
    setWizardProjectId(p.id)
    setWizardProjectName(p.name)
    setWizardScopeOnly(true)
    setWizardStep(1)
    setShowProjectForm(true)
    setScopeChecking(true)
    const alreadyScoped = scopedProjectIds.has(p.id)
    // Editing: pre-fill from the saved scope rows. Fall back to reading the spec
    // books only if the saved scope can't be loaded (e.g. it was cleared in a
    // concurrent session).
    const loaded = alreadyScoped ? await loadSavedScope(p.id) : false
    if (loaded) setWizardEditScope(true)
    else await loadScopeFromExistingBooks(p.id)
    setScopeChecking(false)
  }

  // Reconstructs the wizard from a project's saved project_scope_sections rows.
  // Those rows are a full snapshot of the TOC (every section, in or out of
  // scope), so they reproduce both the section list and the exact selections.
  // Lands on the section-refinement step (step 3) with everything pre-checked.
  // Returns false when the project has no saved scope rows.
  async function loadSavedScope(projectId: string): Promise<boolean> {
    try {
      const r = await fetch(`/api/projects/${projectId}/scope`)
      if (!r.ok) return false
      const d = await r.json()
      const rows: { spec_number: string; spec_title: string; division_code: string; in_scope: boolean; diagnosis: ScopeDiagnosis | null }[] = d.scope ?? []
      if (rows.length === 0) return false

      const sections: TocEntry[] = rows
        .map(s => ({ specNumber: s.spec_number, specTitle: s.spec_title, divisionCode: s.division_code }))
        .sort((a, b) => a.specNumber.localeCompare(b.specNumber))

      const counts = new Map<string, number>()
      for (const s of sections) counts.set(s.divisionCode, (counts.get(s.divisionCode) ?? 0) + 1)
      const divisions: TocDivision[] = [...counts.entries()]
        .map(([code, sectionCount]) => ({
          code,
          name: CSI_DIVISIONS.find(dv => dv.num === code)?.name ?? `Division ${code}`,
          sectionCount,
        }))
        .sort((a, b) => a.code.localeCompare(b.code))

      const inScopeSections = new Set(rows.filter(s => s.in_scope).map(s => s.spec_number))
      const inScopeDivisions = new Set(sections.filter(s => inScopeSections.has(s.specNumber)).map(s => s.divisionCode))

      // Re-parsing the project's spec books applies any new scope; harmless when
      // they're already parsed (the parse route no-ops on parsed volumes).
      try {
        const sb = await fetch(`/api/spec-books?project_id=${encodeURIComponent(projectId)}`)
        if (sb.ok) {
          const sbData = await sb.json()
          setScopeExistingDocIds((sbData.documents ?? []).map((doc: { id: string }) => doc.id))
        }
      } catch { /* non-fatal: scope still saves without a re-parse */ }

      const diag: Record<string, ScopeDiagnosis> = {}
      for (const s of rows) if (s.diagnosis) diag[s.spec_number] = s.diagnosis

      setTocSections(sections)
      setTocDivisions(divisions)
      setScopeDivisions(inScopeDivisions)
      setScopeSections(inScopeSections)
      setScopeDiagnosis(diag)
      // No in-scope divisions yet → start at division selection; otherwise jump
      // straight to section refinement where the current selections are visible.
      setWizardStep(inScopeDivisions.size > 0 ? 3 : 2)
      return true
    } catch (err) {
      console.error("[settings] saved scope load failed", err)
      return false
    }
  }

  // Reads scope from spec books already uploaded to the project. Advances to
  // the division step and returns true on success; returns false (leaving the
  // wizard on the upload step) when there is no readable book to reuse.
  async function loadScopeFromExistingBooks(projectId: string): Promise<boolean> {
    try {
      const r = await fetch(`/api/spec-books?project_id=${encodeURIComponent(projectId)}`)
      if (!r.ok) return false
      const d = await r.json()
      const docs: { id: string }[] = d.documents ?? []
      if (docs.length === 0) return false

      // Build each volume's section list in parallel, then merge. Prefer the
      // volume's ALREADY-PARSED spec_sections (authoritative: all divisions
      // incl. 00–04, the corrected titles, no TOC annotation suffixes). Only a
      // volume that hasn't been parsed yet falls back to re-parsing its table of
      // contents — keeping genuine pre-parse scoping working.
      const results = await Promise.all(docs.map(async doc => {
        try {
          const sb = await fetch(`/api/spec-books/${doc.id}`)
          if (sb.ok) {
            const sbData = await sb.json()
            const parsed: { spec_number: string; spec_title: string }[] = sbData.sections ?? []
            if (parsed.length > 0) return tocFromSpecSections(parsed)
          }
          const tocRes = await fetch(`/api/spec-books/${doc.id}/toc`, { method: "POST" })
          if (!tocRes.ok) return null
          const tocData = await tocRes.json()
          return { sections: tocData.sections ?? [], divisions: tocData.divisions ?? [] } as Toc
        } catch (err) {
          console.error(`[settings] scope source load failed for doc ${doc.id}`, err)
          return null
        }
      }))
      const merged = mergeTocs(results.filter((t): t is Toc => t !== null))
      if (merged.sections.length === 0) return false

      setScopeExistingDocIds(docs.map(doc => doc.id))
      setTocSections(merged.sections)
      setTocDivisions(merged.divisions)
      setScopeDivisions(new Set(merged.divisions.filter(dv => isDefaultInScopeDivision(dv.code)).map(dv => dv.code)))
      setWizardStep(2)
      return true
    } catch (err) {
      console.error("[settings] scope wizard TOC load failed", err)
      return false
    }
  }

  function cancelProjectForm() {
    setShowProjectForm(false)
    setEditingProject(null)
    setProjectForm({ name: "", number: "", location: "", gc_name: "", architect: "", cm_name: "" })
    setProjectSubIds([]); setProjectSupIds([]); setProjectCmIds([])
    resetWizard()
  }

  // ── Scope wizard ────────────────────────────────────────────────────────────
  async function uploadSpecBookForScope(projectIdArg?: string) {
    const projectId = projectIdArg ?? wizardProjectId
    if (!specBookFile || !projectId) return
    setTocBusy(true)
    setTocError(null)
    setScopeUploadProgress(0)

    // The row is reserved before the file lands; track its id so a failed
    // upload (or unreadable PDF) can be rolled back rather than leaving a
    // stuck "pending" spec book behind.
    let docId: string | null = null
    try {
      // 1. Reserve a project_documents row + a Supabase signed upload URL.
      const presignRes = await fetch("/api/spec-books/presigned-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          file_name:  specBookFile.name,
          file_size:  specBookFile.size,
        }),
      })
      const presign = await presignRes.json()
      if (!presignRes.ok) throw new Error(presign.error ?? "Could not start the upload")
      docId = presign.document_id as string

      // 2. Send the file straight to storage — bypasses Vercel's 4.5 MB limit.
      await uploadFileToSignedUrl(presign.signed_url, specBookFile, p =>
        setScopeUploadProgress(p.percent),
      )

      // 3. Confirm the upload landed and record the real byte size.
      const finalizeRes = await fetch("/api/spec-books/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: docId }),
      })
      const finalize = await finalizeRes.json()
      if (!finalizeRes.ok) throw new Error(finalize.error ?? "Could not finalize the upload")

      setSpecBookDocId(docId)

      // 4. Read the table of contents to drive the scope picker.
      const tocRes = await fetch(`/api/spec-books/${docId}/toc`, { method: "POST" })
      if (tocRes.status === 422) {
        throw new Error("This PDF has no readable text (likely a scan). Skip scope for now and upload a digital copy later.")
      }
      const tocData = await tocRes.json()
      if (!tocRes.ok) throw new Error(tocData.error ?? "Could not read the table of contents")

      const sections: TocEntry[]    = tocData.sections ?? []
      const divisions: TocDivision[] = tocData.divisions ?? []
      setTocSections(sections)
      setTocDivisions(divisions)
      setScopeDivisions(new Set(divisions.filter(d => isDefaultInScopeDivision(d.code)).map(d => d.code)))
      setWizardStep(2)
    } catch (err) {
      // Drop the reserved row if anything after row creation failed (failed
      // upload, or an unreadable PDF), so no stuck "pending" spec book lingers.
      if (docId) {
        fetch(`/api/spec-books/${docId}`, { method: "DELETE" }).catch(() => {})
        setSpecBookDocId(null)
      }
      setScopeUploadProgress(0)
      setTocError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setTocBusy(false)
    }
  }

  function skipSpecBook() {
    flashProject(wizardScopeOnly ? "Closed — scope unchanged" : "Project added — scope can be set later")
    cancelProjectForm()
  }

  function toggleScopeDivision(code: string) {
    setScopeDivisions(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  function goToSectionStep() {
    // Pre-check every section under a selected division.
    setScopeSections(new Set(
      tocSections.filter(s => scopeDivisions.has(s.divisionCode)).map(s => s.specNumber),
    ))
    setWizardStep(3)
  }

  function toggleScopeSection(specNumber: string) {
    setScopeSections(prev => {
      const next = new Set(prev)
      if (next.has(specNumber)) next.delete(specNumber)
      else next.add(specNumber)
      return next
    })
  }

  function setScopeSectionsBulk(specNumbers: string[], checked: boolean) {
    setScopeSections(prev => {
      const next = new Set(prev)
      for (const n of specNumbers) {
        if (checked) next.add(n)
        else next.delete(n)
      }
      return next
    })
  }

  async function finishScope() {
    if (!wizardProjectId) return
    setScopeSaving(true)
    setTocError(null)
    try {
      const payload = tocSections.map(s => ({
        spec_number:   s.specNumber,
        spec_title:    s.specTitle,
        division_code: s.divisionCode,
        in_scope:      scopeDivisions.has(s.divisionCode) && scopeSections.has(s.specNumber),
      }))
      const res = await fetch(`/api/projects/${wizardProjectId}/scope`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections: payload }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? "Failed to save scope")
      }
      // Fire spec-book ingestion in the background — intentionally not awaited.
      // If it fails the project still has valid scope; the user can retry from
      // the Spec Books module. Re-parsing every volume applies the new scope.
      const parseIds = scopeExistingDocIds.length > 0
        ? scopeExistingDocIds
        : specBookDocId ? [specBookDocId] : []
      for (const id of parseIds) {
        fetch(`/api/spec-books/${id}/parse`, { method: "POST" }).catch(() => {})
      }
      flashProject(parseIds.length > 0
        ? "Project scope saved — spec book is parsing in the background"
        : "Project scope saved")
      loadScopeStatus()
      cancelProjectForm()
    } catch (err) {
      setTocError(err instanceof Error ? err.message : "Failed to save scope")
    } finally {
      setScopeSaving(false)
    }
  }

  // Clears every scope row for the project, returning it to the "not yet scoped"
  // state. Destructive (removes all selections), so it confirms first. Spec
  // sections / staged submittals already ingested are left untouched.
  async function clearScope() {
    if (!wizardProjectId) return
    if (!window.confirm("Clear this project's scope? All section selections will be removed and the project returns to the unscoped state. Already-ingested submittals are not affected.")) return
    setScopeClearing(true)
    setTocError(null)
    try {
      const res = await fetch(`/api/projects/${wizardProjectId}/scope`, { method: "DELETE" })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? "Failed to clear scope")
      }
      flashProject("Project scope cleared")
      loadScopeStatus()
      cancelProjectForm()
    } catch (err) {
      setTocError(err instanceof Error ? err.message : "Failed to clear scope")
    } finally {
      setScopeClearing(false)
    }
  }

  async function saveProject(e: React.FormEvent) {
    e.preventDefault()
    if (!projectForm.name.trim()) return
    setSavingProject(true)
    try {
      const url    = editingProject ? `/api/projects/${editingProject.id}` : "/api/projects"
      const method = editingProject ? "PATCH" : "POST"
      const res    = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:     projectForm.name.trim(),
          number:   projectForm.number.trim()   || null,
          location: projectForm.location.trim() || null,
          gc_name:  projectForm.gc_name.trim()  || null,
          architect: projectForm.architect.trim() || null,
          cm_name: projectForm.cm_name.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Save failed")
      const projectId = data.project.id
      await Promise.all([
        fetch(`/api/projects/${projectId}/subcontractors`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: projectSubIds }) }),
        fetch(`/api/projects/${projectId}/suppliers`,      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: projectSupIds }) }),
        fetch(`/api/projects/${projectId}/cms`,            { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: projectCmIds }) }),
      ])
      if (editingProject) {
        setProjects(prev => prev.map(p => p.id === editingProject.id ? data.project : p))
        flashProject("Project updated")
        cancelProjectForm()
      } else {
        // New project. Add it to the list, then either launch the spec-book
        // scope wizard (a book was attached) or close the form (skip path).
        setProjects(prev => [...prev, data.project])
        setWizardProjectId(projectId)
        if (specBookFile) {
          await uploadSpecBookForScope(projectId)
        } else {
          flashProject("Project added — scope can be set later")
          cancelProjectForm()
        }
      }
    } catch (err) {
      console.error("[settings] project save failed", err)
      flashProject("Save failed", false)
    } finally {
      setSavingProject(false)
    }
  }

  async function deleteProject(p: Project) {
    if (!window.confirm(`Delete project "${p.name}"?`)) return
    const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" })
    if (res.ok) {
      setProjects(prev => prev.filter(x => x.id !== p.id))
      flashProject("Project deleted")
    } else {
      flashProject("Delete failed", false)
    }
  }

  function downloadTeamTemplate() {
    const csv = "Name,Title,Email\nJane Smith,Project Manager,jane@company.com\nBob Jones,Superintendent,bob@company.com\n"
    const a = document.createElement("a")
    a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv)
    a.download = "team_members_template.csv"
    a.click()
  }

  function downloadProjectTemplate() {
    const csv = "Project Name,Project Number,Location,General Contractor,Architect\nRiverside Office Complex,2024-001,Austin TX,Turner Construction,Gensler\n"
    const a = document.createElement("a")
    a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv)
    a.download = "projects_template.csv"
    a.click()
  }

  function handleTeamCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ""
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows: TeamImportRow[] = results.data.map(r => ({
          name:  (r["Name"]  ?? r["name"]  ?? "").trim(),
          title: (r["Title"] ?? r["title"] ?? "").trim(),
          email: (r["Email"] ?? r["email"] ?? "").trim(),
        }))
        setTeamImportRows(rows)
        setTeamImportResult(null)
      },
    })
  }

  async function confirmTeamImport() {
    if (!teamImportRows) return
    const valid = teamImportRows.filter(r => r.name)
    if (!valid.length) return
    setTeamImporting(true)
    try {
      const res  = await fetch("/api/team/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members: valid }),
      })
      const data = await res.json()
      setTeamImportResult({ imported: data.imported ?? 0, errors: data.errors ?? [] })
      if (data.members?.length) {
        setTeamMembers(prev => [...prev, ...data.members])
      }
      setTeamImportRows(null)
      flashTeam(`Imported ${data.imported} member${data.imported !== 1 ? "s" : ""} successfully`)
    } catch (err) {
      console.error("[settings] team import failed", err)
      flashTeam("Import failed", false)
    } finally {
      setTeamImporting(false)
    }
  }

  function cancelTeamImport() {
    setTeamImportRows(null)
    setTeamImportResult(null)
  }

  function handleProjectCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ""
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows: ProjectImportRow[] = results.data.map(r => ({
          name:      (r["Project Name"]      ?? r["name"]      ?? "").trim(),
          number:    (r["Project Number"]    ?? r["number"]    ?? "").trim(),
          location:  (r["Location"]          ?? r["location"]  ?? "").trim(),
          gc_name:   (r["General Contractor"] ?? r["gc_name"]  ?? "").trim(),
          architect: (r["Architect"]         ?? r["architect"] ?? "").trim(),
        }))
        setProjectImportRows(rows)
        setProjectImportResult(null)
      },
    })
  }

  async function confirmProjectImport() {
    if (!projectImportRows) return
    const valid = projectImportRows.filter(r => r.name)
    if (!valid.length) return
    setProjectImporting(true)
    try {
      const res  = await fetch("/api/projects/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects: valid }),
      })
      const data = await res.json()
      setProjectImportResult({ imported: data.imported ?? 0, errors: data.errors ?? [] })
      if (data.projects?.length) {
        setProjects(prev => [...prev, ...data.projects])
      }
      setProjectImportRows(null)
      flashProject(`Imported ${data.imported} project${data.imported !== 1 ? "s" : ""} successfully`)
    } catch (err) {
      console.error("[settings] project import failed", err)
      flashProject("Import failed", false)
    } finally {
      setProjectImporting(false)
    }
  }

  function cancelProjectImport() {
    setProjectImportRows(null)
    setProjectImportResult(null)
  }

  function loadCms() {
    setCmsLoading(true)
    fetch("/api/construction-managers").then(r => r.json()).then(d => { setCms(d ?? []); setCmsLoaded(true) }).catch(() => {}).finally(() => setCmsLoading(false))
  }
  function flashCm(text: string, ok = true) { setCmMessage({ text, ok }); setTimeout(() => setCmMessage(null), 3000) }
  function openAddCm() { setEditingCm(null); setCmForm({ company_name: "", contact_name: "", phone: "", email: "", address: "", notes: "" }); setShowCmForm(true) }
  function openEditCm(c: ConstructionManager) { setEditingCm(c); setCmForm({ company_name: c.company_name, contact_name: c.contact_name ?? "", phone: c.phone ?? "", email: c.email ?? "", address: c.address ?? "", notes: c.notes ?? "" }); setShowCmForm(true) }
  function cancelCmForm() { setShowCmForm(false); setEditingCm(null) }

  async function saveCm(e: React.FormEvent) {
    e.preventDefault()
    if (!cmForm.company_name.trim()) return
    setSavingCm(true)
    try {
      const url = editingCm ? `/api/construction-managers/${editingCm.id}` : "/api/construction-managers"
      const method = editingCm ? "PATCH" : "POST"
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(cmForm) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Save failed")
      if (editingCm) { setCms(prev => prev.map(c => c.id === editingCm.id ? data : c)); flashCm("CM updated") }
      else { setCms(prev => [...prev, data]); flashCm("CM added") }
      cancelCmForm()
    } catch (err) { console.error("[settings] CM save failed", err); flashCm("Save failed", false) } finally { setSavingCm(false) }
  }

  async function deleteCm(c: ConstructionManager) {
    if (!window.confirm(`Delete ${c.company_name}?`)) return
    const res = await fetch(`/api/construction-managers/${c.id}`, { method: "DELETE" })
    if (res.ok) { setCms(prev => prev.filter(x => x.id !== c.id)); flashCm("Deleted") }
    else flashCm("Delete failed", false)
  }

  async function quickAddCm() {
    if (!quickAddName.trim()) return
    const res = await fetch("/api/construction-managers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company_name: quickAddName.trim(), contact_name: quickAddField.trim() || null }) })
    const data = await res.json()
    if (res.ok) {
      setCms(prev => [...prev, data])
      setCmsLoaded(true)
      setProjectCmIds(prev => [...prev, data.id])
    }
    setQuickAddCmOpen(false); setQuickAddName(""); setQuickAddField("")
  }

  // The per-project assignment pickers read the unified vendors master and split
  // by flag — subs = is_subcontractor, suppliers = is_supplier. RLS scopes every
  // row to the caller's company; the assignment itself persists to project_vendors
  // via the role-scoped /api/projects/[id]/{subcontractors,suppliers} routes.
  function loadSubs() {
    setSubsLoading(true)
    fetch("/api/vendors?all=1").then(r => r.json())
      .then(d => { setSubcontractors((d.vendors ?? []).filter((v: { is_subcontractor?: boolean }) => v.is_subcontractor)); setSubsLoaded(true) })
      .catch(() => {}).finally(() => setSubsLoading(false))
  }
  function loadSuppliers() {
    setSupplLoading(true)
    fetch("/api/vendors?all=1").then(r => r.json())
      .then(d => { setSuppliers((d.vendors ?? []).filter((v: { is_supplier?: boolean }) => v.is_supplier)); setSupplLoaded(true) })
      .catch(() => {}).finally(() => setSupplLoading(false))
  }
  // NOTE: the global vendor Directory CRUD lives in <VendorsDirectory> (unified
  // vendors master). loadSubs/loadSuppliers and the subcontractors/suppliers
  // arrays below are retained only for the project-edit form's per-project
  // assignment UI (a separate surface — see audit notes).

  async function quickAddSub() {
    if (!quickAddName.trim()) return
    const res = await fetch("/api/vendors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company_name: quickAddName.trim(), trade: quickAddField.trim() || null, is_subcontractor: true }) })
    const data = await res.json()
    if (res.ok && data.vendor) {
      setSubcontractors(prev => [...prev, data.vendor])
      setSubsLoaded(true)
      setProjectSubIds(prev => [...prev, data.vendor.id])
    }
    setQuickAddSubOpen(false); setQuickAddName(""); setQuickAddField("")
  }

  async function quickAddSuppl() {
    if (!quickAddName.trim()) return
    const res = await fetch("/api/vendors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company_name: quickAddName.trim(), specialty: quickAddField.trim() || null, is_supplier: true }) })
    const data = await res.json()
    if (res.ok && data.vendor) {
      setSuppliers(prev => [...prev, data.vendor])
      setSupplLoaded(true)
      setProjectSupIds(prev => [...prev, data.vendor.id])
    }
    setQuickAddSupplOpen(false); setQuickAddName(""); setQuickAddField("")
  }

  const activeSection = sectionOfView(activeView)

  return (
    <div className="min-h-screen bg-[#F4F5F7]">
      <div className="max-w-[1120px] mx-auto py-8 sm:py-12 px-4 sm:px-6">

        <div className="flex items-center justify-between mb-6 sm:mb-8">
          <div>
            <h1 className="text-[20px] sm:text-[22px] font-bold text-[#0F172A] tracking-tight">Settings</h1>
            <p className="text-[13px] text-[#64748B] mt-0.5">TuttoHQ</p>
          </div>
          <Link href="/" className="text-[13px] text-[#64748B] hover:text-[#0F172A] transition-colors whitespace-nowrap">
            ← Back
          </Link>
        </div>

        <div className="flex flex-col md:flex-row gap-6 md:gap-8">
          {/* Left rail — 5 grouped sections (ADR-006). On desktop the active
              section's sub-pages render beneath it (accordion); on mobile the
              sections become a horizontal strip with sub-pages as pills below. */}
          <nav className="md:w-52 md:flex-shrink-0" {...settingsNavProps}>
            <div className="flex md:flex-col gap-1 overflow-x-auto scrollbar-none -mx-4 px-4 md:mx-0 md:px-0 md:overflow-visible">
              {SETTINGS_NAV.filter(s => currentRole !== "field" || s.id === "account").map(section => {
                const isActiveSection = activeSection === section.id
                return (
                  <div key={section.id} className="md:contents">
                    <button
                      data-nav-item
                      onClick={() => setActiveView(section.defaultView)}
                      className={`text-left px-3 py-2 rounded-lg text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#7B9BB5] ${
                        isActiveSection
                          ? "bg-[#7B9BB5]/[0.12] text-[#0F172A]"
                          : "text-[#64748B] hover:text-[#0F172A] hover:bg-[#0F172A]/[0.03]"
                      }`}
                    >
                      {section.label}
                    </button>
                    {isActiveSection && section.subs.length > 0 && (
                      <div className="hidden md:flex md:flex-col gap-0.5 mt-0.5 mb-1.5 ml-2 pl-2 border-l border-[#E2E8F0]">
                        {section.subs.map(sub => (
                          <button
                            key={sub.view}
                            onClick={() => setActiveView(sub.view)}
                            className={`text-left px-3 py-1.5 rounded-md text-[13px] transition-colors ${
                              activeView === sub.view
                                ? "text-[#0F172A] font-semibold bg-[#7B9BB5]/10"
                                : "text-[#64748B] hover:text-[#0F172A] hover:bg-[#0F172A]/[0.03]"
                            }`}
                          >
                            {sub.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {(() => {
              const section = SETTINGS_NAV.find(s => s.id === activeSection)
              if (!section || section.subs.length === 0) return null
              return (
                <div className="flex md:hidden gap-1 mt-3 overflow-x-auto scrollbar-none -mx-4 px-4">
                  {section.subs.map(sub => (
                    <button
                      key={sub.view}
                      onClick={() => setActiveView(sub.view)}
                      className={`px-3 py-1.5 rounded-full text-[12px] font-medium whitespace-nowrap transition-colors ${
                        activeView === sub.view
                          ? "bg-[#7B9BB5] text-white"
                          : "bg-white border border-[#E2E8F0] text-[#64748B] hover:text-[#0F172A]"
                      }`}
                    >
                      {sub.label}
                    </button>
                  ))}
                </div>
              )
            })()}
          </nav>

          {/* Active view */}
          <div className="flex-1 min-w-0">

        {activeView === "account" && (
          <div className="space-y-4">
            <ProfileSignature />
            <ProfilePoNumbering />
          </div>
        )}

        {activeView === "company-labor" && (
          <LaborRatesTab canEdit={currentRole === "admin"} />
        )}

        {activeView === "company-bid-defaults" && (
          <BidDefaultsTab canEdit={currentRole === "admin"} />
        )}

        {activeView === "company-gc-template" && (
          <GcTemplateTab canEdit={currentRole === "admin"} />
        )}

        {activeView === "company-identity" && (
          <div className="space-y-4">
            {loadingCompany ? (
              <div className="text-[13px] text-[#64748B]">Loading…</div>
            ) : (
              <>
                <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
                  <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Company Logo</h2>
                  <p className="text-[12px] text-[#64748B] mb-4">
                    Displayed in the app header. PNG, SVG, or JPG recommended.
                  </p>
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-lg border border-[#E2E8F0] bg-white flex items-center justify-center overflow-hidden flex-shrink-0">
                      {logoUrl ? (
                        <img src={logoUrl} alt="Logo" className="w-full h-full object-contain p-1" />
                      ) : (
                        <svg className="w-7 h-7 text-[#64748B]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      )}
                    </div>
                    <div className="space-y-1">
                      <button
                        onClick={() => logoInputRef.current?.click()}
                        disabled={uploadingLogo}
                        className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors disabled:opacity-50"
                      >
                        {uploadingLogo ? "Uploading…" : logoUrl ? "Replace logo" : "Upload logo"}
                      </button>
                      {logoUrl && <p className="text-[11px] text-[#64748B]">Logo is active</p>}
                    </div>
                  </div>
                  <input ref={logoInputRef} type="file" accept="image/*" onChange={handleLogoChange} className="hidden" />

                  {/* Logo size on PDFs — per-tenant scale across every generated document */}
                  <div className="mt-5 pt-5 border-t border-[#E2E8F0]">
                    <h3 className="text-[13px] font-semibold text-[#0F172A] mb-0.5">Logo size on PDFs</h3>
                    <p className="text-[12px] text-[#64748B] mb-3">
                      Scales your logo on every generated PDF — submittal coversheets, RFIs, change orders, purchase orders, daily reports, and more. The preview below uses the same fit math as the PDF.
                    </p>
                    <div className="flex items-center gap-3 max-w-[460px] mb-4">
                      <input
                        type="range"
                        min={LOGO_SCALE_MIN} max={LOGO_SCALE_MAX} step={5}
                        value={logoScalePct}
                        onChange={e => setLogoScalePct(Number(e.target.value))}
                        disabled={currentRole !== "admin"}
                        className="flex-1 accent-[#7B9BB5] disabled:opacity-50"
                      />
                      <span className="w-12 text-right text-[13px] font-semibold text-[#0F172A] tabular-nums">{logoScalePct}%</span>
                      <button
                        onClick={saveLogoScale}
                        disabled={currentRole !== "admin" || savingLogoScale || logoScalePct === savedLogoScalePct}
                        className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex-shrink-0"
                      >
                        {savingLogoScale ? "Saving…" : "Save"}
                      </button>
                    </div>
                    {currentRole !== "admin" && (
                      <p className="text-[11px] text-[#94A3B8] mb-3 -mt-2">Only company admins can change the logo size.</p>
                    )}

                    {/* Representative live preview — approximate document header, no server round-trip */}
                    <p className="text-[11px] text-[#64748B] mb-1.5">Approximate header preview</p>
                    <div className="rounded-lg border border-[#E2E8F0] bg-white px-4 py-3 max-w-[480px]">
                      {logoUrl ? (
                        <div className="flex items-start justify-between gap-4" style={{ minHeight: 56 }}>
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-semibold text-[#0F172A] truncate">Submittal Coversheet</div>
                            <div className="text-[10px] text-[#94A3B8] mt-0.5">CS-001 · Generated preview</div>
                          </div>
                          {(() => {
                            const sc = clampLogoScalePct(logoScalePct) / 100
                            let wPx: number | undefined, hPx: number | undefined
                            if (logoNatural) {
                              const maxH = LOGO_PREVIEW_BASE_MAXH * sc
                              const fit = Math.min(maxH / logoNatural.h, 150 / logoNatural.w, 1)
                              wPx = logoNatural.w * fit * LOGO_PREVIEW_PX_PER_PT
                              hPx = logoNatural.h * fit * LOGO_PREVIEW_PX_PER_PT
                            }
                            return (
                              <img
                                src={logoUrl}
                                alt="Logo size preview"
                                onLoad={e => setLogoNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                                style={hPx ? { width: wPx, height: hPx } : { maxHeight: 48 }}
                                className="object-contain flex-shrink-0"
                              />
                            )
                          })()}
                        </div>
                      ) : (
                        <p className="text-[12px] text-[#94A3B8]">Upload a logo to preview its size.</p>
                      )}
                    </div>

                    {/* On-demand real sheet — one true render per click */}
                    <div className="flex items-center gap-3 mt-4">
                      <button
                        onClick={handlePreviewSheet}
                        disabled={!logoUrl || previewingSheet}
                        className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#F4F5F7] transition-colors disabled:opacity-50"
                      >
                        {previewingSheet ? "Rendering…" : "Preview on real sheet"}
                      </button>
                      <span className="text-[11px] text-[#64748B]">Saves your size, then renders one real coversheet PDF.</span>
                    </div>
                    {previewSheetUrl && (
                      <iframe
                        src={previewSheetUrl}
                        title="Logo size preview sheet"
                        className="mt-3 w-full max-w-[480px] rounded-lg border border-[#E2E8F0]"
                        style={{ height: 360 }}
                      />
                    )}
                  </div>

                  <div className="mt-5 pt-5 border-t border-[#E2E8F0]">
                    <h3 className="text-[13px] font-semibold text-[#0F172A] mb-0.5">Company display name</h3>
                    <p className="text-[12px] text-[#64748B] mb-3">
                      Shown as a text wordmark in the app header. When set, it replaces the logo image in the nav (the logo image is still used on generated PDFs). Leave blank to show the logo image.
                    </p>
                    <div className="flex items-center gap-2 max-w-[460px]">
                      <input
                        type="text"
                        value={displayName}
                        onChange={e => setDisplayName(e.target.value)}
                        placeholder="e.g. Tomlinson Hawley Patterson"
                        maxLength={60}
                        className="flex-1 h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#94A3B8]"
                      />
                      <button
                        onClick={saveDisplayName}
                        disabled={savingDisplayName || displayName.trim() === savedDisplayName.trim()}
                        className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex-shrink-0"
                      >
                        {savingDisplayName ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                </div>

                <CompanyDetailsCard canEdit={currentRole === "admin"} />

                {/* Transmittal "Send via Email" template — the prefilled message
                    the download page opens in the user's mail client. */}
                <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
                  <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Transmittal Email</h2>
                  <p className="text-[12px] text-[#64748B] mb-4">
                    The pre-written message for the “Send via Email” button on a transmittal package’s download page. It opens the sender’s own mail client — the app never sends. Use the merge fields below; they’re filled in from the package at send time.
                  </p>

                  <div className="space-y-3 max-w-[560px]">
                    <div>
                      <label className={labelCls}>Subject</label>
                      <input
                        type="text"
                        value={emailSubjectTpl}
                        onChange={e => setEmailSubjectTpl(e.target.value)}
                        disabled={currentRole !== "admin"}
                        className={`${inputCls} disabled:opacity-50`}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Body</label>
                      <textarea
                        value={emailBodyTpl}
                        onChange={e => setEmailBodyTpl(e.target.value)}
                        disabled={currentRole !== "admin"}
                        rows={9}
                        className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 resize-y placeholder:text-[#94A3B8] disabled:opacity-50"
                      />
                    </div>
                  </div>

                  {/* Merge-field legend */}
                  <div className="mt-3 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2.5 max-w-[560px]">
                    <p className="text-[11px] font-semibold text-[#64748B] uppercase tracking-wider mb-2">Merge fields</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                      {TRANSMITTAL_MERGE_FIELDS.map(f => (
                        <div key={f.token} className="flex items-baseline gap-2 text-[12px]">
                          <code className="font-mono text-[11px] text-[#0F172A] bg-white border border-[#E2E8F0] rounded px-1 py-0.5 flex-shrink-0">{f.token}</code>
                          <span className="text-[#64748B]">{f.label}</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-[#94A3B8] mt-2">Unknown fields are left as-is. Attachments are added by the sender — mailto can’t attach files.</p>
                  </div>

                  <div className="flex items-center gap-2 mt-4">
                    <button
                      onClick={saveEmailTemplate}
                      disabled={currentRole !== "admin" || savingEmailTpl || !emailTplDirty}
                      className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                    >
                      {savingEmailTpl ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={resetEmailTemplate}
                      disabled={currentRole !== "admin" || emailTplIsDefault}
                      className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50"
                    >
                      Reset to default
                    </button>
                  </div>
                  {currentRole !== "admin" && (
                    <p className="text-[11px] text-[#94A3B8] mt-2">Only company admins can edit the transmittal email template.</p>
                  )}
                </div>
              </>
            )}

            {companyMessage && (
              <div className={`text-center text-[13px] ${companyMessage.ok ? "text-[#7B9BB5]" : "text-red-400"}`}>
                {companyMessage.text}
              </div>
            )}
          </div>
        )}

        {activeView === "company-cover" && (
          <div className="space-y-4">
            {loadingCompany ? (
              <div className="text-[13px] text-[#64748B]">Loading…</div>
            ) : (
              <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
                <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Cover Page Template</h2>
                <p className="text-[12px] text-[#64748B] mb-4">
                  This PDF will be prepended to every submittal when a user opens or downloads it. Must be a PDF file.
                </p>
                <div className="flex items-center gap-3">
                  <div className={`flex-1 h-9 px-3 rounded-md border flex items-center text-[13px] ${
                    hasCoverPage
                      ? "border-[#E2E8F0] bg-white text-[#0F172A]"
                      : "border-dashed border-[#E2E8F0] text-[#64748B]"
                  }`}>
                    {hasCoverPage ? "📄 cover.pdf — active" : "No cover page uploaded"}
                  </div>
                  <button
                    onClick={() => coverInputRef.current?.click()}
                    disabled={uploadingCover}
                    className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors disabled:opacity-50 flex-shrink-0"
                  >
                    {uploadingCover ? "Uploading…" : hasCoverPage ? "Replace" : "Upload PDF"}
                  </button>
                </div>
                <input ref={coverInputRef} type="file" accept=".pdf,application/pdf" onChange={handleCoverChange} className="hidden" />
              </div>
            )}
            {companyMessage && (
              <div className={`text-center text-[13px] ${companyMessage.ok ? "text-[#7B9BB5]" : "text-red-400"}`}>
                {companyMessage.text}
              </div>
            )}
          </div>
        )}

        {activeView === "company-reminders" && (
          <div className="space-y-4">
            {/* Company-wide reminder cadence (submittal + closeout). Per-package
                overrides live on each package's detail view. */}
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
              <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Reminder Defaults</h2>
                  <p className="text-[12px] text-[#64748B] mb-4">
                    Sets the company-wide cadence for outbound package reminders (submittal + closeout).
                    Per-package overrides are configured on each package&apos;s detail view.
                  </p>

                  {!reminderDefaultsLoaded ? (
                    <div className="text-[12px] text-[#64748B]">Loading…</div>
                  ) : (() => {
                    // Live validation (mirrors the server-side validator).
                    const cadenceParsed = parseCadenceInput(cadenceInput)
                    const validatedBody = validateCompanyDefaultsBody({
                      reminder_cadence_days:       cadenceParsed ?? [],
                      reminder_max_count:          maxInput.trim() === "" ? NaN : Number(maxInput),
                      reminder_default_attach_pdf: attachInput,
                    })
                    const validationError = validatedBody.ok ? null : validatedBody.error
                    const dirty =
                      JSON.stringify(cadenceParsed ?? []) !== JSON.stringify(savedCadence) ||
                      (maxInput.trim() === "" ? NaN : Number(maxInput)) !== savedMax ||
                      attachInput !== savedAttach

                    return (
                      <div className="space-y-4 max-w-[460px]">
                        <div>
                          <label className="block text-[11px] font-semibold text-[#0F172A] mb-1">
                            Cadence (days after dispatch)
                          </label>
                          <input
                            type="text"
                            value={cadenceInput}
                            onChange={(e) => setCadenceInput(e.target.value)}
                            placeholder="e.g. 7, 14"
                            className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"
                          />
                          <p className="text-[11px] text-[#64748B] mt-1">
                            Comma-separated, strictly ascending, each ≤ {MAX_CADENCE_DAY}.
                          </p>
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-[#0F172A] mb-1">
                            Max reminders
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={MAX_REMINDER_COUNT}
                            value={maxInput}
                            onChange={(e) => setMaxInput(e.target.value)}
                            className="w-32 h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"
                          />
                          <p className="text-[11px] text-[#64748B] mt-1">1–{MAX_REMINDER_COUNT}.</p>
                        </div>

                        <div>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={attachInput}
                              onChange={(e) => setAttachInput(e.target.checked)}
                              className="h-4 w-4 rounded border-[#CBD5E1] text-[#7B9BB5] focus:ring-[#7B9BB5]"
                            />
                            <span className="text-[12px] font-semibold text-[#0F172A]">
                              Re-attach package PDF by default
                            </span>
                          </label>
                          <p className="text-[11px] text-[#64748B] mt-1 ml-6">
                            When off, reminders are text-only. Individual packages can override this.
                          </p>
                        </div>

                        {validationError && (
                          <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">
                            {validationError}
                          </div>
                        )}
                        {reminderMessage && (
                          <div className={`rounded-md px-3 py-2 text-[12px] ${
                            reminderMessage.ok
                              ? "bg-green-50 border border-green-200 text-green-700"
                              : "bg-red-50 border border-red-200 text-red-600"
                          }`}>
                            {reminderMessage.text}
                          </div>
                        )}

                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={saveReminderDefaults}
                            disabled={!dirty || savingReminders || !!validationError}
                            className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#5A7A94] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {savingReminders ? "Saving…" : "Save"}
                          </button>
                          <button
                            onClick={revertReminderDefaults}
                            disabled={!dirty || savingReminders}
                            className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )
                  })()}
                </div>
          </div>
        )}

        {activeView === "people-team" && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#E2E8F0]">
                <div>
                  <h2 className="text-[14px] font-semibold text-[#0F172A]">Team</h2>
                  <p className="text-[12px] text-[#64748B] mt-0.5">Manage who has access to this company in TuttoHQ.</p>
                </div>
                <button
                  onClick={() => { setInviteFormOpen(o => !o); setInviteError(null) }}
                  className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[13px] font-medium hover:bg-[#6A8AA4] transition-colors"
                >
                  {inviteFormOpen ? "Cancel" : "Invite"}
                </button>
              </div>

              {inviteFormOpen && (
                <form onSubmit={handleInvite} className="px-5 py-4 border-b border-[#E2E8F0] bg-[#F8FAFC] flex flex-col gap-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <div className="flex-1">
                      <label className={labelCls}>Email</label>
                      <input
                        type="email" required value={inviteEmail}
                        onChange={e => setInviteEmail(e.target.value)}
                        placeholder="person@company.com"
                        className={inputCls}
                      />
                    </div>
                    <div className="w-full sm:w-48">
                      <label className={labelCls}>Role</label>
                      <select
                        value={inviteRole}
                        onChange={e => {
                          const r = e.target.value as "admin" | "member" | "field"
                          setInviteRole(r)
                          // The grants grid needs the project list; lazy-load on
                          // first Field selection (same loader the Projects tab uses).
                          if (r === "field" && !projectsLoaded) loadProjects()
                        }}
                        className={inputCls}
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                        <option value="field">Field (foreman/super)</option>
                      </select>
                    </div>
                    <button
                      type="submit" disabled={inviting}
                      className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                    >
                      {inviting ? "Sending…" : "Send invite"}
                    </button>
                  </div>
                  {inviteRole === "field" && (
                    <div className="space-y-2">
                      <p className="text-[12px] text-[#64748B]">
                        Field users see only the projects and modules granted below. Edit implies view. At least one grant is required.
                      </p>
                      {projectsLoading ? (
                        <p className="text-[12px] text-[#64748B]">Loading projects…</p>
                      ) : (
                        <FieldAccessGrid
                          projects={projects}
                          value={inviteGrants}
                          onChange={setInviteGrants}
                          disabled={inviting}
                        />
                      )}
                    </div>
                  )}
                </form>
              )}

              {inviteError && (
                <div className="px-5 py-3 bg-red-50 border-b border-red-200 text-[12px] text-red-700">{inviteError}</div>
              )}

              {lastInvite && (
                <div className={`px-5 py-3 border-b ${lastInvite.gmail_sent ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
                  {lastInvite.gmail_sent ? (
                    <p className="text-[12px] text-green-800">Invite sent to {lastInvite.email}.</p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[12px] text-amber-900">
                        Couldn&apos;t send via Gmail. Share this link with {lastInvite.email} (expires in 7 days):
                      </p>
                      <div className="flex gap-2">
                        <input
                          readOnly value={lastInvite.invite_url}
                          className="flex-1 h-8 px-2 rounded border border-amber-300 bg-white text-[12px] font-mono"
                          onFocus={e => e.currentTarget.select()}
                        />
                        <button
                          onClick={() => navigator.clipboard.writeText(lastInvite.invite_url)}
                          className="h-8 px-3 rounded bg-amber-600 text-white text-[12px] font-semibold hover:bg-amber-700"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="px-5 py-4">
                <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[#64748B] mb-2">Members</h3>
                {accountsLoading ? (
                  <p className="text-[13px] text-[#64748B]">Loading…</p>
                ) : accountMembers.length === 0 ? (
                  <p className="text-[13px] text-[#64748B]">No members yet.</p>
                ) : (
                  <>
                    {memberActionError && (
                      <div className="mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded text-[12px] text-red-700">
                        {memberActionError}
                      </div>
                    )}
                    {(() => {
                      const adminCount = accountMembers.filter(x => x.role === "admin").length
                      return (
                    <table className="w-full text-[13px]">
                      <thead className="text-[11px] uppercase tracking-wider text-[#64748B] border-b border-[#E2E8F0]">
                        <tr>
                          <th className="text-left py-2 font-semibold">Name</th>
                          <th className="text-left py-2 font-semibold">Email</th>
                          <th className="text-left py-2 font-semibold">Role</th>
                          <th className="text-left py-2 font-semibold">Joined</th>
                          <th className="text-right py-2 font-semibold">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#E2E8F0]">
                        {accountMembers.map(m => {
                          const isOnlyAdmin = m.role === "admin" && adminCount === 1
                          const busy = roleChangingUserId === m.user_id || removingUserId === m.user_id
                          return (
                            <tr key={m.user_id}>
                              <td className="py-2 text-[#0F172A]">
                                {m.full_name ?? "—"}
                                {m.is_self && <span className="text-[#64748B] ml-1">(you)</span>}
                              </td>
                              <td className="py-2 text-[#0F172A]">{m.email ?? "—"}</td>
                              <td className="py-2">
                                {m.role === "field" ? (
                                  // ADR-020: field is invite-time only — the
                                  // set_user_role RPC accepts admin/member, so
                                  // converting to/from field is not offered.
                                  // Access is managed per-project instead.
                                  <div className="flex items-center gap-2">
                                    <span className="inline-flex h-7 items-center px-2 rounded border border-[#E2E8F0] bg-[#F4F5F7] text-[12px] text-[#64748B]">field</span>
                                    <button
                                      onClick={() => openAccessEditor(m.user_id)}
                                      className="text-[12px] text-[#456A88] hover:underline"
                                    >
                                      Manage access
                                    </button>
                                  </div>
                                ) : (
                                <>
                                <select
                                  value={m.role}
                                  disabled={isOnlyAdmin || busy}
                                  onChange={e => handleRoleChange(m, e.target.value as "admin" | "member")}
                                  className="h-7 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] disabled:bg-[#F4F5F7] disabled:text-[#64748B] disabled:cursor-not-allowed"
                                >
                                  <option value="member">member</option>
                                  <option value="admin">admin</option>
                                </select>
                                {isOnlyAdmin && (
                                  <div className="text-[10px] text-[#94A3B8] mt-1">Last admin — promote another member first</div>
                                )}
                                </>
                                )}
                              </td>
                              <td className="py-2 text-[#64748B]">{new Date(m.joined_at).toLocaleDateString()}</td>
                              <td className="py-2 text-right">
                                <button
                                  onClick={() => handleRemoveMember(m)}
                                  disabled={isOnlyAdmin || busy}
                                  className="text-[12px] text-red-600 hover:underline disabled:text-[#94A3B8] disabled:no-underline disabled:cursor-not-allowed"
                                >
                                  {removingUserId === m.user_id ? "Removing…" : "Remove"}
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                      )
                    })()}
                  </>
                )}
              </div>

              {accessEditorUserId && (
                <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !accessEditorSaving && setAccessEditorUserId(null)}>
                  <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-5 space-y-3" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-[14px] font-semibold text-[#0F172A]">Manage access</h3>
                        <p className="text-[12px] text-[#64748B] mt-0.5">
                          {(() => {
                            const m = accountMembers.find(x => x.user_id === accessEditorUserId)
                            return m ? (m.full_name ?? m.email ?? "Field member") : "Field member"
                          })()} — project &amp; module grants. Edit implies view.
                        </p>
                      </div>
                      <button onClick={() => setAccessEditorUserId(null)} disabled={accessEditorSaving} className="text-[13px] text-[#64748B] hover:text-[#0F172A]">Close</button>
                    </div>
                    {accessEditorError && (
                      <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-[12px] text-red-700">{accessEditorError}</div>
                    )}
                    {accessEditorLoading || projectsLoading ? (
                      <p className="text-[13px] text-[#64748B]">Loading…</p>
                    ) : (
                      <FieldAccessGrid
                        projects={projects}
                        value={accessEditorGrants}
                        onChange={setAccessEditorGrants}
                        disabled={accessEditorSaving}
                      />
                    )}
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        onClick={() => setAccessEditorUserId(null)}
                        disabled={accessEditorSaving}
                        className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A]"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveAccessEditor}
                        disabled={accessEditorSaving || accessEditorLoading}
                        className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50"
                      >
                        {accessEditorSaving ? "Saving…" : "Save access"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="px-5 py-4 border-t border-[#E2E8F0]">
                <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[#64748B] mb-2">Pending invites</h3>
                {pendingInvites.length === 0 ? (
                  <p className="text-[13px] text-[#64748B]">No pending invites.</p>
                ) : (
                  <table className="w-full text-[13px]">
                    <thead className="text-[11px] uppercase tracking-wider text-[#64748B] border-b border-[#E2E8F0]">
                      <tr>
                        <th className="text-left py-2 font-semibold">Email</th>
                        <th className="text-left py-2 font-semibold">Role</th>
                        <th className="text-left py-2 font-semibold">Expires</th>
                        <th className="text-right py-2 font-semibold">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E2E8F0]">
                      {pendingInvites.map(inv => (
                        <tr key={inv.id}>
                          <td className="py-2 text-[#0F172A]">{inv.email}</td>
                          <td className="py-2 text-[#0F172A]">{inv.role}</td>
                          <td className="py-2 text-[#64748B]">{new Date(inv.expires_at).toLocaleDateString()}</td>
                          <td className="py-2 text-right space-x-3">
                            <button
                              onClick={() => copyInviteLink(inv)}
                              className="text-[12px] text-[#456A88] hover:underline"
                            >
                              {copiedInviteId === inv.id ? "Copied!" : "Copy link"}
                            </button>
                            <button
                              onClick={() => handleRevokeInvite(inv.id)}
                              className="text-[12px] text-red-600 hover:underline"
                            >
                              Revoke
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {activeView === "people-contacts" && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#E2E8F0]">
                <div>
                  <h2 className="text-[14px] font-semibold text-[#0F172A]">Contacts</h2>
                  <p className="text-[12px] text-[#64748B] mt-0.5">Used to populate Reviewed By / Certified By fields on cover sheets.</p>
                </div>
                {currentRole === "admin" && !showTeamForm && !teamImportRows && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => teamCsvInputRef.current?.click()}
                      className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors flex items-center gap-1.5"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Import CSV
                    </button>
                    <button
                      onClick={openAddMember}
                      className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[13px] font-medium hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5"
                    >
                      <PlusIcon /> Add member
                    </button>
                  </div>
                )}
              </div>
              <input ref={teamCsvInputRef} type="file" accept=".csv,text/csv" onChange={handleTeamCsvChange} className="hidden" />

              {showTeamForm && (
                <div className="px-5 py-4 border-b border-[#E2E8F0] bg-[#F4F5F7]/50">
                  <p className="text-[13px] font-semibold text-[#0F172A] mb-3">
                    {editingMember ? "Edit member" : "New member"}
                  </p>
                  <form onSubmit={saveMember} className="space-y-3">
                    <div>
                      <label className={labelCls}>Name <span className="text-red-400">*</span></label>
                      <input
                        type="text"
                        value={memberForm.name}
                        onChange={e => setMemberForm(p => ({ ...p, name: e.target.value }))}
                        required
                        placeholder="Full name"
                        className={inputCls}
                        autoFocus
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>Title</label>
                        <input
                          type="text"
                          value={memberForm.title}
                          onChange={e => setMemberForm(p => ({ ...p, title: e.target.value }))}
                          placeholder="e.g. Project Manager"
                          className={inputCls}
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Email</label>
                        <input
                          type="email"
                          value={memberForm.email}
                          onChange={e => setMemberForm(p => ({ ...p, email: e.target.value }))}
                          placeholder="name@company.com"
                          className={inputCls}
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={cancelMemberForm}
                        className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={savingMember || !memberForm.name.trim()}
                        className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                      >
                        {savingMember ? "Saving…" : editingMember ? "Save changes" : "Add member"}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {teamImportRows && (
                <div className="border-b border-[#E2E8F0] bg-[#F4F5F7]/50">
                  <div className="px-5 py-3 flex items-center justify-between">
                    <div className="text-[13px] font-semibold text-[#0F172A]">
                      Preview — {teamImportRows.length} row{teamImportRows.length !== 1 ? "s" : ""}
                      {teamImportRows.filter(r => !r.name).length > 0 && (
                        <span className="ml-2 text-[12px] font-normal text-amber-400">
                          ({teamImportRows.filter(r => !r.name).length} missing name — will be skipped)
                        </span>
                      )}
                    </div>
                    <button
                      onClick={downloadTeamTemplate}
                      className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors"
                    >
                      Download template
                    </button>
                  </div>
                  <div className="overflow-x-auto max-h-60 overflow-y-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-[#F8F9FA]">
                        <tr className="border-b border-[#E2E8F0]">
                          <th className="text-left px-5 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Name</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Title</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Email</th>
                        </tr>
                      </thead>
                      <tbody>
                        {teamImportRows.map((r, i) => (
                          <tr key={i} className={`border-b border-[#E2E8F0]/50 ${!r.name ? "bg-red-500/5" : ""}`}>
                            <td className="px-5 py-2 text-[13px]">
                              {r.name
                                ? <span className="text-[#0F172A]">{r.name}</span>
                                : <span className="text-red-400 italic">missing</span>}
                            </td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.title || <span className="text-[#64748B]">—</span>}</td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.email || <span className="text-[#64748B]">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-5 py-3 flex items-center justify-between border-t border-[#E2E8F0]">
                    <span className="text-[12px] text-[#64748B]">
                      {teamImportRows.filter(r => r.name).length} of {teamImportRows.length} rows will be imported
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={cancelTeamImport}
                        disabled={teamImporting}
                        className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={confirmTeamImport}
                        disabled={teamImporting || !teamImportRows.filter(r => r.name).length}
                        className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                      >
                        {teamImporting ? "Importing…" : `Import ${teamImportRows.filter(r => r.name).length} member${teamImportRows.filter(r => r.name).length !== 1 ? "s" : ""}`}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {teamImportResult && teamImportResult.errors.length > 0 && (
                <div className="px-5 py-3 border-b border-[#E2E8F0] bg-red-500/5">
                  <p className="text-[12px] font-semibold text-red-400 mb-1">Some rows failed:</p>
                  {teamImportResult.errors.map((e, i) => (
                    <p key={i} className="text-[12px] text-red-400/80">{e}</p>
                  ))}
                </div>
              )}

              {teamLoading && (
                <div className="px-5 py-4 text-[13px] text-[#64748B]">Loading…</div>
              )}

              {!teamLoading && teamMembers.length === 0 && !teamImportRows && (
                <div className="px-5 py-6 text-center space-y-2">
                  <p className="text-[13px] text-[#64748B]">No team members yet.</p>
                  <button onClick={downloadTeamTemplate} className="text-[12px] text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors">
                    Download CSV template
                  </button>
                </div>
              )}

              {!teamLoading && teamMembers.length > 0 && (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[#E2E8F0]">
                      <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Name</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Title</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Email</th>
                      <th className="px-3 py-2.5 w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {teamMembers.map((m, i) => (
                      <tr key={m.id} className={`${i < teamMembers.length - 1 ? "border-b border-[#E2E8F0]" : ""} hover:bg-[#F4F5F7]/[0.03] transition-colors group`}>
                        <td className="px-5 py-3 text-[13px] font-medium text-[#0F172A]">{m.name}</td>
                        <td className="px-3 py-3 text-[13px] text-[#64748B]">{m.title ?? <span className="text-[#64748B]">—</span>}</td>
                        <td className="px-3 py-3 text-[13px] text-[#64748B]">{m.email ?? <span className="text-[#64748B]">—</span>}</td>
                        <td className="px-3 py-3">
                          {currentRole === "admin" && (
                            <div className="flex items-center gap-1.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => openEditMember(m)}
                                className="p-1 rounded text-[#64748B] hover:text-[#0F172A] hover:bg-[#F4F5F7]/[0.08] transition-colors"
                                title="Edit"
                              >
                                <PencilIcon />
                              </button>
                              <button
                                onClick={() => deleteMember(m)}
                                className="p-1 rounded text-[#64748B] hover:text-red-400 hover:bg-[#F4F5F7]/[0.08] transition-colors"
                                title="Delete"
                              >
                                <XIcon className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {teamMessage && (
              <div className={`text-center text-[13px] ${teamMessage.ok ? "text-[#7B9BB5]" : "text-red-400"}`}>
                {teamMessage.text}
              </div>
            )}
          </div>
        )}

        {activeView === "dir-projects" && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#E2E8F0]">
                <div>
                  <h2 className="text-[14px] font-semibold text-[#0F172A]">Projects</h2>
                  <p className="text-[12px] text-[#64748B] mt-0.5">Projects available when generating submittal cover sheets.</p>
                </div>
                {!showProjectForm && !projectImportRows && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => projectCsvInputRef.current?.click()}
                      className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors flex items-center gap-1.5"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Import CSV
                    </button>
                    <button
                      onClick={openAddProject}
                      className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[13px] font-medium hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5"
                    >
                      <PlusIcon /> Add project
                    </button>
                  </div>
                )}
              </div>
              <input ref={projectCsvInputRef} type="file" accept=".csv,text/csv" onChange={handleProjectCsvChange} className="hidden" />

              {showProjectForm && (
                <div className="px-5 py-4 border-b border-[#E2E8F0] bg-[#F4F5F7]/50">
                  <p className="text-[13px] font-semibold text-[#0F172A] mb-3">
                    {editingProject
                      ? "Edit project"
                      : wizardScopeOnly
                        ? `${wizardEditScope ? "Edit" : "Set"} project scope — ${wizardProjectName}`
                        : wizardStep > 1
                          ? `New project — Step ${wizardStep} of 3`
                          : "New project"}
                  </p>
                  {(editingProject || (wizardStep === 1 && !wizardProjectId)) && (
                  <form onSubmit={saveProject} className="space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label className={labelCls}>Project Name <span className="text-red-400">*</span></label>
                        <input
                          type="text"
                          value={projectForm.name}
                          onChange={e => setProjectForm(p => ({ ...p, name: e.target.value }))}
                          required
                          placeholder="e.g. Riverside Office Complex"
                          className={inputCls}
                          autoFocus
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Project No.</label>
                        <input
                          type="text"
                          value={projectForm.number}
                          onChange={e => setProjectForm(p => ({ ...p, number: e.target.value }))}
                          placeholder="2024-001"
                          className={inputCls}
                        />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>Location</label>
                      <input
                        type="text"
                        value={projectForm.location}
                        onChange={e => setProjectForm(p => ({ ...p, location: e.target.value }))}
                        placeholder="City, State"
                        className={inputCls}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>General Contractor</label>
                        <input
                          type="text"
                          value={projectForm.gc_name}
                          onChange={e => setProjectForm(p => ({ ...p, gc_name: e.target.value }))}
                          placeholder="GC company name"
                          className={inputCls}
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Architect</label>
                        <input
                          type="text"
                          value={projectForm.architect}
                          onChange={e => setProjectForm(p => ({ ...p, architect: e.target.value }))}
                          placeholder="Architecture firm"
                          className={inputCls}
                        />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>Construction Manager (CM) Name</label>
                      <input
                        type="text"
                        value={projectForm.cm_name}
                        onChange={e => setProjectForm(p => ({ ...p, cm_name: e.target.value }))}
                        placeholder="CM name printed on transmittal covers"
                        className={inputCls}
                      />
                      <p className="text-[11px] text-[#94A3B8] mt-1">
                        Auto-fills the “Sent To” field when you send a transmittal package; editable per package.
                      </p>
                    </div>
                    {/* Subcontractors on this project */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className={labelCls}>Subcontractors on this project</label>
                        <button type="button" onClick={() => { setQuickAddSubOpen(true); setQuickAddName(""); setQuickAddField("") }} className="text-[11px] text-[#7B9BB5] hover:text-[#6A8AA4] transition-colors">+ Add new</button>
                      </div>
                      {quickAddSubOpen && (
                        <div className="flex gap-2 mb-2">
                          <input autoFocus placeholder="Company name *" value={quickAddName} onChange={e => setQuickAddName(e.target.value)} className="flex-1 h-8 px-2.5 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                          <input placeholder="Trade (optional)" value={quickAddField} onChange={e => setQuickAddField(e.target.value)} className="flex-1 h-8 px-2.5 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                          <button type="button" onClick={quickAddSub} disabled={!quickAddName.trim()} className="h-8 px-3 rounded bg-[#7B9BB5] text-white text-[12px] font-medium hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">Add</button>
                          <button type="button" onClick={() => setQuickAddSubOpen(false)} className="h-8 px-2 rounded border border-[#E2E8F0] text-[12px] text-[#64748B]">✕</button>
                        </div>
                      )}
                      <div className="min-h-[36px] border border-[#E2E8F0] rounded-md p-2 flex flex-wrap gap-1.5 bg-white">
                        {projectSubIds.map(id => {
                          const s = subcontractors.find(x => x.id === id)
                          if (!s) return null
                          return <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#7B9BB5]/10 text-[#7B9BB5] text-[11px] font-medium">{s.company_name}{s.trade ? ` — ${s.trade}` : ""}<button type="button" onClick={() => setProjectSubIds(prev => prev.filter(x => x !== id))} className="ml-0.5 text-[#7B9BB5]/60 hover:text-[#7B9BB5]">✕</button></span>
                        })}
                        <select className="h-6 text-[11px] text-[#64748B] bg-transparent border-none focus:outline-none cursor-pointer" value="" onChange={e => { if (e.target.value && !projectSubIds.includes(e.target.value)) setProjectSubIds(prev => [...prev, e.target.value]) }}>
                          <option value="">+ Select subcontractor…</option>
                          {subcontractors.filter(s => !projectSubIds.includes(s.id)).map(s => <option key={s.id} value={s.id}>{s.company_name}{s.trade ? ` — ${s.trade}` : ""}</option>)}
                        </select>
                      </div>
                    </div>

                    {/* Suppliers on this project */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className={labelCls}>Suppliers on this project</label>
                        <button type="button" onClick={() => { setQuickAddSupplOpen(true); setQuickAddName(""); setQuickAddField("") }} className="text-[11px] text-[#7B9BB5] hover:text-[#6A8AA4] transition-colors">+ Add new</button>
                      </div>
                      {quickAddSupplOpen && (
                        <div className="flex gap-2 mb-2">
                          <input autoFocus placeholder="Company name *" value={quickAddName} onChange={e => setQuickAddName(e.target.value)} className="flex-1 h-8 px-2.5 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                          <input placeholder="Material/Specialty (optional)" value={quickAddField} onChange={e => setQuickAddField(e.target.value)} className="flex-1 h-8 px-2.5 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                          <button type="button" onClick={quickAddSuppl} disabled={!quickAddName.trim()} className="h-8 px-3 rounded bg-[#7B9BB5] text-white text-[12px] font-medium hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">Add</button>
                          <button type="button" onClick={() => setQuickAddSupplOpen(false)} className="h-8 px-2 rounded border border-[#E2E8F0] text-[12px] text-[#64748B]">✕</button>
                        </div>
                      )}
                      <div className="min-h-[36px] border border-[#E2E8F0] rounded-md p-2 flex flex-wrap gap-1.5 bg-white">
                        {projectSupIds.map(id => {
                          const s = suppliers.find(x => x.id === id)
                          if (!s) return null
                          return <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-medium">{s.company_name}{s.specialty ? ` — ${s.specialty}` : ""}<button type="button" onClick={() => setProjectSupIds(prev => prev.filter(x => x !== id))} className="ml-0.5 text-amber-500/60 hover:text-amber-700">✕</button></span>
                        })}
                        <select className="h-6 text-[11px] text-[#64748B] bg-transparent border-none focus:outline-none cursor-pointer" value="" onChange={e => { if (e.target.value && !projectSupIds.includes(e.target.value)) setProjectSupIds(prev => [...prev, e.target.value]) }}>
                          <option value="">+ Select supplier…</option>
                          {suppliers.filter(s => !projectSupIds.includes(s.id)).map(s => <option key={s.id} value={s.id}>{s.company_name}{s.specialty ? ` — ${s.specialty}` : ""}</option>)}
                        </select>
                      </div>
                    </div>

                    {/* Construction Managers on this project */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className={labelCls}>Construction Managers on this project</label>
                        <button type="button" onClick={() => { setQuickAddCmOpen(true); setQuickAddName(""); setQuickAddField("") }} className="text-[11px] text-[#7B9BB5] hover:text-[#6A8AA4] transition-colors">+ Add new</button>
                      </div>
                      {quickAddCmOpen && (
                        <div className="flex gap-2 mb-2">
                          <input autoFocus placeholder="Company name *" value={quickAddName} onChange={e => setQuickAddName(e.target.value)} className="flex-1 h-8 px-2.5 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                          <input placeholder="Contact name (optional)" value={quickAddField} onChange={e => setQuickAddField(e.target.value)} className="flex-1 h-8 px-2.5 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                          <button type="button" onClick={quickAddCm} disabled={!quickAddName.trim()} className="h-8 px-3 rounded bg-[#7B9BB5] text-white text-[12px] font-medium hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">Add</button>
                          <button type="button" onClick={() => setQuickAddCmOpen(false)} className="h-8 px-2 rounded border border-[#E2E8F0] text-[12px] text-[#64748B]">✕</button>
                        </div>
                      )}
                      <div className="min-h-[36px] border border-[#E2E8F0] rounded-md p-2 flex flex-wrap gap-1.5 bg-white">
                        {projectCmIds.map(id => {
                          const c = cms.find(x => x.id === id)
                          if (!c) return null
                          return <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[11px] font-medium">{c.company_name}{c.contact_name ? ` — ${c.contact_name}` : ""}<button type="button" onClick={() => setProjectCmIds(prev => prev.filter(x => x !== id))} className="ml-0.5 text-indigo-400/60 hover:text-indigo-700">✕</button></span>
                        })}
                        <select className="h-6 text-[11px] text-[#64748B] bg-transparent border-none focus:outline-none cursor-pointer" value="" onChange={e => { if (e.target.value && !projectCmIds.includes(e.target.value)) setProjectCmIds(prev => [...prev, e.target.value]) }}>
                          <option value="">+ Select CM…</option>
                          {cms.filter(c => !projectCmIds.includes(c.id)).map(c => <option key={c.id} value={c.id}>{c.company_name}{c.contact_name ? ` — ${c.contact_name}` : ""}</option>)}
                        </select>
                      </div>
                    </div>

                    {/* Spec book — optional; attaching one launches the scope wizard on Continue */}
                    {!editingProject && (
                      <div>
                        <label className={labelCls}>Spec Book PDF <span className="font-normal text-[#94A3B8]">(optional)</span></label>
                        <input
                          type="file"
                          accept=".pdf,application/pdf"
                          onChange={e => setSpecBookFile(e.target.files?.[0] ?? null)}
                          className="w-full text-[13px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-[12px] file:bg-[#E2E8F0] file:text-[#0F172A] hover:file:bg-[#CBD5E1]"
                        />
                        {specBookFile && (
                          <p className="mt-1.5 text-[11px] text-[#64748B]">{specBookFile.name} ({(specBookFile.size / 1024 / 1024).toFixed(2)} MB)</p>
                        )}
                        <p className="mt-1.5 text-[11px] text-[#64748B]">
                          Attach the spec book to set project scope from its table of contents. Leave empty to skip — you can set scope later.
                        </p>
                      </div>
                    )}

                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={cancelProjectForm}
                        className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={savingProject || !projectForm.name.trim()}
                        className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                      >
                        {savingProject ? "Saving…" : editingProject ? "Save changes" : "Continue"}
                      </button>
                    </div>
                  </form>
                  )}

                  {/* Probing for an already-uploaded spec book */}
                  {!editingProject && wizardStep === 1 && !!wizardProjectId && scopeChecking && (
                    <div className="flex items-center gap-2 py-6 text-[13px] text-[#64748B]">
                      <svg className="h-4 w-4 animate-spin text-[#7B9BB5]" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Checking for an uploaded spec book…
                    </div>
                  )}

                  {/* Spec book upload — scope-only fallback when no book is on file, or new-project spec retry */}
                  {!editingProject && wizardStep === 1 && !!wizardProjectId && !scopeChecking && (
                    <div className="space-y-3">
                      <p className="text-[12px] text-[#64748B]">
                        Upload the project spec book to set scope from its table of contents. Spec Book Ingestion will only process the sections you own. You can skip this and set scope later.
                      </p>
                      <div>
                        <label className={labelCls}>Spec Book PDF</label>
                        <input
                          type="file"
                          accept=".pdf,application/pdf"
                          onChange={e => setSpecBookFile(e.target.files?.[0] ?? null)}
                          className="w-full text-[13px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-[12px] file:bg-[#E2E8F0] file:text-[#0F172A] hover:file:bg-[#CBD5E1]"
                        />
                        {specBookFile && (
                          <p className="mt-1.5 text-[11px] text-[#64748B]">{specBookFile.name} ({(specBookFile.size / 1024 / 1024).toFixed(2)} MB)</p>
                        )}
                      </div>
                      {tocBusy && (
                        <div className="space-y-1">
                          <div className="h-1.5 rounded-full bg-[#E2E8F0] overflow-hidden">
                            <div
                              className="h-full bg-[#7B9BB5] transition-all duration-200"
                              style={{ width: `${scopeUploadProgress}%` }}
                            />
                          </div>
                          <p className="text-[11px] text-[#64748B]">
                            {scopeUploadProgress < 100 ? `Uploading… ${scopeUploadProgress}%` : "Reading table of contents…"}
                          </p>
                        </div>
                      )}
                      {tocError && (
                        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{tocError}</div>
                      )}
                      <div className="flex justify-end gap-2 pt-1">
                        <button
                          type="button"
                          onClick={skipSpecBook}
                          disabled={tocBusy}
                          className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors disabled:opacity-50"
                        >
                          Skip for now
                        </button>
                        <button
                          type="button"
                          onClick={() => uploadSpecBookForScope()}
                          disabled={tocBusy || !specBookFile}
                          className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                        >
                          {tocBusy ? "Working…" : "Upload & set scope"}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Wizard step 2 — divisions */}
                  {!editingProject && wizardStep === 2 && (
                    <div className="space-y-3">
                      <p className="text-[12px] text-[#64748B]">
                        {wizardEditScope
                          ? `Check the divisions this project owns — ${tocDivisions.length} in the current scope.`
                          : `Check the divisions this project owns — ${tocDivisions.length} found in the spec book. Divisions 01–12 and 14 are pre-selected.`}
                      </p>
                      <DivisionChecklist divisions={tocDivisions} checked={scopeDivisions} onToggle={toggleScopeDivision} />
                      <div className="flex items-center justify-between gap-2 pt-1">
                        {wizardEditScope ? (
                          <button
                            type="button"
                            onClick={clearScope}
                            disabled={scopeClearing || scopeSaving}
                            className="h-8 px-3 rounded-md border border-red-200 text-[13px] text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                          >
                            {scopeClearing ? "Clearing…" : "Clear scope"}
                          </button>
                        ) : <span />}
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={cancelProjectForm}
                            className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors"
                          >
                            Close
                          </button>
                          <button
                            type="button"
                            onClick={goToSectionStep}
                            disabled={scopeDivisions.size === 0}
                            className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                          >
                            Next: refine sections
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Wizard step 3 — section refinement */}
                  {!editingProject && wizardStep === 3 && (
                    <div className="space-y-3">
                      <p className="text-[12px] text-[#64748B]">
                        Uncheck any sections outside this project&apos;s scope. All sections in the selected divisions are checked by default.
                      </p>
                      <SectionAccordion
                        divisions={tocDivisions.filter(d => scopeDivisions.has(d.code))}
                        sections={tocSections}
                        checkedSections={scopeSections}
                        onToggleSection={toggleScopeSection}
                        onSetDivision={setScopeSectionsBulk}
                        diagnosisBySection={scopeDiagnosis}
                      />
                      {tocError && (
                        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">{tocError}</div>
                      )}
                      <div className="flex items-center justify-between gap-2 pt-1">
                        {wizardEditScope ? (
                          <button
                            type="button"
                            onClick={clearScope}
                            disabled={scopeClearing || scopeSaving}
                            className="h-8 px-3 rounded-md border border-red-200 text-[13px] text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                          >
                            {scopeClearing ? "Clearing…" : "Clear scope"}
                          </button>
                        ) : <span />}
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setWizardStep(2)}
                            disabled={scopeSaving}
                            className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors disabled:opacity-50"
                          >
                            ← Back
                          </button>
                          <button
                            type="button"
                            onClick={finishScope}
                            disabled={scopeSaving}
                            className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                          >
                            {scopeSaving ? "Saving…" : `Finish — ${scopeSections.size} section${scopeSections.size === 1 ? "" : "s"} in scope`}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {projectImportRows && (
                <div className="border-b border-[#E2E8F0] bg-[#F4F5F7]/50">
                  <div className="px-5 py-3 flex items-center justify-between">
                    <div className="text-[13px] font-semibold text-[#0F172A]">
                      Preview — {projectImportRows.length} row{projectImportRows.length !== 1 ? "s" : ""}
                      {projectImportRows.filter(r => !r.name).length > 0 && (
                        <span className="ml-2 text-[12px] font-normal text-amber-400">
                          ({projectImportRows.filter(r => !r.name).length} missing name — will be skipped)
                        </span>
                      )}
                    </div>
                    <button
                      onClick={downloadProjectTemplate}
                      className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors"
                    >
                      Download template
                    </button>
                  </div>
                  <div className="overflow-x-auto max-h-60 overflow-y-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-[#F8F9FA]">
                        <tr className="border-b border-[#E2E8F0]">
                          <th className="text-left px-5 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Name</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">No.</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Location</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">GC</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Architect</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projectImportRows.map((r, i) => (
                          <tr key={i} className={`border-b border-[#E2E8F0]/50 ${!r.name ? "bg-red-500/5" : ""}`}>
                            <td className="px-5 py-2 text-[13px]">
                              {r.name
                                ? <span className="text-[#0F172A]">{r.name}</span>
                                : <span className="text-red-400 italic">missing</span>}
                            </td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.number || <span className="text-[#64748B]">—</span>}</td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.location || <span className="text-[#64748B]">—</span>}</td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.gc_name || <span className="text-[#64748B]">—</span>}</td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.architect || <span className="text-[#64748B]">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-5 py-3 flex items-center justify-between border-t border-[#E2E8F0]">
                    <span className="text-[12px] text-[#64748B]">
                      {projectImportRows.filter(r => r.name).length} of {projectImportRows.length} rows will be imported
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={cancelProjectImport}
                        disabled={projectImporting}
                        className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={confirmProjectImport}
                        disabled={projectImporting || !projectImportRows.filter(r => r.name).length}
                        className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                      >
                        {projectImporting ? "Importing…" : `Import ${projectImportRows.filter(r => r.name).length} project${projectImportRows.filter(r => r.name).length !== 1 ? "s" : ""}`}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {projectImportResult && projectImportResult.errors.length > 0 && (
                <div className="px-5 py-3 border-b border-[#E2E8F0] bg-red-500/5">
                  <p className="text-[12px] font-semibold text-red-400 mb-1">Some rows failed:</p>
                  {projectImportResult.errors.map((e, i) => (
                    <p key={i} className="text-[12px] text-red-400/80">{e}</p>
                  ))}
                </div>
              )}

              {projectsLoading && (
                <div className="px-5 py-4 text-[13px] text-[#64748B]">Loading…</div>
              )}

              {!projectsLoading && projects.length === 0 && !projectImportRows && (
                <div className="px-5 py-6 text-center space-y-2">
                  <p className="text-[13px] text-[#64748B]">No projects yet.</p>
                  <button onClick={downloadProjectTemplate} className="text-[12px] text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors">
                    Download CSV template
                  </button>
                </div>
              )}

              {!projectsLoading && projects.length > 0 && (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[#E2E8F0]">
                      <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Name</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">No.</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Location</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">GC</th>
                      <th className="px-3 py-2.5 w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p, i) => {
                      const expanded = expandedSpecBooks === p.id
                      const sbCount  = specBookCounts[p.id]
                      return (
                      <Fragment key={p.id}>
                      <tr className={`${i < projects.length - 1 && !expanded ? "border-b border-[#E2E8F0]" : ""} hover:bg-[#F4F5F7]/[0.03] transition-colors group`}>
                        <td className="px-5 py-3 text-[13px] font-medium text-[#0F172A]">
                          <div className="flex items-center gap-2">
                            <span>{p.name}</span>
                            {!scopedProjectIds.has(p.id) && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 flex-shrink-0">Scope not set</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-[13px] text-[#64748B]">{p.number ?? <span className="text-[#64748B]">—</span>}</td>
                        <td className="px-3 py-3 text-[13px] text-[#64748B]">{p.location ?? <span className="text-[#64748B]">—</span>}</td>
                        <td className="px-3 py-3 text-[13px] text-[#64748B]">{p.gc_name ?? <span className="text-[#64748B]">—</span>}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5 justify-end">
                            <button
                              onClick={() => setExpandedSpecBooks(expanded ? null : p.id)}
                              className={`text-[11px] font-semibold px-2 py-1 rounded hover:bg-[#F4F5F7]/[0.08] transition-colors whitespace-nowrap flex items-center gap-1 ${expanded ? "text-[#0F172A]" : "text-[#64748B] hover:text-[#0F172A]"}`}
                            >
                              <svg className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                              Spec books{sbCount != null ? ` (${sbCount})` : ""}
                            </button>
                            <button
                              onClick={() => openScopeWizard(p)}
                              className="text-[11px] font-semibold text-[#7B9BB5] hover:text-[#6A8AA4] px-2 py-1 rounded hover:bg-[#F4F5F7]/[0.08] transition-colors whitespace-nowrap"
                            >
                              {scopedProjectIds.has(p.id) ? "Edit scope" : "Set scope"}
                            </button>
                            <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => openEditProject(p)}
                                className="p-1 rounded text-[#64748B] hover:text-[#0F172A] hover:bg-[#F4F5F7]/[0.08] transition-colors"
                                title="Edit"
                              >
                                <PencilIcon />
                              </button>
                              {(currentRole === "admin" || (currentUserId && p.created_by === currentUserId)) && (
                                <button
                                  onClick={() => deleteProject(p)}
                                  className="p-1 rounded text-[#64748B] hover:text-red-400 hover:bg-[#F4F5F7]/[0.08] transition-colors"
                                  title="Delete"
                                >
                                  <XIcon className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={5} className="p-0">
                            <ProjectSpecBooks
                              projectId={p.id}
                              projectName={p.name}
                              onCountChange={n => setSpecBookCounts(c => ({ ...c, [p.id]: n }))}
                            />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {projectMessage && (
              <div className={`text-center text-[13px] ${projectMessage.ok ? "text-[#7B9BB5]" : "text-red-400"}`}>
                {projectMessage.text}
              </div>
            )}
          </div>
        )}

        {activeView === "dir-companies" && (() => {
          // Vendors (unified subs + suppliers) and CMs. The Vendors panel is a
          // self-contained component on the unified vendors master; CMs keeps the
          // generic DirectoryPanel on construction_managers.
          const switcher = (
            <div className="inline-flex rounded-lg border border-[#E2E8F0] bg-white p-0.5">
              {([["vendors", "Vendors"], ["cms", "CMs"]] as [DirEntity, string][]).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setDirEntity(k)}
                  className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                    dirEntity === k ? "bg-[#7B9BB5] text-white" : "text-[#64748B] hover:text-[#0F172A]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )
          if (dirEntity === "vendors") return <VendorsDirectory switcher={switcher} />
          return (
            <DirectoryPanel<ConstructionManager>
              switcher={switcher}
              title="Construction Managers"
              subtitle="Global list of CMs reusable across all projects."
              addLabel="Add CM"
              formTitle={editingCm ? "Edit CM" : "New CM"}
              emptyText="No construction managers yet."
              rows={cms}
              loading={cmsLoading}
              showForm={showCmForm}
              editing={!!editingCm}
              saving={savingCm}
              canSubmit={!!cmForm.company_name.trim()}
              message={cmMessage}
              onAdd={openAddCm}
              onCancel={cancelCmForm}
              onSubmit={saveCm}
              onEdit={openEditCm}
              onDelete={deleteCm}
              fields={[
                { label: "Company Name", required: true, autoFocus: true, value: cmForm.company_name, onChange: v => setCmForm(p => ({ ...p, company_name: v })), placeholder: "e.g. Turner Construction" },
                { label: "Contact Name", value: cmForm.contact_name, onChange: v => setCmForm(p => ({ ...p, contact_name: v })), placeholder: "Jane Smith" },
                { label: "Phone", value: cmForm.phone, onChange: v => setCmForm(p => ({ ...p, phone: v })), placeholder: "555-000-1234" },
                { label: "Email", value: cmForm.email, onChange: v => setCmForm(p => ({ ...p, email: v })), placeholder: "contact@cm.com" },
                { label: "Notes", value: cmForm.notes, onChange: v => setCmForm(p => ({ ...p, notes: v })), placeholder: "Any notes…" },
                { label: "Address", fullWidth: true, value: cmForm.address, onChange: v => setCmForm(p => ({ ...p, address: v })), placeholder: "123 Main St, City, State 00000" },
              ]}
              columns={[
                { header: "Company Name", render: c => c.company_name },
                { header: "Contact", render: c => c.contact_name ?? "—" },
                { header: "Phone", render: c => c.phone ?? "—" },
                { header: "Email", render: c => c.email ?? "—" },
                { header: "Address", render: c => <span className="block max-w-[160px] truncate">{c.address ?? "—"}</span> },
                { header: "Notes", render: c => c.notes ?? "—" },
              ]}
            />
          )
        })()}

        {activeView === "gmail" && (
          <div className="space-y-4">
            {gmailLoading ? (
              <div className="text-[13px] text-[#64748B]">Loading…</div>
            ) : (
              <>
                <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Gmail Integration</h2>
                      <p className="text-[12px] text-[#64748B]">
                        Connect a Gmail account so TuttoHQ can receive submittal files sent to that inbox.
                      </p>
                    </div>
                    <div className={`flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                      gmailConn?.connected
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                        : "bg-[#F4F5F7] border-[#E2E8F0] text-[#64748B]"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${gmailConn?.connected ? "bg-emerald-400" : "bg-[#64748B]"}`} />
                      {gmailConn?.connected ? "Connected" : "Not connected"}
                    </div>
                  </div>

                  {gmailConn?.connected ? (
                    <div className="mt-5 space-y-4">
                      <div className="bg-[#F4F5F7] rounded-lg border border-[#E2E8F0] divide-y divide-[#E2E8F0]">
                        <div className="flex items-center justify-between px-4 py-3">
                          <span className="text-[12px] text-[#64748B]">Connected account</span>
                          <span className="text-[13px] text-[#0F172A] font-medium">{gmailConn.gmail_address}</span>
                        </div>
                        {gmailConn.created_at && (
                          <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-[12px] text-[#64748B]">Connected since</span>
                            <span className="text-[13px] text-[#64748B]">
                              {new Date(gmailConn.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center justify-between px-4 py-3">
                          <span className="text-[12px] text-[#64748B]">Push notifications</span>
                          <div className="flex items-center gap-2">
                            {gmailConn.watch_expiry ? (
                              <span className="text-[13px] text-[#64748B]">
                                active until {new Date(gmailConn.watch_expiry).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              </span>
                            ) : (
                              <span className="text-[13px] text-amber-400">Not active</span>
                            )}
                            <button
                              onClick={renewWatch}
                              disabled={renewingWatch}
                              className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] disabled:opacity-50 transition-colors"
                            >
                              {renewingWatch ? "Setting up…" : gmailConn.watch_expiry ? "Renew" : "Set up"}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <a
                          href="/api/auth/gmail"
                          className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#F4F5F7]/[0.05] transition-colors inline-flex items-center"
                        >
                          Reconnect
                        </a>
                        <button
                          onClick={disconnectGmail}
                          disabled={disconnecting}
                          className="h-8 px-4 rounded-md border border-red-500/30 text-[13px] text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                        >
                          {disconnecting ? "Disconnecting…" : "Disconnect"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-5">
                      <a
                        href="/api/auth/gmail"
                        className="inline-flex items-center gap-2 h-9 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-medium hover:bg-[#6A8AA4] transition-colors"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
                        </svg>
                        Connect Gmail account
                      </a>
                    </div>
                  )}
                </div>

                <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
                  <h2 className="text-[14px] font-semibold text-[#0F172A] mb-3">Setup Instructions</h2>
                  <ol className="space-y-3 text-[13px] text-[#64748B]">
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#7B9BB5]/20 text-[#7B9BB5] text-[11px] font-semibold flex items-center justify-center">1</span>
                      <span>Click <strong className="text-[#0F172A]">Connect Gmail account</strong> above and sign in with the Gmail account you want TuttoHQ to monitor.</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#7B9BB5]/20 text-[#7B9BB5] text-[11px] font-semibold flex items-center justify-center">2</span>
                      <span>Grant the requested permissions — TuttoHQ needs read access to detect incoming submittals and the ability to label or archive processed emails.</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#7B9BB5]/20 text-[#7B9BB5] text-[11px] font-semibold flex items-center justify-center">3</span>
                      <span>
                        In Google Cloud Console, create a Pub/Sub topic and a push subscription. Set the push endpoint to:
                        <code className="block mt-1.5 px-2.5 py-1.5 rounded bg-[#F4F5F7] border border-[#E2E8F0] text-[11px] text-[#0F172A] font-mono break-all">
                          {process.env.NEXT_PUBLIC_APP_URL}/api/gmail-intake?token=<span className="text-[#64748B]">&lt;GMAIL_WEBHOOK_SECRET&gt;</span>
                        </code>
                        Set <code className="text-[#0F172A]">GMAIL_WEBHOOK_SECRET</code> and <code className="text-[#0F172A]">GOOGLE_PUBSUB_TOPIC</code> as environment variables in your deployment.
                      </span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#7B9BB5]/20 text-[#7B9BB5] text-[11px] font-semibold flex items-center justify-center">4</span>
                      <span>Once configured, any email with a PDF or Word attachment sent to the connected Gmail account will be automatically classified and added to the Submittal log.</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#7B9BB5]/20 text-[#7B9BB5] text-[11px] font-semibold flex items-center justify-center">5</span>
                      <span>Push notification subscriptions expire every 7 days. TuttoHQ auto-renews them on each incoming notification — you can also manually renew from the connection details above.</span>
                    </li>
                  </ol>
                </div>
              </>
            )}

            {gmailMessage && (
              <div className={`text-center text-[13px] ${gmailMessage.ok ? "text-[#7B9BB5]" : "text-red-400"}`}>
                {gmailMessage.text}
              </div>
            )}
          </div>
        )}

          </div>
        </div>
      </div>
    </div>
  )
}
