import type { Metadata } from "next"
import Link from "next/link"

// Offline navigation fallback (ADR-009 Phase 1). The service worker precaches
// this document and serves it for any protected navigation that misses BOTH
// the network and the page cache — i.e. a network-only module (Library / RFIs /
// COs / Punch / Drawings / Closeout) opened cold in a dead zone. The daily-
// report flow and the dashboard, once primed online, serve their own cached
// shell and never land here.
//
// Deliberately a static, data-free render: no server fetch, no auth — it must
// be precacheable as a plain document and resolvable with zero network.
export const metadata: Metadata = {
  title: "Offline — TuttoHQ",
  robots: { index: false, follow: false },
}

export default function OfflinePage() {
  return (
    <main className="min-h-[100dvh] flex flex-col items-center justify-center bg-[#0A1628] text-white px-6 text-center">
      <div className="max-w-sm">
        <p className="text-[18px] font-bold tracking-tight">TuttoHQ</p>
        <div className="mt-8 mb-5 flex justify-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.08] border border-white/10">
            <svg className="h-6 w-6 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728M5.636 18.364a9 9 0 010-12.728m12.728 0L5.636 18.364M12 12h.01" />
            </svg>
          </span>
        </div>
        <h1 className="text-[20px] font-semibold">You&rsquo;re offline</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[#94A3B8]">
          This tool needs a connection to load. Daily reports you started will keep
          working and will sync once you&rsquo;re back online.
        </p>
        <Link
          href="/dashboard"
          className="mt-7 inline-flex h-10 items-center justify-center rounded-lg bg-[#7B9BB5] px-5 text-[13px] font-semibold text-white transition-colors hover:bg-[#6A8AA4]"
        >
          Try again
        </Link>
      </div>
    </main>
  )
}
