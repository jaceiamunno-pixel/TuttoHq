-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0035: remove_submittal_attachment(p_attachment_id uuid)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Deletes ONE submittal_attachments revision, KEEPING the parent submittal.
--
-- Careful-lane: destructive on attachments + is_current re-promotion. The
-- sync trigger (submittal_attachments_sync_current_aiu) is AFTER INSERT OR
-- UPDATE ONLY and acts only on NEW.is_current = true — a naive DELETE of the
-- CURRENT attachment would leave the parent pointing at a deleted file with
-- ZERO current rows. So when the current attachment is removed this function
-- re-promotes the next-newest remaining attachment (which fires the trigger
-- and re-syncs the parent), OR — if it was the last one — resets the parent
-- to the empty spec-ingestion placeholder and keeps the row.
--
-- SECURITY INVOKER (matches add_submittal_attachment): the caller's RLS
-- governs the lookup / delete / promotion UPDATE, so there is no cross-tenant
-- delete path. The DEFINER sync trigger still fires on the promotion UPDATE.
--
-- Newest-wins ordering mirrors add_submittal_attachment EXACTLY: numeric
-- revision extracted from the label (R0=0, R1=1, … "Original"=0), then
-- approval_date, then uploaded_at as the final deterministic tiebreak. A plain
-- `revision_label DESC` text sort would mis-rank R9 > R10, so we parse.
--
-- The last-attachment placeholder reset mirrors Library detach's DETACH_RESET
-- (src/app/api/submittals/[id]/library-delete/route.ts) field-for-field so a
-- detached-here row is indistinguishable from a never-attached one.
--
-- Add-only. Idempotent via CREATE OR REPLACE.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.remove_submittal_attachment(p_attachment_id uuid)
returns table (deleted_storage_path text, promoted_attachment_id uuid, row_reset boolean)
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  v_submittal_id uuid;
  v_was_current  boolean;
  v_storage_path text;
  v_remaining    int;
  v_next_id      uuid;
begin
  -- Resolve + capture. RLS on submittal_attachments already scopes to the
  -- caller's company; if the row isn't visible this SELECT finds nothing.
  select submittal_id, is_current, storage_path
    into v_submittal_id, v_was_current, v_storage_path
  from submittal_attachments
  where id = p_attachment_id;

  if v_submittal_id is null then
    raise exception 'attachment not found or not accessible';
  end if;

  -- Delete the target attachment (RLS delete policy governs).
  delete from submittal_attachments where id = p_attachment_id;

  select count(*) into v_remaining
  from submittal_attachments where submittal_id = v_submittal_id;

  if v_remaining > 0 then
    if v_was_current then
      -- Promote the next-newest remaining attachment. Mirrors the newest-wins
      -- order add_submittal_attachment uses: numeric revision desc, then
      -- approval_date desc, then uploaded_at desc as a final tiebreak.
      select id into v_next_id
      from submittal_attachments
      where submittal_id = v_submittal_id
      order by
        coalesce(nullif((regexp_match(coalesce(revision_label, ''), '\d+'))[1], '')::int, 0) desc,
        approval_date desc nulls last,
        uploaded_at desc
      limit 1;

      update submittal_attachments
      set is_current = true
      where id = v_next_id;
      -- ^ fires submittal_attachments_sync_current_aiu -> re-syncs parent row.
    end if;
    return query select v_storage_path, v_next_id, false;
  else
    -- Last attachment removed: reset parent to empty placeholder, KEEP the row.
    -- Field-for-field mirror of Library detach's DETACH_RESET
    -- (src/app/api/submittals/[id]/library-delete/route.ts): all file-derived
    -- / trigger-managed columns null, review_status 'Received', revision_number
    -- '00'. stripped_storage_path is intentionally left as-is to match that
    -- reference exactly. Do NOT drift.
    update submittals
    set storage_path          = null,
        file_size             = null,
        mime_type             = null,
        file_sha256           = null,
        received_file_name    = null,
        returned_from_ae_date = null,
        sent_to_ae_date       = null,
        received_at           = null,
        submittal_number      = null,
        review_status         = 'Received',
        revision_number       = '00'
    where id = v_submittal_id;
    return query select v_storage_path, null::uuid, true;
  end if;
end;
$$;

revoke all on function public.remove_submittal_attachment(uuid) from public;
grant execute on function public.remove_submittal_attachment(uuid) to authenticated;
