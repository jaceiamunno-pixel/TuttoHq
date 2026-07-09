// Dependency-free "stored" (uncompressed) ZIP writer for the browser. PDFs are
// already compressed, so storing (no deflate) costs ~nothing in size and keeps
// this tiny and dependency-free — no package.json / lockfile change. Not ZIP64;
// fine for the file counts and sizes a transmittal package produces.
//
// Used by "Download all": browsers block firing N separate downloads from one
// click, so we fetch each signed file and bundle them into one .zip.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry { name: string; bytes: Uint8Array }

/** Build a stored (uncompressed) ZIP Blob from the given entries. */
export function buildZip(entries: ZipEntry[]): Blob {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const crc = crc32(e.bytes)
    const size = e.bytes.length

    const lh = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header sig
    lv.setUint16(4, 20, true)         // version needed
    lv.setUint16(6, 0x0800, true)     // flags: UTF-8 filename
    lv.setUint16(8, 0, true)          // method: stored
    lv.setUint16(10, 0, true)         // mod time
    lv.setUint16(12, 0, true)         // mod date
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)      // compressed size == size
    lv.setUint32(22, size, true)      // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)         // extra length
    lh.set(nameBytes, 30)
    parts.push(lh, e.bytes)

    const ch = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true) // central dir header sig
    cv.setUint16(4, 20, true)         // version made by
    cv.setUint16(6, 20, true)         // version needed
    cv.setUint16(8, 0x0800, true)     // flags: UTF-8
    cv.setUint16(10, 0, true)         // method: stored
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)         // extra length
    cv.setUint16(32, 0, true)         // comment length
    cv.setUint16(34, 0, true)         // disk number start
    cv.setUint16(36, 0, true)         // internal attrs
    cv.setUint32(38, 0, true)         // external attrs
    cv.setUint32(42, offset, true)    // local header offset
    ch.set(nameBytes, 46)
    central.push(ch)

    offset += lh.length + size
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)   // end of central dir sig
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)

  return new Blob([...parts, ...central, eocd] as unknown as BlobPart[], { type: "application/zip" })
}

/** Trigger a browser download of a Blob. */
export function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Fetch each signed URL and download them bundled as one .zip. */
export async function downloadFilesAsZip(
  files: Array<{ name: string; url: string }>,
  zipName: string,
): Promise<void> {
  const entries: ZipEntry[] = []
  for (const f of files) {
    const res = await fetch(f.url)
    if (!res.ok) throw new Error(`Could not fetch ${f.name}`)
    entries.push({ name: f.name, bytes: new Uint8Array(await res.arrayBuffer()) })
  }
  triggerDownload(buildZip(entries), zipName)
}
