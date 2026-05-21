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
}

export type BatchStatus = "pending" | "classifying" | "ready" | "error" | "uploading" | "done" | "upload-error"
export type BatchPhase  = "select" | "classifying" | "review" | "uploading" | "done"
export interface BatchItem { id: string; file: File; status: BatchStatus; divNum: string; divName: string; secCode: string; secName: string; nameMatl: string; nameMfr: string; nameDims: string; customName: string; expanded: boolean; errorMsg?: string }

export interface Project { id: string; name: string; number: string | null; location: string | null; gc_name: string | null; architect: string | null }
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
  id: string; co_number: string; project_id: string | null; date: string | null;
  proposal: string | null; qualifications: string | null; pricing_sum: number | null;
  schedule_impact: string; schedule_impact_days: number | null;
  file_path: string | null; file_name: string | null;
  status: string; submitted_by: string | null; assigned_to: string | null;
  generated_pdf_path: string | null; approved_at: string | null;
  created_at: string; uploaded_by: string;
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
  "Product Data", "Shop Drawing", "Sample", "Certification",
  "Warranty", "O&M Manual", "Lab Test", "Attic Stock", "Other",
] as const
export interface SubcontractorRow { id: string; company_name: string; trade: string | null }
export interface SupplierRow { id: string; company_name: string; specialty: string | null }
export type FileModalStep = "project" | "coversheet" | "form"
export interface OpenFileCtx { file: SubmittalFile; divNum: string; divName: string; secCode: string; secName: string }
export interface CoverFormData { projectName: string; projectNumber: string; projectLocation: string; gcName: string; architect: string; specSectionNo: string; specSectionTitle: string; description: string; dateSubmitted: string; submittalNo: string; revisionNo: string; dueDate: string; isCritical: boolean; partyRequired: boolean; copyTo: string; reviewedBy: string; certifiedBy: string; notes: string; sendToType: "cm" | "subcontractor" | "supplier" | ""; sendToCompany: string; sendToContact: string; sendToEmail: string; sendToPhone: string; sendToAddress: string; transmittedBy: string; transmittedByCompany: string }
export interface CoverContact { id: string; company_name: string; contact_name: string | null; email: string | null; phone: string | null; address?: string | null }
