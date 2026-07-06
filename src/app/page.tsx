"use client"

import { useState, useRef, useEffect } from "react"
import Link from "next/link"
import { motion, useInView, AnimatePresence } from "framer-motion"
import {
  CheckCircle2, XCircle, ChevronDown, ArrowRight,
  Folder, Mail, Bot, FileText, HelpCircle, DollarSign,
  CheckSquare, ClipboardList, LayoutGrid, Users, Building2,
  Package, Zap, Star, Lock, BookOpen, Layers,
  Receipt, Upload,
} from "lucide-react"

// ── Animation helper ──────────────────────────────────────────────────────────

function FadeUp({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode
  delay?: number
  className?: string
}) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: "-60px" })
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 28 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

// ── Navbar ────────────────────────────────────────────────────────────────────

function Navbar() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20)
    window.addEventListener("scroll", handler, { passive: true })
    return () => window.removeEventListener("scroll", handler)
  }, [])

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-[#060b18]/85 backdrop-blur-xl border-b border-[#1e2d4a]/80 shadow-2xl"
          : "bg-transparent"
      }`}
    >
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#7B9BB5] flex items-center justify-center flex-shrink-0">
            <FileText className="w-4 h-4 text-white" />
          </div>
          <span className="text-[16px] font-bold text-[#f0f4ff] tracking-tight">TuttoHQ</span>
        </div>

        <div className="hidden md:flex items-center gap-8">
          {[
            { label: "Features", href: "#features" },
            { label: "Pricing", href: "#pricing" },
            { label: "FAQ", href: "#faq" },
          ].map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-[14px] text-[#8b9ab5] hover:text-[#e8edf5] transition-colors"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="hidden sm:inline-flex text-[14px] text-[#8b9ab5] hover:text-[#e8edf5] px-4 py-1.5 rounded-lg border border-[#1e2d4a] hover:border-[#2a3347] transition-all"
          >
            Sign In
          </Link>
          <Link
            href="/demo"
            className="text-[13px] font-bold text-white px-4 py-2 rounded-lg bg-[#7B9BB5] hover:bg-[#6A8AA4] transition-colors shadow-lg shadow-[#7B9BB5]/30"
          >
            See the live demo
          </Link>
        </div>
      </nav>
    </header>
  )
}

// ── Dashboard mockup ──────────────────────────────────────────────────────────

function DashboardMockup() {
  return (
    <div className="relative w-full max-w-5xl mx-auto mt-16">
      <div className="absolute inset-x-0 -top-10 h-48 bg-gradient-to-b from-[#7B9BB5]/15 via-[#7B9BB5]/8 to-transparent blur-3xl pointer-events-none -z-10" />

      <motion.div
        initial={{ opacity: 0, y: 48, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.9, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="rounded-2xl border border-[#1e2d4a]/80 bg-[#0c1526] shadow-[0_40px_80px_rgba(0,0,0,0.6)] overflow-hidden"
      >
        {/* Window chrome */}
        <div className="flex items-center gap-2 px-4 py-3 bg-[#08101e] border-b border-[#1e2d4a]/60">
          <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <div className="w-3 h-3 rounded-full bg-[#28c840]" />
          <div className="flex-1 mx-4">
            <div className="w-52 h-5 rounded-md bg-[#0f1629] mx-auto flex items-center justify-center">
              <span className="text-[10px] text-[#3d506a]">app.tuttohq.com/dashboard</span>
            </div>
          </div>
        </div>

        {/* App layout */}
        <div className="flex h-[400px] sm:h-[480px]">
          {/* Sidebar */}
          <div className="hidden sm:flex w-52 bg-[#08101e] border-r border-[#1e2d4a]/60 flex-col py-3 px-2 gap-0.5">
            <div className="px-3 py-2 mb-3">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded bg-[#7B9BB5] flex items-center justify-center flex-shrink-0">
                  <FileText className="w-3 h-3 text-white" />
                </div>
                <span className="text-[12px] font-bold text-[#e8edf5]">TuttoHQ</span>
              </div>
            </div>
            {[
              { icon: Folder, label: "Submittals", active: true },
              { icon: HelpCircle, label: "RFIs", active: false },
              { icon: DollarSign, label: "Change Orders", active: false },
              { icon: CheckSquare, label: "Punch List", active: false },
              { icon: ClipboardList, label: "Daily Reports", active: false },
              { icon: LayoutGrid, label: "Drawings", active: false },
            ].map(({ icon: Icon, label, active }) => (
              <div
                key={label}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg ${
                  active ? "bg-[#7B9BB5]/15 text-[#7B9BB5]" : "text-[#3d506a]"
                }`}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-[11px] font-medium">{label}</span>
              </div>
            ))}
            <div className="mt-5 px-3">
              <div className="text-[9px] font-bold text-[#3d506a] uppercase tracking-widest mb-2">
                CSI Divisions
              </div>
              {["07 Thermal & Moisture", "08 Openings", "09 Finishes"].map((d) => (
                <div key={d} className="text-[10px] text-[#3d506a] py-1.5 hover:text-[#8b9ab5] cursor-default">
                  {d}
                </div>
              ))}
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1e2d4a]/60 bg-[#0c1526]">
              <div className="flex-1 flex items-center gap-2 bg-[#08101e] rounded-lg px-3 py-1.5 border border-[#1e2d4a]/60">
                <span className="text-[11px] text-[#3d506a]">Search submittals with AI...</span>
              </div>
              <div className="px-3 py-1.5 rounded-lg bg-[#7B9BB5] flex-shrink-0">
                <span className="text-[10px] font-bold text-white">+ Upload</span>
              </div>
            </div>

            <div className="flex-1 overflow-hidden p-4">
              <div className="grid grid-cols-3 gap-3 mb-4">
                {[
                  { label: "Total Submittals", value: "147" },
                  { label: "Pending Review", value: "12" },
                  { label: "This Month", value: "34" },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="bg-[#0f1a2e] rounded-xl p-3 border border-[#1e2d4a]/60"
                  >
                    <div className="text-[20px] font-extrabold text-[#e8edf5] leading-none">
                      {s.value}
                    </div>
                    <div className="text-[9px] text-[#3d506a] mt-1">{s.label}</div>
                  </div>
                ))}
              </div>

              <div className="bg-[#08101e] rounded-xl border border-[#1e2d4a]/60 overflow-hidden">
                <div className="flex items-center gap-3 px-3 py-2 border-b border-[#1e2d4a]/40">
                  <span className="flex-1 text-[9px] font-bold text-[#3d506a] uppercase tracking-wider">
                    File Name
                  </span>
                  <span className="w-24 hidden md:block text-[9px] font-bold text-[#3d506a] uppercase tracking-wider">
                    CSI Section
                  </span>
                  <span className="w-16 text-[9px] font-bold text-[#3d506a] uppercase tracking-wider">
                    Status
                  </span>
                </div>
                {[
                  {
                    name: "Owens Corning R-30 Insulation Shop Drawings.pdf",
                    section: "07 20 00",
                    status: "Approved",
                    conf: 98,
                  },
                  {
                    name: "Pella Windows Series 250 Submittal.pdf",
                    section: "08 50 00",
                    status: "Pending",
                    conf: 95,
                  },
                  {
                    name: "Armstrong Ceilings Submittal Package.pdf",
                    section: "09 50 00",
                    status: "Approved",
                    conf: 99,
                  },
                  {
                    name: "Schlage Door Hardware Schedule.pdf",
                    section: "08 70 00",
                    status: "Review",
                    conf: 91,
                  },
                  {
                    name: "USG Sheetrock Drywall Systems.pdf",
                    section: "09 20 00",
                    status: "Approved",
                    conf: 97,
                  },
                ].map((row, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-3 py-2.5 border-b border-[#1e2d4a]/20 hover:bg-[#0f1a2e]/60"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-[#c8d3e8] truncate">{row.name}</div>
                      <div className="text-[9px] text-[#3d506a] mt-0.5">
                        AI classified · {row.conf}% confidence
                      </div>
                    </div>
                    <div className="w-24 hidden md:block text-[9px] font-mono text-[#7B9BB5]">
                      {row.section}
                    </div>
                    <div
                      className={`w-16 text-[9px] font-bold rounded-full px-2 py-0.5 text-center ${
                        row.status === "Approved"
                          ? "bg-emerald-500/15 text-emerald-400"
                          : row.status === "Pending"
                          ? "bg-amber-500/15 text-amber-400"
                          : "bg-blue-500/15 text-blue-400"
                      }`}
                    >
                      {row.status}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

// ── Features data ─────────────────────────────────────────────────────────────

// The three differentiators — the moat. Rendered large, up top.
const HERO_FEATURES = [
  {
    icon: Bot,
    title: "AI Submittal Library",
    desc: "Drag a submittal in, upload it, or email it over — TuttoHQ reads each one, classifies it by CSI MasterFormat division and section with a confidence score, and files it automatically. Anything it's unsure about is flagged for human review, never silently guessed.",
  },
  {
    icon: BookOpen,
    title: "Spec Book Ingestion",
    desc: "Upload a project's spec book and TuttoHQ parses it into a structured submittal log, organized by CSI section — so your log is built before the first submittal even arrives.",
  },
  {
    icon: Layers,
    title: "Drawing Log + In-App Markup",
    desc: "Upload a full drawing set and TuttoHQ auto-splits it into sheets. Browse by discipline (A / S / M / E / P…), search by sheet number or title, view in your browser, mark sheets up, and save markups as new revisions — with every prior revision preserved.",
  },
]

// Everything else, equal weight.
const GRID_FEATURES = [
  {
    icon: HelpCircle,
    title: "RFI Tracking",
    desc: "Create, assign, and track RFIs. Know exactly who has the ball — and never miss a due date.",
  },
  {
    icon: DollarSign,
    title: "Change Order Management",
    desc: "Build and track change orders and PCOs with running contract totals. Import historical change orders preserving each source document's stated totals.",
  },
  {
    icon: Receipt,
    title: "Purchase Orders & Commitments",
    desc: "Issue POs, set supplier contract values, and draw down each contract with release orders. See contract-remaining at a glance.",
  },
  {
    icon: Upload,
    title: "Bulk Import of Approved Submittals",
    desc: "Bring an in-progress project's existing signed submittals in at once. Each is logged exactly as-is, with a clean copy filed to your library.",
  },
  {
    icon: CheckSquare,
    title: "Punch List",
    desc: "Create, assign, and close punch items by trade. Export to PDF for walkthroughs.",
  },
  {
    icon: ClipboardList,
    title: "Daily Reports",
    desc: "Log crew, weather, delays, and site photos. Works offline on-site and syncs when you reconnect. Export to PDF.",
  },
  {
    icon: FileText,
    title: "One-Click Branded PDFs",
    desc: "Generate branded submittal packages, RFI responses, change orders, and PO documents on your company letterhead — in one click.",
  },
  {
    icon: Building2,
    title: "Project Management",
    desc: "Organize every document, RFI, CO, and PO by project.",
  },
  {
    icon: Users,
    title: "Team Directory",
    desc: "Add your team and assign work by name.",
  },
  {
    icon: Package,
    title: "Batch Import",
    desc: "Import your projects and team members from a CSV in seconds. No manual data entry.",
  },
]

const COMPARISON_ROWS: {
  feature: string
  tutto: boolean | string
  legacy: boolean | string
}[] = [
  { feature: "Submittal Management", tutto: true, legacy: true },
  { feature: "RFI Tracking", tutto: true, legacy: true },
  { feature: "Change Order Management", tutto: true, legacy: true },
  { feature: "Purchase Orders & Commitments", tutto: true, legacy: true },
  { feature: "Punch List", tutto: true, legacy: true },
  { feature: "Daily Reports", tutto: true, legacy: true },
  { feature: "Drawing Log + In-App Markup", tutto: true, legacy: true },
  { feature: "AI Submittal Classification", tutto: true, legacy: false },
  { feature: "Spec Book Auto-Ingestion", tutto: true, legacy: false },
  { feature: "Bulk Import of Approved Submittals", tutto: true, legacy: false },
  { feature: "One-Click Branded PDFs", tutto: true, legacy: false },
  { feature: "Setup Time", tutto: "Under 10 minutes", legacy: "4–6 weeks" },
  { feature: "Training Required", tutto: "None", legacy: "Extensive" },
  {
    feature: "Pricing",
    tutto: "Talk to us",
    legacy: "Heavyweight enterprise licensing",
  },
  { feature: "Built For", tutto: "General contractors", legacy: "Enterprise IT departments" },
  { feature: "Contract Required", tutto: "No", legacy: "Yes" },
]

// Values rendered in red in the legacy column (the "cost" of the heavyweight path).
const LEGACY_NEGATIVES = [
  "4–6 weeks",
  "Extensive",
  "Yes",
  "Heavyweight enterprise licensing",
  "Enterprise IT departments",
]

const FAQS = [
  {
    q: "We already use a big enterprise platform. Is it worth switching?",
    a: "If you're paying for a heavyweight enterprise platform and still managing some documents in email, yes. TuttoHQ takes minutes to set up. Start with the live demo, then run it alongside your current tools and decide.",
  },
  {
    q: "What if my team is not tech savvy?",
    a: "If they can use email they can use TuttoHQ. There is no training required. The interface is intentionally simple.",
  },
  {
    q: "Do I have to import all my old data?",
    a: "No. Start fresh with new projects going forward — or move a live project over with bulk import of approved submittals and CSV import for projects and team. You can add historical data at any time.",
  },
  {
    q: "How do I get started?",
    a: "Start with the live demo to see how it works on a real project, then reach out and we'll get your company set up.",
  },
  {
    q: "Is my data secure?",
    a: "All data is stored in Supabase with row-level security. Files are stored in private encrypted buckets. We never share or sell your data.",
  },
  {
    q: "Can I email submittals in?",
    a: "Yes. Email intake is one of several ways to get documents in — alongside drag-and-drop upload, spec book ingestion, and bulk import. Files land in your library classified and ready.",
  },
  {
    q: "What if I need a feature you do not have?",
    a: "Email us. We ship fast. Features requested by customers get built first.",
  },
]

// ── FAQ Accordion ─────────────────────────────────────────────────────────────

function FAQAccordion() {
  const [open, setOpen] = useState<number | null>(null)

  return (
    <div className="space-y-3">
      {FAQS.map((faq, i) => (
        <FadeUp key={i} delay={i * 0.04}>
          <div className="rounded-xl border border-[#1e2d4a]/80 bg-[#0c1526] overflow-hidden">
            <button
              onClick={() => setOpen(open === i ? null : i)}
              className="w-full flex items-center justify-between px-6 py-5 text-left gap-4"
            >
              <span className="text-[15px] font-semibold text-[#e8edf5]">{faq.q}</span>
              <ChevronDown
                className={`w-5 h-5 text-[#4f617a] flex-shrink-0 transition-transform duration-200 ${
                  open === i ? "rotate-180" : ""
                }`}
              />
            </button>
            <AnimatePresence initial={false}>
              {open === i && (
                <motion.div
                  key="body"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <div className="px-6 pb-6 pt-4 text-[14px] text-[#8b9ab5] leading-relaxed border-t border-[#1e2d4a]/60">
                    {faq.a}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </FadeUp>
      ))}
    </div>
  )
}

// ── Schema JSON-LD ────────────────────────────────────────────────────────────

const SCHEMA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: "TuttoHQ",
      description:
        "TuttoHQ is construction document management software for general contractors. It reads and classifies submittals with AI by CSI MasterFormat division, ingests project spec books into a structured submittal log, manages a drawing log with an in-app viewer and markup, and tracks RFIs, change orders, purchase orders, punch lists, and daily reports — with one-click branded PDFs.",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: "https://tuttohq.com",
    },
    {
      "@type": "Organization",
      name: "TuttoHQ",
      url: "https://tuttohq.com",
      description:
        "TuttoHQ provides construction document management software for general contractors, including AI submittal classification, spec book ingestion, a markup-ready drawing log, RFI tracking, change order and purchase order management, punch lists, and daily reports.",
    },
    {
      "@type": "FAQPage",
      mainEntity: FAQS.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ],
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(SCHEMA) }}
      />

      <div className="min-h-screen bg-[#060b18] text-[#e8edf5] overflow-x-hidden">
        <Navbar />

        {/* ═══ HERO ═══════════════════════════════════════════════════════════ */}
        <section className="relative min-h-screen flex flex-col justify-center pt-16 overflow-hidden">
          {/* Background radials */}
          <div className="absolute inset-0 pointer-events-none select-none">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[700px] rounded-full bg-[#7B9BB5]/7 blur-[130px]" />
            <div className="absolute bottom-0 right-0 w-[500px] h-[500px] rounded-full bg-[#1e3a6e]/15 blur-[100px]" />
          </div>

          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 lg:py-36">
            <div className="text-center max-w-4xl mx-auto">
              {/* Badge */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#7B9BB5]/10 border border-[#7B9BB5]/25 text-[13px] text-[#7B9BB5] font-semibold mb-8"
              >
                <Zap className="w-3.5 h-3.5" />
                Built with a working commercial GC
              </motion.div>

              {/* H1 */}
              <motion.h1
                initial={{ opacity: 0, y: 28 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.65, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
                className="text-4xl sm:text-5xl lg:text-[64px] font-extrabold tracking-tight leading-[1.07] text-[#f0f4ff] mb-6"
              >
                Run your whole project in{" "}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#7B9BB5] to-[#7B9BB5]">
                  one place
                </span>
                .
              </motion.h1>

              {/* Subheadline */}
              <motion.p
                initial={{ opacity: 0, y: 28 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.65, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="text-[17px] sm:text-[19px] text-[#8b9ab5] leading-relaxed mb-10 max-w-3xl mx-auto"
              >
                Submittals, spec books, drawings, RFIs, change orders, POs, and daily reports —{" "}
                <strong className="text-[#e8edf5]">every document your job runs on</strong>, in one
                place. <strong className="text-[#e8edf5]">Built with a working commercial GC</strong>, not enterprise IT.
              </motion.p>

              {/* CTAs */}
              <motion.div
                initial={{ opacity: 0, y: 28 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.65, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-10"
              >
                <Link
                  href="/demo"
                  className="w-full sm:w-auto px-8 py-4 rounded-xl bg-[#7B9BB5] hover:bg-[#6A8AA4] text-white text-[15px] font-bold transition-all duration-200 shadow-xl shadow-[#7B9BB5]/25 hover:shadow-[#7B9BB5]/40 hover:scale-[1.02]"
                >
                  See the live demo
                </Link>
                <a
                  href="#features"
                  className="flex items-center gap-2 text-[15px] text-[#8b9ab5] hover:text-[#e8edf5] transition-colors group"
                >
                  See what&apos;s inside{" "}
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </a>
              </motion.div>

              {/* Trust signals */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6, delay: 0.45 }}
                className="flex flex-wrap justify-center gap-x-6 gap-y-2"
              >
                {[
                  "See it live — no signup",
                  "Built with a working GC",
                  "Every module in one place",
                  "Set up in minutes",
                ].map((t) => (
                  <div key={t} className="flex items-center gap-1.5 text-[13px] text-emerald-500">
                    <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                    {t}
                  </div>
                ))}
              </motion.div>

              {/* Dashboard mockup */}
              <DashboardMockup />
            </div>
          </div>
        </section>

        {/* ═══ VALUE STATEMENT ═════════════════════════════════════════════════ */}
        <section className="border-y border-[#1e2d4a]/40 bg-[#08101e]/70 py-12">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <FadeUp>
              <p className="text-[16px] sm:text-[18px] text-[#8b9ab5] leading-relaxed">
                Built for the general contractors who would rather run jobs than wrangle software —
                the affordable alternative to heavyweight enterprise construction platforms, with
                <strong className="text-[#e8edf5]"> every document module your project needs</strong> in
                one place.
              </p>
            </FadeUp>
          </div>
        </section>

        {/* ═══ PAIN SECTION ════════════════════════════════════════════════════ */}
        <section className="py-24 lg:py-36">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <FadeUp className="text-center mb-16">
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#f0f4ff] tracking-tight">
                If Any of This Sounds Familiar, Keep Reading
              </h2>
            </FadeUp>

            <div className="grid md:grid-cols-3 gap-6 mb-10">
              {[
                {
                  emoji: "📁",
                  text: "You're forwarding submittal emails to a shared folder and calling it a system. Someone submitted the wrong version last week and nobody caught it.",
                },
                {
                  emoji: "📧",
                  text: "Your RFIs are in three different email threads, a spreadsheet, and someone's head. You found out an RFI was overdue when the sub called you angry.",
                },
                {
                  emoji: "💸",
                  text: "Your change orders are in Excel. You're not sure if CO-014 was approved or just sent. Your contract value is a guess.",
                },
              ].map((card, i) => (
                <FadeUp key={i} delay={i * 0.1}>
                  <div className="relative rounded-2xl border border-[#7f1d1d]/30 bg-[#180a0a]/50 p-7 h-full">
                    <div className="absolute inset-x-0 top-0 h-[2px] rounded-t-2xl bg-gradient-to-r from-transparent via-[#ef4444]/30 to-transparent" />
                    <div className="text-3xl mb-5 leading-none">{card.emoji}</div>
                    <p className="text-[15px] text-[#c8a8a8] leading-relaxed">{card.text}</p>
                  </div>
                </FadeUp>
              ))}
            </div>

            <FadeUp delay={0.1}>
              <div className="rounded-2xl border border-[#1e2d4a]/60 bg-[#0c1526] p-8 text-center max-w-4xl mx-auto">
                <p className="text-[18px] sm:text-[20px] font-bold text-[#e8edf5] leading-relaxed">
                  This is not a workflow problem. This is a{" "}
                  <span className="text-[#ff6b6b]">revenue problem</span>. Missed submittals delay
                  projects. Unanswered RFIs create claims. Untracked change orders leave money on
                  the table.
                </p>
              </div>
            </FadeUp>
          </div>
        </section>

        {/* ═══ FEATURES ════════════════════════════════════════════════════════ */}
        <section id="features" className="py-24 lg:py-36 bg-[#08101e]/60">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <FadeUp className="text-center mb-4">
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#f0f4ff] tracking-tight mb-4">
                One Platform. Every Document. Zero Chaos.
              </h2>
              <p className="text-[17px] text-[#8b9ab5] max-w-2xl mx-auto">
                It starts with three things no spreadsheet or inbox can do:
              </p>
            </FadeUp>

            {/* Hero features — the differentiators */}
            <div className="grid lg:grid-cols-3 gap-5 mt-14">
              {HERO_FEATURES.map((f, i) => (
                <FadeUp key={f.title} delay={i * 0.08}>
                  <div className="group relative h-full rounded-2xl border border-[#7B9BB5]/25 bg-gradient-to-b from-[#0e1a30] to-[#0c1526] p-7 hover:border-[#7B9BB5]/50 transition-all duration-300 overflow-hidden">
                    <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#7B9BB5]/50 to-transparent" />
                    <div className="w-12 h-12 rounded-xl bg-[#7B9BB5]/15 border border-[#7B9BB5]/30 flex items-center justify-center mb-5 group-hover:bg-[#7B9BB5]/25 transition-colors">
                      <f.icon className="w-6 h-6 text-[#7B9BB5]" />
                    </div>
                    <h3 className="text-[18px] font-bold text-[#f0f4ff] mb-2.5">{f.title}</h3>
                    <p className="text-[14px] text-[#8b9ab5] leading-relaxed">{f.desc}</p>
                  </div>
                </FadeUp>
              ))}
            </div>

            {/* Everything else */}
            <FadeUp className="text-center mt-20 mb-2">
              <h3 className="text-[22px] sm:text-[26px] font-extrabold text-[#e8edf5] tracking-tight">
                Plus every document module your project needs
              </h3>
            </FadeUp>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5 mt-10">
              {GRID_FEATURES.map((f, i) => (
                <FadeUp key={f.title} delay={(i % 6) * 0.06}>
                  <div className="group rounded-xl border border-[#1e2d4a]/60 bg-[#0c1526] p-6 h-full hover:border-[#7B9BB5]/40 transition-all duration-300">
                    <div className="w-10 h-10 rounded-xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4 group-hover:bg-[#7B9BB5]/20 transition-colors">
                      <f.icon className="w-5 h-5 text-[#7B9BB5]" />
                    </div>
                    <h3 className="text-[15px] font-bold text-[#e8edf5] mb-2">{f.title}</h3>
                    <p className="text-[13px] text-[#8b9ab5] leading-relaxed">{f.desc}</p>
                  </div>
                </FadeUp>
              ))}
            </div>
          </div>
        </section>

        {/* ═══ HOW IT WORKS ════════════════════════════════════════════════════ */}
        <section className="py-24 lg:py-36">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <FadeUp className="text-center mb-16">
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#f0f4ff] tracking-tight mb-4">
                Set Up In Under 10 Minutes.{" "}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#7B9BB5] to-[#7B9BB5]">
                  Here Is Exactly How It Works.
                </span>
              </h2>
            </FadeUp>

            <div className="space-y-2">
              {[
                {
                  n: "1",
                  title: "Create your account and add your company logo",
                  time: "2 minutes",
                },
                {
                  n: "2",
                  title: "Import your projects and team from a CSV — or add them by hand",
                  time: "2 minutes",
                },
                {
                  n: "3",
                  title: "Upload a spec book — TuttoHQ parses it into a submittal log by CSI section",
                  time: "1 upload",
                },
                {
                  n: "4",
                  title: "Add submittals, drawing sets, and approved docs — upload, email them in, or bulk import",
                  time: "A few clicks",
                },
                {
                  n: "5",
                  title: "Watch your library, drawing log, and RFI / CO / PO tracking stay current as work comes in",
                  time: "Forever",
                },
              ].map((step, i) => (
                <FadeUp key={i} delay={i * 0.09}>
                  <div className="flex items-start gap-5 group">
                    <div className="flex flex-col items-center flex-shrink-0">
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#7B9BB5]/25 to-[#1e3a6e]/40 border border-[#7B9BB5]/30 flex items-center justify-center group-hover:from-[#7B9BB5]/35 transition-all">
                        <span className="text-[20px] font-extrabold text-[#7B9BB5]">{step.n}</span>
                      </div>
                      {i < 4 && (
                        <div className="w-[2px] h-8 bg-gradient-to-b from-[#2a3347] to-transparent mt-1" />
                      )}
                    </div>
                    <div className="flex-1 pt-3 pb-2">
                      <div className="flex items-start sm:items-center justify-between gap-4 flex-col sm:flex-row">
                        <h3 className="text-[16px] font-semibold text-[#e8edf5]">{step.title}</h3>
                        <span className="text-[12px] font-bold text-[#7B9BB5] bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 px-3 py-1 rounded-full flex-shrink-0">
                          {step.time}
                        </span>
                      </div>
                    </div>
                  </div>
                </FadeUp>
              ))}
            </div>

            <FadeUp delay={0.1}>
              <p className="mt-12 text-center text-[14px] text-[#4f617a] flex items-center justify-center gap-2">
                <Mail className="w-4 h-4" />
                Prefer email? Submittals emailed in are read, classified, and filed automatically too.
              </p>
            </FadeUp>
          </div>
        </section>

        {/* ═══ COMPARISON TABLE ════════════════════════════════════════════════ */}
        <section className="py-24 lg:py-36 bg-[#08101e]/60">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <FadeUp className="text-center mb-4">
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#f0f4ff] tracking-tight mb-4">
                TuttoHQ vs. Legacy Enterprise Platforms
              </h2>
              <p className="text-[16px] text-[#8b9ab5] max-w-2xl mx-auto">
                We are not for every contractor. We are for contractors who want a system that works
                without a 6-month implementation.
              </p>
            </FadeUp>

            <FadeUp delay={0.1}>
              <div className="mt-14 rounded-2xl border border-[#1e2d4a]/70 overflow-hidden">
                <div className="grid grid-cols-3 bg-[#08101e] border-b border-[#1e2d4a]/60">
                  <div className="px-5 py-5 text-[12px] font-bold text-[#3d506a] uppercase tracking-wider">
                    Feature
                  </div>
                  <div className="px-5 py-5 text-center border-l border-[#1e2d4a]/60">
                    <div className="text-[15px] font-extrabold text-[#7B9BB5]">TuttoHQ</div>
                    <div className="text-[11px] text-[#3d506a] mt-0.5">Built for GCs</div>
                  </div>
                  <div className="px-5 py-5 text-center border-l border-[#1e2d4a]/60">
                    <div className="text-[14px] font-bold text-[#4f617a]">Legacy Enterprise Platform</div>
                    <div className="text-[11px] text-[#3d506a] mt-0.5">Built for enterprise IT</div>
                  </div>
                </div>

                {COMPARISON_ROWS.map((row, i) => (
                  <div
                    key={i}
                    className={`grid grid-cols-3 border-b border-[#1e2d4a]/25 last:border-0 ${
                      i % 2 === 0 ? "bg-[#0c1526]" : "bg-[#0a1020]/50"
                    }`}
                  >
                    <div className="px-5 py-4 text-[14px] text-[#c8d3e8]">{row.feature}</div>
                    <div className="px-5 py-4 flex items-center justify-center text-center border-l border-[#1e2d4a]/25">
                      {typeof row.tutto === "boolean" ? (
                        row.tutto ? (
                          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                        ) : (
                          <XCircle className="w-5 h-5 text-[#ef4444]/60" />
                        )
                      ) : (
                        <span className="text-[13px] font-bold text-emerald-400">{row.tutto}</span>
                      )}
                    </div>
                    <div className="px-5 py-4 flex items-center justify-center text-center border-l border-[#1e2d4a]/25">
                      {typeof row.legacy === "boolean" ? (
                        row.legacy ? (
                          <CheckCircle2 className="w-5 h-5 text-[#4f617a]" />
                        ) : (
                          <XCircle className="w-5 h-5 text-[#ef4444]/60" />
                        )
                      ) : (
                        <span
                          className={`text-[13px] font-semibold ${
                            LEGACY_NEGATIVES.includes(row.legacy)
                              ? "text-[#f87171]"
                              : "text-[#4f617a]"
                          }`}
                        >
                          {row.legacy}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </FadeUp>

            <FadeUp delay={0.15}>
              <div className="mt-8 rounded-xl border border-[#1e2d4a]/40 bg-[#0c1526] p-6 text-center">
                <p className="text-[15px] text-[#8b9ab5] leading-relaxed">
                  <strong className="text-[#e8edf5]">
                    Heavyweight enterprise platforms are built for firms
                  </strong>{" "}
                  with dedicated IT teams and 6-figure software budgets.{" "}
                  <strong className="text-[#e8edf5]">
                    TuttoHQ is built for the GC who needs it to work on Monday morning.
                  </strong>
                </p>
              </div>
            </FadeUp>
          </div>
        </section>

        {/* ═══ PRICING ═════════════════════════════════════════════════════════ */}
        <section id="pricing" className="py-24 lg:py-36">
          <div className="max-w-xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <FadeUp>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#f0f4ff] tracking-tight mb-4">
                See it, then let&apos;s talk pricing.
              </h2>
            </FadeUp>

            <FadeUp delay={0.1}>
              <div className="mt-12 relative">
                <div className="absolute inset-0 bg-gradient-to-b from-[#7B9BB5]/20 via-[#7B9BB5]/5 to-transparent rounded-3xl blur-3xl -z-10" />
                <div className="rounded-3xl border border-[#7B9BB5]/35 bg-[#0c1526] p-8 sm:p-12 relative overflow-hidden">
                  {/* Subtle top gradient */}
                  <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#7B9BB5]/60 to-transparent" />

                  <div className="inline-flex items-center gap-1.5 px-4 py-1 rounded-full bg-[#7B9BB5]/15 border border-[#7B9BB5]/25 text-[12px] font-bold text-[#7B9BB5] mb-8">
                    <Star className="w-3 h-3 fill-[#7B9BB5]" />
                    The affordable, full-featured platform
                  </div>

                  <p className="text-[16px] text-[#8b9ab5] leading-relaxed mb-10">
                    Take a look at the live demo, then reach out — we&apos;ll talk through what fits
                    your team.
                  </p>

                  <div className="grid sm:grid-cols-2 gap-3 mb-10 text-left">
                    {[
                      "AI submittal classification",
                      "Spec book ingestion",
                      "Drawing log with markup",
                      "Every document module your project needs",
                      "Branded PDF generation",
                      "New features as they ship",
                    ].map((item) => (
                      <div key={item} className="flex items-center gap-2.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                        <span className="text-[14px] text-[#c8d3e8]">{item}</span>
                      </div>
                    ))}
                  </div>

                  <Link
                    href="/demo"
                    className="block w-full py-4 rounded-xl bg-[#7B9BB5] hover:bg-[#6A8AA4] text-white text-[16px] font-bold transition-all duration-200 shadow-xl shadow-[#7B9BB5]/25 hover:shadow-[#7B9BB5]/40 hover:scale-[1.01]"
                  >
                    See the live demo
                  </Link>
                  <a
                    href="mailto:hello@tuttohq.com?subject=TuttoHQ%20pricing"
                    className="mt-3 inline-flex items-center justify-center gap-2 w-full py-3.5 rounded-xl border border-[#7B9BB5]/35 text-[15px] font-semibold text-[#c8d3e8] hover:bg-[#7B9BB5]/10 hover:border-[#7B9BB5]/50 transition-all"
                  >
                    <Mail className="w-4 h-4" />
                    Talk to us about pricing
                  </a>
                </div>
              </div>
            </FadeUp>

            <FadeUp delay={0.15}>
              <div className="mt-8 rounded-2xl border border-[#1e2d4a]/40 bg-[#08101e]/70 p-6">
                <p className="text-[15px] text-[#8b9ab5] leading-relaxed">
                  To put this in perspective:{" "}
                  <strong className="text-[#e8edf5]">
                    One missed submittal that delays a project costs more than a year of TuttoHQ.
                  </strong>{" "}
                  One unanswered RFI that becomes a claim costs more than a decade of it.
                </p>
              </div>
            </FadeUp>
          </div>
        </section>

        {/* ═══ FAQ ═════════════════════════════════════════════════════════════ */}
        <section id="faq" className="py-24 lg:py-36 bg-[#08101e]/60">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <FadeUp className="text-center mb-16">
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#f0f4ff] tracking-tight mb-4">
                You Probably Have Questions.{" "}
                <span className="text-[#8b9ab5]">Here Are The Honest Answers.</span>
              </h2>
            </FadeUp>
            <FAQAccordion />
          </div>
        </section>

        {/* ═══ FINAL CTA ═══════════════════════════════════════════════════════ */}
        <section className="py-24 lg:py-36 relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none select-none">
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#7B9BB5]/5 to-transparent" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[500px] rounded-full bg-[#7B9BB5]/8 blur-[100px]" />
          </div>

          <div className="relative max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <FadeUp>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-[#f0f4ff] tracking-tight mb-5">
                Every Week You Wait Is Another Week Of Submittal Chaos
              </h2>
              <p className="text-[17px] text-[#8b9ab5] mb-10 leading-relaxed">
                Your competitors are already automating this. See the whole platform live — no
                signup, nothing to install.
              </p>
              <Link
                href="/demo"
                className="inline-block px-10 py-5 rounded-xl bg-[#7B9BB5] hover:bg-[#6A8AA4] text-white text-[17px] font-bold transition-all duration-200 shadow-2xl shadow-[#7B9BB5]/25 hover:shadow-[#7B9BB5]/40 hover:scale-[1.02] mb-12"
              >
                See the live demo
              </Link>

              <div className="flex flex-wrap justify-center gap-x-8 gap-y-4">
                {[
                  { icon: Lock, text: "Your data is encrypted and private" },
                  { icon: CheckCircle2, text: "No signup to look around" },
                  { icon: Building2, text: "Built with a working GC, for GCs" },
                  { icon: Zap, text: "Set up in minutes" },
                ].map(({ icon: Icon, text }) => (
                  <div key={text} className="flex items-center gap-2 text-[13px] text-[#4f617a]">
                    <Icon className="w-4 h-4" />
                    {text}
                  </div>
                ))}
              </div>
            </FadeUp>
          </div>
        </section>

        {/* ═══ FOOTER ══════════════════════════════════════════════════════════ */}
        <footer className="border-t border-[#1e2d4a]/40 bg-[#060b18] py-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col md:flex-row items-center justify-between gap-6 mb-8">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[#7B9BB5] flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-white" />
                </div>
                <div>
                  <div className="text-[15px] font-bold text-[#e8edf5]">TuttoHQ</div>
                  <div className="text-[12px] text-[#3d506a]">
                    Construction document management. Finally simple.
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap justify-center gap-6">
                {[
                  { label: "Features", href: "#features" },
                  { label: "Pricing", href: "#pricing" },
                  { label: "FAQ", href: "#faq" },
                  { label: "Privacy Policy", href: "/privacy" },
                  { label: "Terms of Service", href: "/terms" },
                  { label: "Contact", href: "mailto:hello@tuttohq.com" },
                ].map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    className="text-[13px] text-[#3d506a] hover:text-[#8b9ab5] transition-colors"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>

            <div className="border-t border-[#1e2d4a]/30 pt-6 text-center">
              <p className="text-[12px] text-[#3d506a]">
                © 2026 TuttoHQ. All rights reserved.
              </p>
            </div>
          </div>
        </footer>
      </div>
    </>
  )
}
