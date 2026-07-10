"use client";

import React, { useEffect, useRef, useState } from "react";
import "./submittal-coversheet.css";
import { clampLogoScalePct } from "@/lib/logo-scale";

export type StampBox = {
  role: "GC" | "Architect" | "Engineer" | "Subcontractor";
  /** Optional rendered stamp content. Pass null/undefined for empty box. */
  content?: React.ReactNode;
};

/**
 * Persist an inline cover edit. Resolves on success; REJECTS (throws) on
 * failure so the field can revert and surface the error — a failed save must
 * never look like it stuck. The caller writes through the authed, RLS-scoped
 * PATCH /api/submittals/[id] route and re-renders from the updated row.
 */
export type CoverFieldSaver = (value: string) => Promise<void>;

export type SubmittalCoversheetProps = {
  // Branding
  gcLogoUrl?: string;
  gcName?: string;
  /** Per-tenant logo size % (company_settings.logo_scale_pct). Multiplies the
   *  CSS 0.45in base height so the on-screen preview tracks the PDF size intent.
   *  Width cap (1.6in, from .tt-brand__logo) is not scaled. */
  logoScalePct?: number;

  // Project block
  projectName: string;
  projectNumber: string;
  projectLocation: string;

  // Submittal block
  submittalDescription: string;
  specSectionTitle: string;
  specSectionNumber: string;
  submittalNumber: string;
  revisionNumber: string;
  dateSubmitted: string; // formatted MM/DD/YY
  submittalDueDate: string; // formatted MM/DD/YYYY
  criticalSubmittal?: boolean;
  submittalPartyRequired?: boolean;
  copyTo?: string;

  // Stamps (always 4: GC, Architect, Engineer, Subcontractor)
  stamps?: [StampBox, StampBox, StampBox, StampBox];

  // Inline click-to-edit. When a saver is supplied, that (and only that) field
  // becomes editable in place; the value is written back to the submittal row
  // by the saver. Omit both for a plain, read-only render (the default).
  //   editSubmittalDescription → submittals.file_name  (empty rejected)
  //   editSpecSectionTitle     → submittals.section_name
  // Every other field stays read-only regardless.
  editSubmittalDescription?: CoverFieldSaver;
  editSpecSectionTitle?: CoverFieldSaver;

  // Footer
  page?: number;
  totalPages?: number;
  version?: string; // e.g. "1.0"
};

const Field = ({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) => (
  <div className={`tt-field ${wide ? "tt-field--wide" : ""}`}>
    <span className="tt-field__label">{label}</span>
    <span className="tt-field__value">{value}</span>
  </div>
);

/**
 * Click-to-edit variant of Field. Default state is the rendered value; clicking
 * it turns the value into an input. On Enter/blur it commits via `onSave`; on
 * Escape it cancels. An unchanged value is a no-op (no PATCH). When
 * `allowEmpty` is false an empty value is rejected inline (never saved) —
 * mirrors the file_name server guard so the client blocks it before the round
 * trip. A rejected save reverts the draft and shows the error.
 */
const EditableField = ({
  label,
  value,
  wide = false,
  onSave,
  allowEmpty = true,
  emptyError = "This field cannot be empty.",
}: {
  label: string;
  value: string;
  wide?: boolean;
  onSave: CoverFieldSaver;
  allowEmpty?: boolean;
  emptyError?: string;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the draft in sync with the row value whenever we're not mid-edit
  // (e.g. after a successful save re-renders the parent with fresh data).
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function commit() {
    if (saving) return;
    const next = draft.trim();
    if (!allowEmpty && next.length === 0) {
      setError(emptyError);
      inputRef.current?.focus();
      return;
    }
    if (next === value.trim()) {
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(value);
    setError(null);
    setEditing(false);
  }

  return (
    <div className={`tt-field ${wide ? "tt-field--wide" : ""}`}>
      <span className="tt-field__label">
        {label}
        <span className="tt-field__edit-hint"> · click to edit</span>
      </span>
      {editing ? (
        <>
          <input
            ref={inputRef}
            className="tt-field__input"
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              else if (e.key === "Escape") { e.preventDefault(); cancel(); }
            }}
            aria-label={label}
            aria-invalid={error ? true : undefined}
          />
          {error && <span className="tt-field__error" role="alert">{error}</span>}
        </>
      ) : (
        <button
          type="button"
          className="tt-field__value tt-field__value--editable"
          onClick={() => setEditing(true)}
          title="Click to edit — writes back to the submittal log"
        >
          {value || <span className="tt-field__placeholder">—</span>}
        </button>
      )}
    </div>
  );
};

const Checkbox = ({
  label,
  checked,
}: {
  label: string;
  checked?: boolean;
}) => (
  <div className="tt-checkbox">
    <span className={`tt-checkbox__box ${checked ? "is-checked" : ""}`} />
    <span className="tt-checkbox__label">{label}</span>
  </div>
);

const StampCell = ({ stamp }: { stamp: StampBox }) => (
  <div className="tt-stamp" data-role={stamp.role}>
    {stamp.content ? (
      stamp.content
    ) : (
      <span className="tt-stamp__placeholder">
        {stamp.role} Stamp
      </span>
    )}
  </div>
);

export default function SubmittalCoversheet({
  gcLogoUrl,
  gcName,
  logoScalePct,
  projectName,
  projectNumber,
  projectLocation,
  submittalDescription,
  specSectionTitle,
  specSectionNumber,
  submittalNumber,
  revisionNumber,
  dateSubmitted,
  submittalDueDate,
  criticalSubmittal = false,
  submittalPartyRequired = false,
  copyTo = "",
  stamps,
  editSubmittalDescription,
  editSpecSectionTitle,
  page = 1,
  totalPages = 1,
  version = "1.0",
}: SubmittalCoversheetProps) {
  const defaultStamps: [StampBox, StampBox, StampBox, StampBox] = [
    { role: "GC" },
    { role: "Architect" },
    { role: "Engineer" },
    { role: "Subcontractor" },
  ];
  const resolvedStamps = stamps ?? defaultStamps;

  return (
    <article className="tt-coversheet" role="document">
      {/* Header */}
      <header className="tt-header">
        <h1 className="tt-title">Submittal Coversheet</h1>
        <div className="tt-brand">
          {gcLogoUrl ? (
            <img
              src={gcLogoUrl}
              alt={gcName ?? "General Contractor"}
              className="tt-brand__logo"
              style={{ maxHeight: `${(0.45 * (clampLogoScalePct(logoScalePct) / 100)).toFixed(3)}in` }}
            />
          ) : (
            <span className="tt-brand__name">{gcName ?? ""}</span>
          )}
        </div>
      </header>

      {/* Project block */}
      <section className="tt-block tt-block--project">
        <Field label="Project Name" value={projectName} wide />
        <Field label="Project Number" value={projectNumber} wide />
        <Field label="Project Location" value={projectLocation} wide />
      </section>

      {/* Submittal block */}
      <section className="tt-block tt-block--submittal">
        {editSubmittalDescription ? (
          <EditableField
            label="Submittal Description"
            value={submittalDescription}
            wide
            onSave={editSubmittalDescription}
            allowEmpty={false}
            emptyError="A description is required."
          />
        ) : (
          <Field label="Submittal Description" value={submittalDescription} wide />
        )}
        {editSpecSectionTitle ? (
          <EditableField
            label="Spec Section Title"
            value={specSectionTitle}
            wide
            onSave={editSpecSectionTitle}
          />
        ) : (
          <Field label="Spec Section Title" value={specSectionTitle} wide />
        )}

        <div className="tt-row">
          <Field label="Spec Section No." value={specSectionNumber} />
          <Field label="Submittal No." value={submittalNumber} />
          <Field label="Revision No." value={revisionNumber} />
        </div>

        <div className="tt-row">
          <Field label="Date Submitted" value={dateSubmitted} />
          <Field label="Submittal Due Date" value={submittalDueDate} />
        </div>

        <div className="tt-row tt-row--checks">
          <Checkbox label="Critical Submittal" checked={criticalSubmittal} />
          <Checkbox
            label="Submittal Party Required"
            checked={submittalPartyRequired}
          />
        </div>

        <Field label="Copy To" value={copyTo} wide />
      </section>

      {/* Stamp grid */}
      <section className="tt-stamps" aria-label="Review stamps">
        {resolvedStamps.map((s, i) => (
          <StampCell key={`${s.role}-${i}`} stamp={s} />
        ))}
      </section>

      {/* Footer */}
      <footer className="tt-footer">
        <span className="tt-footer__generated">
          Generated by TuttoHQ
        </span>
        <span className="tt-footer__page">
          {page} / {totalPages}
        </span>
        <span className="tt-footer__version">v. {version}</span>
      </footer>
    </article>
  );
}
