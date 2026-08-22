-- SchoolSuggestions -- database setup and hardening
-- Run in the Supabase SQL editor: https://supabase.com/dashboard/project/ywyjhgpcokrtzibcrqes/sql
--
-- Run ONE SECTION AT A TIME and check the expected result before moving on.
-- Sections 1-4 are safe and additive. Section 5 removes access, so read it first.
--
-- Written 2026-08-19, after the 42501 RLS blocker was resolved.
-- Background: docs/rls-fix-options.md


-- =====================================================================
-- SECTION 1 -- Remove diagnostic artefacts
-- =====================================================================
-- Both of these were confirmed still present on 2026-08-19.
-- debug_insert_test() still errors with 42501 when called, which is how
-- its existence was detected.

drop function if exists public.get_auth_role();
drop function if exists public.debug_insert_test();

-- Test rows left over from debugging. Suggestion #14 ("bike racks near the
-- gym") is a REAL row from the first successful end-to-end run -- it is
-- deliberately not in this list.
delete from public.suggestions
where suggestion in (
    'DIAG-2026-08-19-minimal-return',
    'Final RLS diagnostic test',
    'ANON ROLE TEST',
    'Python REST test',
    'test',
    'Install more charging ports in the library.'
);

-- Expected: DROP FUNCTION x2, then DELETE with a row count matching however
-- many of those test rows still existed.
-- Check what survived:
select id, suggestion, spam, feasibility from public.suggestions order by id;


-- =====================================================================
-- SECTION 2 -- Add created_at
-- =====================================================================
-- Needed before the frontend can sort suggestions by recency.

alter table public.suggestions
    add column if not exists created_at timestamptz not null default now();

-- Note: existing rows get the time you run this, not their true creation
-- time. That history is unrecoverable -- the column never existed. Harmless
-- given the only real row so far is #14.

-- Expected: ALTER TABLE
select id, suggestion, created_at from public.suggestions order by id;


-- =====================================================================
-- SECTION 3 -- Read path for the frontend
-- =====================================================================
-- Right now anon can SELECT nothing at all (verified: 0 rows, no error).
-- The browse/vote UI needs SOME read path. This view is it.
--
-- It exposes only student-facing columns. `spam`, `feasibility` and `reason`
-- are the AI's internal moderation verdicts and stay server-side, visible
-- only to staff via the dashboard.
--
-- security_invoker is left at its default (false), so the view runs with its
-- owner's rights and reads through the base table's RLS. That is intentional:
-- it means anon needs no SELECT policy and no SELECT grant on the base table.
-- Supabase's security advisor will flag this as a "security definer view" --
-- that warning is expected here, because the filtering is done by the view's
-- own WHERE clause.

create or replace view public.public_suggestions as
select
    id,
    suggestion,
    category,
    summary,
    votes,
    created_at
from public.suggestions
where spam = 'No';

grant select on public.public_suggestions to anon;

-- Expected: CREATE VIEW, GRANT
select * from public.public_suggestions order by created_at desc;


-- =====================================================================
-- SECTION 4 -- Voting
-- =====================================================================
-- Same security definer pattern as submit_suggestion: the write happens with
-- owner rights, so anon never needs a blanket UPDATE policy on the table.
--
-- Refuses to vote on flagged rows, and reports a missing/ineligible id rather
-- than silently doing nothing.

create or replace function public.vote_for_suggestion(p_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    new_votes bigint;
begin
    update public.suggestions
       set votes = coalesce(votes, 0) + 1
     where id = p_id
       and spam = 'No'
    returning votes into new_votes;

    if new_votes is null then
        raise exception 'Suggestion % not found or not open for voting', p_id
            using errcode = 'no_data_found';
    end if;

    return new_votes;
end;
$$;

revoke all on function public.vote_for_suggestion(bigint) from public;
grant execute on function public.vote_for_suggestion(bigint) to anon;

-- !! This has NO duplicate-vote prevention. Anyone can call it in a loop.
-- Fixing that needs a per-student identity, which is an open decision
-- (Supabase Auth, or a device token). Do not launch to students without it.

-- Expected: CREATE FUNCTION, REVOKE, GRANT
-- Test it (replace 14 with a real id):
select public.vote_for_suggestion(14);   -- returns the new vote count


-- =====================================================================
-- SECTION 5 -- Hardening  (read before running)
-- =====================================================================
-- anon currently holds INSERT, SELECT, UPDATE and DELETE on the table. None
-- of it is exploitable today, because RLS has no policy permitting UPDATE or
-- DELETE -- both were verified to affect 0 rows. But the grants mean a single
-- careless permissive policy added later would immediately expose the table.
--
-- After this section, anon's ONLY access is:
--   write -> submit_suggestion()   (security definer)
--   vote  -> vote_for_suggestion() (security definer)
--   read  -> public_suggestions    (view)
--
-- Do not run this until sections 3 and 4 are confirmed working, or the
-- frontend will have no read path.

-- Supabase grants ALL on new tables to anon by default, which in Postgres
-- means more than INSERT/SELECT/UPDATE/DELETE: it also includes TRUNCATE,
-- REFERENCES and TRIGGER. TRUNCATE matters most -- it bypasses RLS entirely
-- (it empties the table at the storage level, not row by row), so anon
-- retaining it would mean the public key could wipe every suggestion. All
-- seven are revoked here in one statement so nothing is missed.
revoke insert, select, update, delete, truncate, references, trigger
    on public.suggestions from anon;

-- The old INSERT policy is now inert -- the grant it depended on is gone.
-- Dropping it keeps the policy list honest. It is reproduced here so you can
-- recreate it if you ever need to:
--
--   create policy allow_anonymous_insert on public.suggestions
--   as permissive for insert to anon with check (true);
drop policy if exists allow_anonymous_insert on public.suggestions;

-- Expected: REVOKE, DROP POLICY
-- Verify anon has no direct table access left:
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'suggestions' and grantee = 'anon';
-- Expected: 0 rows

select policyname, cmd, roles from pg_policies
where schemaname = 'public' and tablename = 'suggestions';
-- Expected: 0 rows


-- =====================================================================
-- SECTION 6 -- Refresh PostgREST
-- =====================================================================
-- Supabase usually reloads automatically, but if the new view or function
-- returns "Could not find the table/function in the schema cache", run this.

notify pgrst, 'reload schema';


-- =====================================================================
-- AFTER RUNNING: verify from Python
-- =====================================================================
--   cd "C:\Users\Ojas Bhatnagar\Desktop\SchoolSuggestions\backend"
--   .\venv\Scripts\python.exe main.py
--
-- main.py writes through submit_suggestion(), which is security definer, so
-- it keeps working even after section 5 revokes anon's table grants.
