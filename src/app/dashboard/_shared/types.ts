// Shared type definitions for the dashboard.
// Lifted verbatim from dashboard/page.tsx during the module split (Step 0).

export interface SubmittalFile {
  id: string
  file_name: string
  file_url: string
  mime_type: string | null
  file_size: number | null
  created_at: string
  csi_division?: string
  division_name?: string
  csi_section?: string
  section_name?: string
  // Library row context — populated by /api/files so cross-project rows can
  // surface their project + spec_ingestion rows can show submittal_type.
  // Optional because the type is also constructed locally for non-library flows.
  submittal_type?: string | null
  source?: string | null
  project_id?: string | null
}

export interface Section  { code: string; name: string; file_count?: number }
export interface Division { num: string; name: string; sections: Section[]; file_count: number }

export type UploadStep = "file" | "classifying" | "suggested" | "manual" | "naming"
export interface NameOptions { materials: string[]; manufacturers: string[]; dimensions: string[] }
export interface AiResult { division_num: string; division_name: string; section_code: string; section_name: string; material_name?: string | null; manufacturer?: string | null; dimensions?: string | null; confidence?: number; reasoning?: string }

export interface SubmittalRecord {
  id: string
  file_name: string
  storage_path: string | null
  mime_type: string | null
  file_size: number | null
  csi_division: string | null
  division_name: string | null
  csi_section: string | null
  section_name: string | null
  material_name: string | null
  manufacturer: string | null
  dimensions: string | null
  review_status: string | null
  ai_confidence: number | null
  ai_reasoning: string | null
  status: string
  uploaded_by: string
  created_at: string
  project_id: string | null
  sender_email: string | null
  received_at: string | null
  manually_overridden: boolean | null
  overridden_by: string | null
  send_to_type: string | null
  send_to_company: string | null
  send_to_contact: string | null
  send_to_email: string | null
  send_to_phone: string | null
  send_to_address: string | null
  transmitted_by: string | null
  transmitted_by_company: string | null
  generated_pdf_path: string | null
  transmittal_sent_at: string | null
  transmittal_recipient: string | null
  submittal_number: string | null
  revision_number: string | null
  due_date: string | null
  is_critical: boolean | null
  party_required: boolean | null
  copy_to: string | null
  // Submittal-log tracker columns (2026-05-21 overhaul)
  submittal_seq: number | null
  received_date: string | null
  sent_to_ae_date: string | null
  returned_from_ae_date: string | null
  returned_to_sub_date: string | null
  submittal_type: string | null
  vendor_subcontractor_id: string | null
  vendor_supplier_id: string | null
  vendor_subcontractor_person_id: string | null
  vendor_supplier_person_id: string | null
  source: string | null
  spec_section_id: string | null
  // Sub-package workflow (Session I)
  sent_to_sub_date: string | null
  received_via_package_id: string | null
  received_file_name: string | null
  // Inline title edit. When true, normalizer / spec-book re-parse must NOT
  // overwrite file_name — the row carries a human-set label.
  title_locked: boolean | null
}

export type BatchStatus = "pending" | "classifying" | "ready" | "error" | "uploading" | "done" | "upload-error"
export type BatchPhase  = "select" | "classifying" | "review" | "uploading" | "done"
export interface BatchItemDupeMatch {
  same_project_matches: Array<{
    submittal_id: string; file_name: string; submittal_seq: number | null;
    submittal_number: string | null; revision_number: string | null;
  }>
  cross_project_matches: Array<{
    project_id: string | null; project_name: string | null; count: number;
  }>
}
export interface BatchItem { id: string; file: File; status: BatchStatus; divNum: string; divName: string; secCode: string; secName: string; nameMatl: string; nameMfr: string; nameDims: string; customName: string; expanded: boolean; errorMsg?: string; storagePath?: string; fileSha256?: string; dupeMatch?: BatchItemDupeMatch }

export interface Project { id: string; name: string; number: string | null; location: string | null; gc_name: string | null; architect: string | null; short_id?: string | null; base_contract_value?: number | null }
export interface TeamMember { id: string; name: string; title: string | null; email: string | null }
export interface RFI {
  id: string; rfi_number: string; subject: string; description: string | null;
  received_from: string | null; submitted_by: string | null;
  specification_section: string | null; location: string | null;
  schedule_impact: string; cost_impact: string;
  assigned_to: string | null; date_issued: string | null; due_date: string | null;
  status: string; response: string | null; project_id: string | null;
  file_path: string | null; file_name: string | null; generated_pdf_path: string | null;
  created_at: string; uploaded_by: string;
}
export interface ChangeOrder {
  id: string; co_number: string; assigned_co_number: string | null; project_id: string | null; date: string | null;
  proposal: string | null; qualifications: string | null; pricing_sum: number | null; realized_amount: number | null;
  schedule_impact: string; schedule_impact_days: number | null;
  file_path: string | null; file_name: string | null;
  status: string; submitted_by: string | null; assigned_to: string | null;
  generated_pdf_path: string | null; approved_at: string | null;
  created_at: string; uploaded_by: string;
  // PCO builder (Phase 0+). has_pco_detail distinguishes builder-created PCOs
  // (pricing_sum is derived + read-only in the log) from manual log rows.
  has_pco_detail?: boolean; description_of_work?: string | null; oh_p_percent?: number | null; fee_percent?: number | null;
  pco_backup_pdf_path?: string | null; pco_cover_pdf_path?: string | null;
  // 'imported' rows are FROZEN — historical PCOs brought in from legacy
  // workbooks. They render in the log but show no Edit affordance and the
  // server rejects any update.
  origin?: "manual" | "imported";
}
export interface PunchItem { id: string; item_number: string; description: string; location: string | null; assigned_to: string | null; due_date: string | null; priority: string; status: string; notes: string | null; project_id: string | null; created_at: string; completed_at: string | null; uploaded_by: string; generated_pdf_path?: string | null; file_name?: string | null; file_path?: string | null }
export interface DailyReport { id: string; report_date: string; project_id: string | null; prepared_by: string | null; weather_conditions: string | null; temperature: string | null; manpower_count: number | null; work_performed: string | null; equipment: string | null; materials_delivered: string | null; visitors: string | null; issues_delays: string | null; safety_notes: string | null; created_at: string; uploaded_by: string; generated_pdf_path?: string | null; file_name?: string | null; file_path?: string | null }
export interface DrawingRecord { id: string; drawing_number: string; sheet_title: string; discipline: string | null; revision: string; revision_date: string | null; status: string; scale: string | null; notes: string | null; project_id: string | null; is_current: boolean; superseded_at: string | null; created_at: string; uploaded_by: string; generated_pdf_path?: string | null; file_name?: string | null; file_path?: string | null; file_url?: string | null }
export interface CloseoutItem { id: string; project_id: string; category: string; item_type: string; title: string; status: string; assigned_to: string | null; due_date: string | null; file_url: string | null; file_name: string | null; notes: string | null; sort_order: number; folder_name: string | null; linked_record_id: string | null; linked_record_type: string | null; completed_at: string | null; created_at: string }
export interface Commitment {
  id: string
  project_id: string
  type: "subcontract" | "purchase_order"
  to_subcontractor_id: string | null
  to_supplier_id: string | null
  to_company_name: string
  status: "draft" | "out_for_signature" | "executed"
  executed_file_path: string | null
  executed_file_name: string | null
  executed_at: string | null
  contract_value: number | null
  notes: string | null
  created_at: string
  updated_at: string
  uploaded_by: string
}
// Unified vendor master (1,400+ rows). Only the fields the PO module reads.
export interface Vendor {
  id: string
  vendor_no: string | null
  company_name: string
  street_address: string | null
  city: string | null
  state: string | null
  zip_code: string | null
  phone: string | null
}

// A Purchase Order is a commitments row with type = 'purchase_order'.
export interface PurchaseOrder {
  id: string
  project_id: string
  vendor_id: string | null
  to_company_name: string
  po_number: string | null
  cost_code: string | null
  date_required: string | null
  terms: string | null
  ct_tax_treatment: "included" | "exempt" | null
  status: "draft" | "out_for_signature" | "executed" | "accepted"
  contract_value: number | null
  notes: string | null
  // Release-order link: when set, this PO is released against a supplier_contract
  // (its parent). Null = standalone PO (the default). The contract's drawdown
  // (released_to_children) is Σ of its child POs' contract_value — owned by the
  // commitment_balances view, never summed client-side.
  parent_commitment_id: string | null
  // executed_at is reused to hold the accepted date for POs (set when a PO is
  // marked accepted); no dedicated accepted_at column exists.
  executed_at: string | null
  created_at: string
  updated_at: string
  // Attached by the list endpoint from commitment_balances (drawdown display).
  billed_to_date?: number
  remaining_balance?: number
}
export interface PoLineItem {
  id?: string
  line_no?: number
  quantity: number | null
  description: string | null
  unit_price: number | null
}
// An invoice drawn against a PO (commitment_invoices). retainage_amount is 0 for
// POs and not surfaced in the PO invoice UI.
export interface CommitmentInvoice {
  id: string
  invoice_no: string | null
  invoice_date: string | null
  amount: number
  retainage_amount: number
  status: "draft" | "submitted" | "paid"
  created_at: string
}
// Live balance from the commitment_balances view (source of truth — never
// recomputed client-side). For POs, approved_changes/retainage_held are 0.
export interface PoBalance {
  contract_value: number | null
  billed_to_date: number
  remaining_balance: number
  net_paid: number
}

// A Supplier Contract is a commitments row with type = 'supplier_contract'. It
// is the PARENT a purchase_order can be released against (PO.parent_commitment_id
// → this id). The contract's consumption is driven by its child POs, never by
// invoices: released_to_children = Σ(child PO contract_value) and
// contract_remaining = contract_value − released_to_children, both read straight
// from the commitment_balances view (source of truth — never recomputed client-side).
export interface SupplierContract {
  id: string
  project_id: string
  vendor_id: string | null
  to_company_name: string
  contract_value: number | null
  cost_code: string | null
  terms: string | null
  notes: string | null
  status: "draft" | "out_for_signature" | "executed" | "accepted"
  created_at: string
  updated_at: string
  // Attached by the list/detail endpoints from commitment_balances (drawdown).
  released_to_children?: number
  contract_remaining?: number
}
// Live contract-level balance from commitment_balances. For a supplier_contract,
// billed/remaining are not used (the contract does not look at invoices); the
// meaningful numbers are released_to_children + contract_remaining.
export interface SupplierContractBalance {
  contract_value: number | null
  released_to_children: number
  contract_remaining: number
}

export interface SpecBookDoc {
  id: string
  project_id: string
  file_name: string
  file_size_bytes: number | null
  page_count: number | null
  uploaded_at: string
  parse_status: "pending" | "extracting" | "classifying" | "parsed" | "failed"
  parse_progress: number
  parse_error: string | null
  parse_summary: ParseSummary | null
}
export interface SpecSectionRow {
  id: string
  spec_number: string
  spec_title: string
  start_page: number | null
  end_page: number | null
  has_submittals: boolean
}
export interface StagedSubmittal {
  id: string
  spec_section_id: string
  spec_number: string
  letter: string | null
  project_item_name: string
  submittal_type: string
  description: string
  sub_bullets: string[]
  is_selected: boolean
  committed_at: string | null
}
export interface ParseSummary {
  sectionsScoped: number
  sectionsFound: number
  sectionsWithSubmittals: number
  staged: number
}
export interface PendingDoc {
  id: string
  file_name: string
  parse_status: string
  parse_summary: ParseSummary | null
  uploaded_at: string
}
export const SUBMITTAL_TYPE_OPTIONS = [
  "Product Data", "Shop Drawing", "Design Mix", "Sample", "Certification",
  "Warranty", "O&M Manual", "Lab Test", "Attic Stock", "Other",
] as const
export interface SubcontractorRow { id: string; company_name: string; trade: string | null; contact_name?: string | null; email?: string | null }
export interface SupplierRow { id: string; company_name: string; specialty: string | null; contact_name?: string | null; email?: string | null }
// People under a firm (ADR-004 Firm→People). FK → parent firm; company-scoped.
export interface SubcontractorPersonRow { id: string; subcontractor_id: string; name: string | null; email: string | null; phone: string | null; role: string | null }
export interface SupplierPersonRow { id: string; supplier_id: string; name: string | null; email: string | null; phone: string | null; role: string | null }

// ─── Submittal packages (Session I — outbound dispatch) ──────────────────────
export type PackageStatus = "draft" | "dispatched" | "partial_received" | "complete"
export interface SubmittalPackage {
  id: string
  project_id: string
  package_number: string
  vendor_id: string | null
  vendor_type: "subcontractor" | "supplier" | null
  vendor_name_snapshot: string
  sent_to_email: string
  dispatched_at: string | null
  dispatched_by: string | null
  pdf_file_path: string | null
  gmail_thread_id: string | null
  due_date: string | null
  status: PackageStatus
  notes: string | null
  created_at: string
  // Reminder overrides (Session K2). null = inherit company default.
  reminder_cadence_days: number[] | null
  reminder_max_count:    number   | null
  reminder_attach_pdf:   boolean  | null
  reminders_paused:      boolean
  // Aggregates supplied by the list/detail API
  item_count?: number
  received_count?: number
  needs_review_count?: number
}
/** Reminder configuration + observability returned by the detail GET routes. */
export interface PackageReminderSettings {
  effective_cadence:       number[]
  effective_max:           number
  effective_attach:        boolean
  effective_max_reminders: number
  sent_count:              number
  last_sent_at:            string | null
  next_due_at:             string | null
}
/** A package plus its expected items and any inbound replies awaiting PM review. */
export interface SubmittalPackageDetail extends SubmittalPackage {
  items: SubmittalRecord[]
  needs_review: SubmittalRecord[]
  reminder_settings: PackageReminderSettings
}

// ─── Closeout packages (Session K1 — outbound dispatch) ─────────────────────
export interface CloseoutPackage {
  id: string
  project_id: string
  package_number: string
  vendor_id: string | null
  vendor_type: "subcontractor" | "supplier" | null
  vendor_name_snapshot: string
  sent_to_email: string
  dispatched_at: string | null
  dispatched_by: string | null
  pdf_file_path: string | null
  gmail_thread_id: string | null
  due_date: string | null
  status: PackageStatus
  notes: string | null
  created_at: string
  reminder_cadence_days: number[] | null
  reminder_max_count:    number   | null
  reminder_attach_pdf:   boolean  | null
  reminders_paused:      boolean
  item_count?: number
  received_count?: number
  needs_review_count?: number
}
export interface CloseoutPackageInbound {
  id: string
  package_id: string
  file_name: string
  storage_path: string
  mime_type: string | null
  file_size: number | null
  sender_email: string | null
  received_at: string | null
  gmail_message_id: string | null
  status: "pending" | "placed" | "dismissed"
  placed_closeout_item_id: string | null
  placed_at: string | null
  created_at: string
}
export interface CloseoutPackageDetail extends CloseoutPackage {
  items: CloseoutItem[]
  needs_review: CloseoutPackageInbound[]
  reminder_settings: PackageReminderSettings
}
export type FileModalStep = "project" | "coversheet" | "form"
export interface OpenFileCtx { file: SubmittalFile; divNum: string; divName: string; secCode: string; secName: string }
export interface CoverFormData { projectName: string; projectNumber: string; projectLocation: string; gcName: string; architect: string; specSectionNo: string; specSectionTitle: string; description: string; dateSubmitted: string; submittalNo: string; revisionNo: string; dueDate: string; isCritical: boolean; partyRequired: boolean; copyTo: string; reviewedBy: string; certifiedBy: string; notes: string; sendToType: "cm" | "subcontractor" | "supplier" | ""; sendToCompany: string; sendToContact: string; sendToEmail: string; sendToPhone: string; sendToAddress: string; transmittedBy: string; transmittedByCompany: string }
export interface CoverContact { id: string; company_name: string; contact_name: string | null; email: string | null; phone: string | null; address?: string | null }
