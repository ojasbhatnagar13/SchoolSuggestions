-- SchoolSuggestions -- give back the send when a suggestion is too vague
-- Run AFTER docs/setup-feedback-mine.sql.
--
-- A vague suggestion is not saved: the student is asked to say more. The
-- rate-limit slot was claimed before the AI looked at it, so without this a
-- student rephrasing a few times could lock themselves out for an hour.

create or replace function public.refund_account_slot(p_secret text, p_account_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.submit_secret_ok(p_secret) then
        raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;
    update public.submission_quota
       set used = greatest(used - 1, 0)
     where account_hash = p_account_hash
       and hour = date_trunc('hour', now());
end;
$$;

revoke all on function public.refund_account_slot(text, text) from public;
grant execute on function public.refund_account_slot(text, text) to anon, authenticated;

notify pgrst, 'reload schema';

select 'refund_account_slot installed' as ok;
