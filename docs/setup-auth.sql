-- SchoolSuggestions -- authenticated voting
-- Run AFTER docs/setup.sql. Supersedes its section 4.
--
-- Adds one-vote-per-student-per-suggestion, enforced in the database so it
-- cannot be bypassed from the browser.
--
-- BEFORE RUNNING: set your school's email domain on the line marked EDIT ME.


-- =====================================================================
-- SECTION 1 -- Who voted for what
-- =====================================================================
-- The composite primary key is what actually enforces one vote per student
-- per suggestion. Everything else is bookkeeping.
--
-- This table is deliberately separate from `suggestions`: suggestions stay
-- anonymous (no author column), while votes are attributed. Keeping them
-- apart means a vote never reveals who suggested something.

create table if not exists public.suggestion_votes (
    suggestion_id bigint      not null references public.suggestions(id) on delete cascade,
    user_id       uuid        not null references auth.users(id)        on delete cascade,
    created_at    timestamptz not null default now(),
    primary key (suggestion_id, user_id)
);

alter table public.suggestion_votes enable row level security;

-- No policies, and no grants to anon or authenticated. All access goes
-- through the security definer function below, so nobody can read the vote
-- table directly and work out who voted for what.

-- Expected: CREATE TABLE, ALTER TABLE


-- =====================================================================
-- SECTION 2 -- Voting, with duplicate prevention
-- =====================================================================
-- Replaces the version in setup.sql section 4.

create or replace function public.vote_for_suggestion(p_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    -- EDIT ME: your school's email domain, no '@'.
    school_domain constant text := 'yourschool.edu';

    v_user   uuid := auth.uid();
    v_email  text := auth.jwt() ->> 'email';
    new_votes bigint;
begin
    if v_user is null then
        raise exception 'You must be signed in to vote'
            using errcode = 'insufficient_privilege';
    end if;

    -- Checked here rather than in the browser, so it cannot be edited away.
    if v_email is null or v_email not like '%@' || school_domain then
        raise exception 'Voting is limited to % accounts', school_domain
            using errcode = 'insufficient_privilege';
    end if;

    -- The primary key does the real work. ON CONFLICT DO NOTHING leaves
    -- FOUND false when this student has already voted.
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
    returning votes into new_votes;

    if new_votes is null then
        -- No matching votable row. Raising here aborts the function's
        -- transaction, which rolls the suggestion_votes insert back too --
        -- so a failed vote leaves no trace.
        raise exception 'Suggestion % not found or not open for voting', p_id
            using errcode = 'no_data_found';
    end if;

    return new_votes;
end;
$$;

-- Voting now requires a signed-in user, so anon loses access.
revoke all on function public.vote_for_suggestion(bigint) from public, anon;
grant execute on function public.vote_for_suggestion(bigint) to authenticated;

-- Expected: CREATE FUNCTION, REVOKE, GRANT


-- =====================================================================
-- SECTION 3 -- Let students see which suggestions they already voted for
-- =====================================================================
-- So the UI can grey out buttons instead of waiting for an error.

create or replace function public.my_votes()
returns setof bigint
language sql
security definer
set search_path = public
as $$
    select suggestion_id
    from public.suggestion_votes
    where user_id = auth.uid();
$$;

revoke all on function public.my_votes() from public, anon;
grant execute on function public.my_votes() to authenticated;

-- Expected: CREATE FUNCTION, REVOKE, GRANT


-- =====================================================================
-- SECTION 4 -- Keep read access working for signed-in users
-- =====================================================================
-- setup.sql granted the view to anon only. Signed-in students are the
-- `authenticated` role, not `anon`, so they need it too.

grant select on public.public_suggestions to authenticated;

-- Expected: GRANT


-- =====================================================================
-- VERIFY
-- =====================================================================
notify pgrst, 'reload schema';

-- Then, signed out, this should fail with 'You must be signed in to vote':
--   select public.vote_for_suggestion(14);
--
-- And from the browser once signed in, voting twice should give
-- 'You have already voted for suggestion 14'.


-- =====================================================================
-- STILL OPEN
-- =====================================================================
-- Submissions remain anonymous and unauthenticated, per the original scope
-- decision. That means anyone with the site URL can submit, and there is no
-- per-student submission limit. If that becomes a problem, the options are:
--   a) require sign-in to submit but still not store the author (spam is
--      then attributable only via Supabase's auth logs), or
--   b) rate-limit inside the Edge Function by IP or session.
-- Neither is built.
