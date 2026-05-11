import { google } from "googleapis"

function getClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  })
  return google.drive({ version: "v3", auth })
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  webViewLink: string
  modifiedTime: string
  size: string | null
}

export interface DriveFolder {
  id: string
  name: string
}

function escapeQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

// List immediate subfolder children of a parent folder, sorted by name
export async function listFolders(parentId: string): Promise<DriveFolder[]> {
  const drive = getClient()
  const res = await drive.files.list({
    q:        `'${escapeQuery(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields:   "files(id, name)",
    orderBy:  "name",
    pageSize: 100,
  })
  return (res.data.files ?? []) as DriveFolder[]
}

// List non-folder files directly inside a folder, sorted by name
export async function listFilesInFolder(folderId: string): Promise<DriveFile[]> {
  const drive = getClient()
  const res = await drive.files.list({
    q:        `'${escapeQuery(folderId)}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
    fields:   "files(id, name, mimeType, webViewLink, modifiedTime, size)",
    orderBy:  "name",
    pageSize: 200,
  })
  return (res.data.files ?? []) as DriveFile[]
}

// Search across all files accessible to the service account.
// No folder filter needed — the service account is only shared on the Submittals
// folder, so it can only see files within that tree.
export async function searchFiles(query: string): Promise<DriveFile[]> {
  const drive  = getClient()
  const parts: string[] = [
    "trashed = false",
    "mimeType != 'application/vnd.google-apps.folder'",
  ]

  if (query.trim()) {
    const q = escapeQuery(query.trim())
    parts.push(`(name contains '${q}' or fullText contains '${q}')`)
  }

  const res = await drive.files.list({
    q:        parts.join(" and "),
    fields:   "files(id, name, mimeType, webViewLink, modifiedTime, size)",
    orderBy:  "modifiedTime desc",
    pageSize: 100,
  })

  return (res.data.files ?? []) as DriveFile[]
}
