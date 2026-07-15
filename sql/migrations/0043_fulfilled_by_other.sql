alter table public.submittals
  add column if not exists fulfilled_by_other boolean not null default false;

comment on column public.submittals.fulfilled_by_other is
  'True when this requirement is satisfied by another submittal on the same project. Row is retained in the log and export; description renders "Fulfilled by other submittal".';
