-- ADR-015 Phase A: estimation-as-hub core schema + recalculate_estimate().
-- Applied to prod 2026-07-07 via SQL Editor. Committed as file after the fact.
-- Careful-lane: money math, new tables, RLS, SECURITY DEFINER function.
-- LINKAGE LAW: spec linkage by spec_number TEXT; spec_section_id FK nullable/decorative (SET NULL).
-- NOTE: the anon-execute revoke correction lives in 0029b (run immediately after this).
begin;

create table public.company_bid_defaults (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null default get_my_company_id(),
  overhead_pct       numeric(5,4) not null default 0.10,
  profit_pct         numeric(5,4) not null default 0.10,
  labor_burden_pct   numeric(5,4),
  material_tax_exempt boolean not null default true,
  equip_material_tax_rate numeric(5,4),
  bond_pct           numeric(5,4),
  permit_basis_note  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_id)
);

create table public.gc_template_items (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default get_my_company_id(),
  description  text not null,
  category     text not null default 'other'
    check (category in ('labor','material','subcontractor','equipment','other')),
  default_qty  numeric(14,4),
  default_unit text,
  default_unit_cost numeric(14,2),
  sort_order   integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.estimates (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  company_id    uuid not null default get_my_company_id(),
  name          text not null,
  status        text not null default 'draft' check (status in ('draft','finalized')),
  overhead_pct  numeric(5,4),
  profit_pct    numeric(5,4),
  labor_burden_pct numeric(5,4),
  material_tax_exempt boolean not null default true,
  equip_material_tax_rate numeric(5,4),
  fee_pct       numeric(5,4),
  bond_pct      numeric(5,4),
  permit_amount numeric(14,2) not null default 0,
  sqft          numeric(14,2),
  total_direct        numeric(14,2) not null default 0,
  total_burden        numeric(14,2) not null default 0,
  total_tax           numeric(14,2) not null default 0,
  total_fee           numeric(14,2) not null default 0,
  total_bond          numeric(14,2) not null default 0,
  total_bid           numeric(14,2) not null default 0,
  cost_per_sf         numeric(14,2),
  defaults_incomplete boolean not null default false,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index estimates_project_idx on public.estimates(project_id);
create index estimates_company_idx on public.estimates(company_id);

create table public.estimate_lines (
  id            uuid primary key default gen_random_uuid(),
  estimate_id   uuid not null references public.estimates(id) on delete cascade,
  company_id    uuid not null default get_my_company_id(),
  cost_code     text,
  spec_number   text,
  spec_section_id uuid references public.spec_sections(id) on delete set null,
  source        text not null default 'manual'
    check (source in ('spec_book','takeoff','gc_template','manual')),
  description   text,
  category      text not null default 'other'
    check (category in ('labor','material','subcontractor','equipment','other')),
  qty_reg  numeric(14,4), rate_reg numeric(14,2),
  qty_ot   numeric(14,4), rate_ot  numeric(14,2),
  qty_dt   numeric(14,4), rate_dt  numeric(14,2),
  material_qty numeric(14,4), material_unit text, material_unit_price numeric(14,2),
  amount   numeric(14,2),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index estimate_lines_estimate_idx on public.estimate_lines(estimate_id);
create index estimate_lines_company_idx  on public.estimate_lines(company_id);
create index estimate_lines_cost_code_idx on public.estimate_lines(company_id, cost_code);
create index estimate_lines_spec_number_idx on public.estimate_lines(spec_number);

do $$
declare t text;
begin
  foreach t in array array['company_bid_defaults','gc_template_items','estimates','estimate_lines']
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

create or replace function public.recalculate_estimate(p_estimate_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  e public.estimates%rowtype;
  v_labor    numeric(14,2) := 0;
  v_material numeric(14,2) := 0;
  v_other    numeric(14,2) := 0;
  v_burden   numeric(14,2) := 0;
  v_tax      numeric(14,2) := 0;
  v_direct   numeric(14,2) := 0;
  v_pre_fee  numeric(14,2) := 0;
  v_fee      numeric(14,2) := 0;
  v_pre_bond numeric(14,2) := 0;
  v_bond     numeric(14,2) := 0;
  v_total    numeric(14,2) := 0;
  v_incomplete boolean := false;
begin
  select * into e from public.estimates where id = p_estimate_id;
  if not found then raise exception 'estimate % not found', p_estimate_id; end if;
  if e.company_id <> get_my_company_id() then
    raise exception 'cross-tenant estimate access denied';
  end if;

  select coalesce(sum(
    coalesce(qty_reg,0)*coalesce(rate_reg,0)
    + coalesce(qty_ot,0)*coalesce(rate_ot,0)
    + coalesce(qty_dt,0)*coalesce(rate_dt,0)
  ),0) into v_labor
  from public.estimate_lines where estimate_id = p_estimate_id and category = 'labor';

  select coalesce(sum(coalesce(material_qty,0)*coalesce(material_unit_price,0)),0) into v_material
  from public.estimate_lines where estimate_id = p_estimate_id and category = 'material';

  select coalesce(sum(coalesce(amount,0)),0) into v_other
  from public.estimate_lines where estimate_id = p_estimate_id
    and category in ('subcontractor','equipment','other');

  v_incomplete := (e.labor_burden_pct is null) or (e.fee_pct is null) or (e.bond_pct is null)
    or (not e.material_tax_exempt and e.equip_material_tax_rate is null);

  v_burden := round(v_labor * coalesce(e.labor_burden_pct,0), 2);

  if not e.material_tax_exempt then
    v_tax := round(v_material * coalesce(e.equip_material_tax_rate,0), 2);
  else
    v_tax := 0;
  end if;

  v_direct  := v_labor + v_material + v_other;
  v_pre_fee := v_direct + v_burden + v_tax;
  v_fee     := round(v_pre_fee * coalesce(e.fee_pct,0), 2);
  v_pre_bond := v_pre_fee + v_fee;
  v_bond    := round(v_pre_bond * coalesce(e.bond_pct,0), 2);
  v_total   := v_pre_bond + v_bond + coalesce(e.permit_amount,0);

  update public.estimates set
    total_direct = v_direct,
    total_burden = v_burden,
    total_tax    = v_tax,
    total_fee    = v_fee,
    total_bond   = v_bond,
    total_bid    = v_total,
    cost_per_sf  = case when coalesce(e.sqft,0) > 0 then round(v_total / e.sqft, 2) else null end,
    defaults_incomplete = v_incomplete,
    updated_at   = now()
  where id = p_estimate_id;
end $function$;

commit;
