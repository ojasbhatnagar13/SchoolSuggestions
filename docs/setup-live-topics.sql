-- SchoolSuggestions -- show the AI the topics already in use
-- Run AFTER docs/setup-flags-reword.sql.
--
-- Found by tests/eval/accuracy.py (2026-11-19): duplicate detection missed
-- the same request in different words. "bike racks", "cycle stand" and
-- "bicycle parking" share almost no letters, so trigram similarity scored
-- them 0. The fix is upstream: before the AI writes a topic, it is shown the
-- topics already in use and told to copy one exactly when the request is the
-- same. Identical topics then always match.
--
-- Topics are 2-4 word labels like "bike racks", so nothing personal is sent
-- to the AI. Wellbeing concerns are never included. Behind the server secret,
-- like the other functions the Edge Function uses.

create or replace function public.live_topics(p_secret text)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.submit_secret_ok(p_secret) then
        raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;

    -- Most recently used first, capped so the prompt stays small.
    return coalesce((
        select array_agg(topic order by last_used desc)
          from (
              select topic, max(created_at) as last_used
                from public.suggestions
               where status in ('approved', 'accepted', 'pending', 'actioned')
                 and not concern
                 and topic is not null
               group by topic
               order by max(created_at) desc
               limit 300
          ) t
    ), '{}');
end;
$$;

revoke all on function public.live_topics(text) from public;
grant execute on function public.live_topics(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- Expected: an empty list right now (the database was cleared).
select public.live_topics((select submit_secret from public.app_config)) as topics_in_use;
