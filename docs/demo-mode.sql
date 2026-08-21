-- SchoolSuggestions -- demo mode toggle
-- Run AFTER docs/setup-moderation-gate.sql.
--
-- WHY THIS EXISTS
--
-- Voting is restricted to school email addresses. While the school's Google
-- Workspace admin is still blocking the app, school accounts cannot sign in
-- at all -- so demoing means using a personal Gmail, which the domain check
-- would reject.
--
-- Rather than swapping the whole function back and forth (and losing track of
-- which version is live), the allowed domain moves into a config row. Demo
-- mode is then a one-line UPDATE, and so is turning it off.
--
-- SECURITY NOTE
--
-- In demo mode ANY Google account can vote -- not just your school. That is
-- fine for showing a teacher on your own screen. It must be turned off before
-- students use it, or vote counts can be stuffed by anyone with the URL.
-- Section 4 is the off switch. Do not skip it.


-- =====================================================================
-- SECTION 1 -- Config table
-- =====================================================================
-- The `id boolean primary key check (id)` trick allows exactly one row: the
-- only permitted value is true, so a second insert cannot succeed.

create table if not exists public.app_config (
    id                boolean primary key default true check (id),
    vote_email_domain text          -- NULL means any domain (demo mode)
);

insert into public.app_config (id, vote_email_domain)
values (true, 'dpsiedge.edu.in')
on conflict (id) do nothing;

alter table public.app_config enable row level security;
-- No grants: only the security definer function below reads this.

-- Expected: CREATE TABLE, INSERT 0 1 (or 0 0 if rerun), ALTER TABLE
select * from public.app_config;


-- =====================================================================
-- SECTION 2 -- Voting reads the domain from config
-- =====================================================================
-- Same function as before; the only change is that the domain is looked up
-- instead of hardcoded, and a NULL domain skips the check entirely.

create or replace function public.vote_for_suggestion(p_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    v_domain  text;
    v_user    uuid := auth.uid();
    v_email   text := auth.jwt() ->> 'email';
    new_votes bigint;
begin
    if v_user is null then
        raise exception 'You must be signed in to vote'
            using errcode = 'insufficient_privilege';
    end if;

    select vote_email_domain into v_domain from public.app_config where id;

    -- NULL domain = demo mode, any signed-in account may vote.
    if v_domain is not null
       and (v_email is null or lower(v_email) not like '%@' || lower(v_domain)) then
        raise exception 'Voting is limited to % accounts', v_domain
            using errcode = 'insufficient_privilege';
    end if;

    insert into public.suggestion_votes (suggestion_id, user_id)
    values (p_id, v_user)
    on conflict do nothing;

    if not found then
        raise exception 'You have already voted for suggestion %', p_id
            using errcode = 'unique_violation';
    end if;

    update public.suggestions
       set votes = coalesce(votes, 0) + 1
     where id = p_id
       and spam = 'No'
       and status = 'approved'
    returning votes into new_votes;

    if new_votes is null then
        raise exception 'Suggestion % is not open for voting', p_id
            using errcode = 'no_data_found';
    end if;

    return new_votes;
end;
$$;

revoke all on function public.vote_for_suggestion(bigint) from public, anon;
grant execute on function public.vote_for_suggestion(bigint) to authenticated;

notify pgrst, 'reload schema';

-- Expected: CREATE FUNCTION, REVOKE, GRANT


-- =====================================================================
-- SECTION 3 -- DEMO MODE ON
-- =====================================================================
-- Any Google account can now vote.

update public.app_config set vote_email_domain = null;

select coalesce(vote_email_domain, '** DEMO MODE: any email can vote **')
       as vote_restriction
from public.app_config;


-- =====================================================================
-- SECTION 4 -- DEMO MODE OFF  (run this before students use the site)
-- =====================================================================
--   update public.app_config set vote_email_domain = 'dpsiedge.edu.in';
--
-- Verify with:
--   select * from public.app_config;


-- =====================================================================
-- ALSO NEEDED FOR THE DEMO
-- =====================================================================
-- 1. Add your personal Gmail as a Google test user, or sign-in will be
--    blocked by Google itself (the app is still unpublished):
--    Google Auth Platform -> Audience -> Test users -> Add users
--
-- 2. Sign in on the live site once, so your auth.users row exists.
--
-- 3. Make that account staff, so you can demo the staff page:
--      insert into public.staff (user_id, note)
--      select id, 'demo account' from auth.users
--      where email = 'your-personal@gmail.com'
--      on conflict (user_id) do nothing;
--
-- 4. Afterwards, remove the demo account from staff:
--      delete from public.staff s using auth.users u
--      where s.user_id = u.id and u.email = 'your-personal@gmail.com';
