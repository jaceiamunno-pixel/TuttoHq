revoke all on function public.recalculate_estimate(uuid) from public;
revoke all on function public.recalculate_estimate(uuid) from anon;
grant execute on function public.recalculate_estimate(uuid) to authenticated;
