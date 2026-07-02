import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Terms of Service — TuttoHQ",
  description:
    "The terms that govern your use of TuttoHQ, construction document-management software for general contractors.",
}

// Static marketing/legal page. Server component — no "use client", no data
// fetching. Sets its own dark full-height background because the global body
// background (globals.css / layout) is the light app theme.
export default function TermsOfServicePage() {
  return (
    <main className="min-h-screen bg-[#060b18] text-[#8b9ab5] antialiased">
      <div className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-[#7B9BB5] transition-colors hover:text-[#a9c0d6]"
        >
          <span aria-hidden="true">←</span> Back to home
        </Link>

        <h1 className="mt-10 text-3xl font-semibold tracking-tight text-[#f0f4ff] sm:text-4xl">
          Terms of Service
        </h1>
        <p className="mt-3 text-sm text-[#6b7a95]">Last updated: July 2026</p>

        <p className="mt-8 text-[15px] leading-7">
          These Terms govern your use of TuttoHQ (&ldquo;the service&rdquo;). By
          using the service, you agree to these Terms. Questions:{" "}
          <a
            href="mailto:support@tuttohq.com"
            className="text-[#7B9BB5] transition-colors hover:text-[#a9c0d6]"
          >
            support@tuttohq.com
          </a>
          .
        </p>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-[#f0f4ff]">The service</h2>
          <p className="mt-4 text-[15px] leading-7">
            TuttoHQ provides construction document-management software, including
            submittal tracking, drawing logs, RFIs, change orders, purchase
            orders, daily reports, and related tools. We may add, change, or
            remove features over time.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-[#f0f4ff]">Your account</h2>
          <p className="mt-4 text-[15px] leading-7">
            You are responsible for maintaining the confidentiality of your
            account credentials and for all activity under your account. You must
            provide accurate information and are responsible for keeping it
            current. You must be authorized to act on behalf of the company you
            register.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-[#f0f4ff]">Your content</h2>
          <p className="mt-4 text-[15px] leading-7">
            You retain ownership of the documents, data, and materials you upload
            (&ldquo;your content&rdquo;). You grant us the limited rights
            necessary to store, process, and display your content solely to
            provide the service to you — including processing content through our
            AI provider to generate the outputs you request. You are responsible
            for ensuring you have the rights to the content you upload.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-[#f0f4ff]">Acceptable use</h2>
          <p className="mt-4 text-[15px] leading-7">
            You agree not to use the service to upload unlawful content, infringe
            others&rsquo; intellectual property, attempt to breach security or
            access data that is not yours, or interfere with the operation of the
            platform.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-[#f0f4ff]">
            Intellectual property and copyright (DMCA)
          </h2>
          <p className="mt-4 text-[15px] leading-7">
            We respect intellectual property rights and expect users to do the
            same. If you believe content on the service infringes your copyright,
            send a notice to our designated agent at{" "}
            <a
              href="mailto:dmca@tuttohq.com"
              className="text-[#7B9BB5] transition-colors hover:text-[#a9c0d6]"
            >
              dmca@tuttohq.com
            </a>{" "}
            including: (1) your physical or electronic signature; (2)
            identification of the copyrighted work claimed to be infringed; (3)
            identification of the material claimed to be infringing and
            information reasonably sufficient to locate it; (4) your contact
            information; (5) a statement that you have a good-faith belief the use
            is not authorized by the copyright owner, its agent, or the law; and
            (6) a statement, under penalty of perjury, that the information in
            your notice is accurate and that you are the copyright owner or
            authorized to act on the owner&rsquo;s behalf. We will respond to
            valid notices, including by removing infringing material, and we may
            terminate the accounts of repeat infringers.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-[#f0f4ff]">
            Service availability
          </h2>
          <p className="mt-4 text-[15px] leading-7">
            We work to keep the service available and reliable, but we provide it
            &ldquo;as is&rdquo; and do not guarantee uninterrupted or error-free
            operation. We may perform maintenance, modify, or suspend parts of the
            service as needed.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-[#f0f4ff]">
            Disclaimers and limitation of liability
          </h2>
          <p className="mt-4 text-[15px] leading-7">
            To the fullest extent permitted by law, the service is provided
            without warranties of any kind, and TuttoHQ is not liable for
            indirect, incidental, or consequential damages arising from your use
            of the service. Nothing in these Terms limits liability that cannot be
            limited under applicable law.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-[#f0f4ff]">Termination</h2>
          <p className="mt-4 text-[15px] leading-7">
            You may stop using the service at any time. We may suspend or
            terminate access for violation of these Terms or to protect the
            service and its users.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-[#f0f4ff]">
            Changes to these Terms
          </h2>
          <p className="mt-4 text-[15px] leading-7">
            We may update these Terms from time to time. Material changes will be
            reflected by the &ldquo;Last updated&rdquo; date above; continued use
            after changes means you accept the updated Terms.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-semibold text-[#f0f4ff]">Contact</h2>
          <p className="mt-4 text-[15px] leading-7">
            Questions about these Terms:{" "}
            <a
              href="mailto:support@tuttohq.com"
              className="text-[#7B9BB5] transition-colors hover:text-[#a9c0d6]"
            >
              support@tuttohq.com
            </a>
          </p>
        </section>
      </div>
    </main>
  )
}
