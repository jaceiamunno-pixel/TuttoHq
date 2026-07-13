// Per-tenant transmittal "Send via Email" template + mailto builder.
//
// The app never sends mail. On a transmittal package's download page the user
// clicks "Send via Email", which opens their OWN mail client via a mailto: URL
// with a prefilled subject/body (attachments stay manual — mailto can't attach;
// full Postmark send is a separate parked project). Merge fields are resolved
// SYNCHRONOUSLY at click time from already-loaded package data so the mailto can
// fire inside the click gesture — an await before window.location.href lets the
// browser drop the navigation (see the RFQ v1a Send handoff for the same rule).
//
// Storage: company_settings.transmittal_email_subject_template /
// transmittal_email_body_template (nullable TEXT; NULL → the defaults below).
// See migration 0042_transmittal_email_template.sql.

export const DEFAULT_TRANSMITTAL_EMAIL_SUBJECT =
  "Submittal Package {package_name} — {project}"

export const DEFAULT_TRANSMITTAL_EMAIL_BODY =
  `Hi,

Please find attached submittal package {package_name} for {project}, covering sections {sections}.

Let me know if you have any questions.

Thanks,
{user_name}`

// The supported merge fields, for the Settings legend. `token` is what the user
// types into the template; `label` describes the value substituted at send time.
export const TRANSMITTAL_MERGE_FIELDS: { token: string; label: string }[] = [
  { token: "{project}",      label: "Project name" },
  { token: "{package_name}", label: "Package name / number" },
  { token: "{sections}",     label: "Spec section numbers in the package" },
  { token: "{submittals}",   label: "Submittal titles in the package" },
  { token: "{vendor}",       label: "Recipient firm name (blank if none)" },
  { token: "{user_name}",    label: "Your name" },
  { token: "{date}",         label: "Today's date" },
]

export interface TransmittalMergeFields {
  project: string
  package_name: string
  sections: string
  submittals: string
  vendor: string
  user_name: string
  date: string
}

// Replace {field} tokens case-insensitively from `fields`. UNKNOWN tokens are
// left verbatim (a typo'd or future placeholder survives rather than vanishing).
export function resolveTemplate(template: string, fields: Record<string, string>): string {
  const lower: Record<string, string> = {}
  for (const k of Object.keys(fields)) lower[k.toLowerCase()] = fields[k]
  return template.replace(/\{([a-zA-Z_]+)\}/g, (match, key: string) => {
    const k = key.toLowerCase()
    return k in lower ? lower[k] : match
  })
}

// Keep the whole mailto: URL under this many chars — some OS mail handlers
// silently truncate very long URLs. When a long {submittals} list would blow
// past it, that list is shortened to "… (+N more)".
const MAX_MAILTO_LEN = 1800

// Build the mailto: URL. `to` may be empty (valid — opens a blank To:).
// `submittalTitles` is the source list behind the {submittals} field; if the
// full list makes the URL too long, only that list is truncated (every other
// field is left intact).
export function buildTransmittalMailto(opts: {
  to: string
  subjectTemplate: string
  bodyTemplate: string
  fields: TransmittalMergeFields
  submittalTitles: string[]
}): string {
  const { to, subjectTemplate, bodyTemplate, fields, submittalTitles } = opts

  const make = (submittalsStr: string): string => {
    const f = { ...fields, submittals: submittalsStr }
    const subject = resolveTemplate(subjectTemplate, f)
    const body = resolveTemplate(bodyTemplate, f)
    return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  let url = make(fields.submittals)
  if (url.length <= MAX_MAILTO_LEN) return url

  // Drop items from the end until it fits, always leaving a "(+N more)" tail.
  for (let keep = submittalTitles.length - 1; keep >= 0; keep--) {
    const more = submittalTitles.length - keep
    const shown = submittalTitles.slice(0, keep)
    const truncated = [...shown, `… (+${more} more)`].join(", ")
    url = make(truncated)
    if (url.length <= MAX_MAILTO_LEN) return url
  }
  // Even an empty list didn't fit (a huge subject/other field) — best effort.
  return url
}
