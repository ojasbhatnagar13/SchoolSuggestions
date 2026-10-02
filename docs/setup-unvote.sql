-- SchoolSuggestions -- take a vote back
-- Run AFTER docs/setup-signin-submit.sql.
--
-- A student can remove their own vote at any time, then vote again later if
-- they change their mind. It only ever touches the caller's own vote row, so
-- nobody can remove someone else's.

create or replace function public.unvote_suggestion(p_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user    uuid := auth.uid();
    new_votes bigint;
begin
    if v_user is null then
        raise exception 'You must be signed in to change your vote'
            using errcode = 'insufficient_privilege';
    end if;

    delete from public.suggestion_votes
     where suggestion_id = p_id and user_id = v_user;

    if not found then
        raise exception 'You have not voted for suggestion %', p_id
            using errcode = 'no_data_found';
    end if;

    -- Not filtered on status: a vote can be taken back even if staff have
    -- since moved the suggestion off the board.
    update public.suggestions
       set votes = greatest(coalesce(votes, 0) - 1, 0)
     where id = p_id
    returning votes into new_votes;

    return coalesce(new_votes, 0);
end;
$$;

revoke all on function public.unvote_suggestion(bigint) from public, anon;
grant execute on function public.unvote_suggestion(bigint) to authenticated;

notify pgrst, 'reload schema';

-- Expected: the function exists and only authenticated can run it.
select grantee, privilege_type
  from information_schema.routine_privileges
 where routine_schema = 'public' and routine_name = 'unvote_suggestion'
 order by grantee;
