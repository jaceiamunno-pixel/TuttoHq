"use client"

import { useEffect, useState } from "react"

// Renders an IndexedDB-stored photo via a short-lived object URL.
// Decoupled from any server URL — this is the proof that the draft UI
// reads from local-first storage, not from /api/photos.

interface DraftPhotoThumbProps {
  blob: Blob
  alt: string
  className?: string
}

export function DraftPhotoThumb({ blob, alt, className }: DraftPhotoThumbProps) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [blob])

  if (!url) return null
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className={className} />
}
