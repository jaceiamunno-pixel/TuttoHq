-- ADR-016 v1a: RFQ / Sub Bid Request — manual send + manual quote-attach.
-- Applied to prod 2026-07-07 via SQL Editor. Committed as file after the fact.
-- Depends on 0029 (estimate_lines) for the accepted-quote landing FK.
-- Careful-lane: new tables + RLS + tenant isolation. LINKAGE LAW: spec by spec_number TEXT.
begin;

create table public.rfqs (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  company_id     uuid not null default get_my_company_id(),
  name           text not null,
  scope_description text,
  division_code  text,
  due_date       date,
  status         text not null default 'draft'
                   check (status in ('draft','sent','closed')),
  package_pdf_path text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index rfqs_project_idx on public.rfqs(project_id);
create index rfqs_company_idx on public.rfqs(company_id);

create table public.rfq_recipients (
  id                uuid primary key default gen_random_uuid(),
  rfq_id            uuid not null references public.rfqs(id) on delete cascade,
  company_id        uuid not null default get_my_company_id(),
  vendor_id         uuid not null references public.vendors(id) on delete restrict,
  vendor_person_id  uuid references public.vendor_people(id) on delete set null,
  sent_at           timestamptz,
  state             text not null default 'sent'
                      check (state in ('sent','quote_received','no_response','declined')),
  quote_file_path   text,
  quoted_amount     numeric(14,2),
  linked_estimate_line_id uuid references public.estimate_lines(id) on delete set null,
  notes             text,
  created_at        timestamptz not null default now()
);
create index rfq_recipients_rfq_idx on public.rfq_recipients(rfq_id);
create index rfq_recipients_company_idx on public.rfq_recipients(company_id);
create index rfq_recipients_vendor_idx on public.rfq_recipients(vendor_id);

do $$
declare t text;
begin
  foreach t in array array['rfqs','rfq_recipients']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($p$create policy %I on public.%I for select using (company_id = get_my_company_id());$p$, t||'_sel', t);
    execute format($p$create policy %I on public.%I for insert with check (company_id = get_my_company_id());$p$, t||'_ins', t);
    execute format($p$create policy %I on public.%I for update using (company_id = get_my_company_id()) with check (company_id = get_my_company_id());$p$, t||'_upd', t);
    execute format($p$create policy %I on public.%I for delete using (company_id = get_my_company_id());$p$, t||'_del', t);
    execute format($p$create policy %I on public.%I as restrictive for insert with check (not is_demo_user());$p$, t||'_demo_ins', t);
    execute format($p$create policy %I on public.%I as restrictive for update using (not is_demo_user()) with check (not is_demo_user());$p$, t||'_demo_upd', t);
    execute format($p$create policy %I on public.%I as restrictive for delete using (not is_demo_user());$p$, t||'_demo_del', t);
  end loop;
end $$;

commit;
