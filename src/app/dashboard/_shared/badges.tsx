// Status/priority badge components lifted verbatim from dashboard/page.tsx during the module split (Step 0).

const STATUS_STYLES: Record<string, string> = {
  "Received":               "bg-blue-100 text-blue-700",
  "Under Review":           "bg-amber-100 text-amber-700",
  "Approved":               "bg-green-100 text-green-700",
  "Approved with Comments": "bg-blue-100 text-blue-700",
  "Rejected":               "bg-red-100 text-red-700",
  "Revise and Resubmit":    "bg-amber-100 text-amber-700",
  "Needs Review":           "bg-amber-100 text-amber-700",
  "Transmitted":            "bg-purple-100 text-purple-700",
}
export function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? "bg-gray-100 text-gray-500"
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{status}</span>
}

const RFI_STATUS_STYLES: Record<string, string> = {
  "Open":         "bg-blue-100 text-blue-700",
  "Under Review": "bg-amber-100 text-amber-700",
  "Answered":     "bg-blue-100 text-blue-700",
  "Closed":       "bg-green-100 text-green-700",
  "Void":         "bg-gray-100 text-gray-500",
}
export function RfiStatusBadge({ status }: { status: string }) {
  const cls = RFI_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-500"
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{status}</span>
}

const PUNCH_STATUS_STYLES: Record<string, string> = {
  "Open":        "bg-blue-100 text-blue-700",
  "In Progress": "bg-amber-100 text-amber-700",
  "Completed":   "bg-green-100 text-green-700",
  "Void":        "bg-gray-100 text-gray-500",
}
const PUNCH_PRIORITY_STYLES: Record<string, string> = {
  "Low":      "bg-gray-100 text-gray-500",
  "Medium":   "bg-blue-100 text-blue-700",
  "High":     "bg-amber-100 text-amber-700",
  "Critical": "bg-red-100 text-red-700",
}
export function PunchStatusBadge({ status }: { status: string }) {
  const cls = PUNCH_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-500"
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{status}</span>
}
export function PunchPriorityBadge({ priority }: { priority: string }) {
  const cls = PUNCH_PRIORITY_STYLES[priority] ?? "bg-gray-100 text-gray-500"
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{priority}</span>
}

const DRAWING_STATUS_STYLES: Record<string, string> = {
  "Issued for Construction": "bg-green-100 text-green-700",
  "Issued for Bid":          "bg-blue-100 text-blue-700",
  "Issued for Review":       "bg-amber-100 text-amber-700",
  "Record Drawings":         "bg-blue-100 text-blue-700",
  "Superseded":              "bg-gray-100 text-gray-500",
  "Void":                    "bg-red-100 text-red-700",
}
export function DrawingStatusBadge({ status }: { status: string }) {
  const cls = DRAWING_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-500"
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{status}</span>
}
