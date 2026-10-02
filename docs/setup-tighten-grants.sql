-- SchoolSuggestions -- remove leftover table privileges
-- Found by tests/test_security.py on 2026-10-02.
--
-- Supabase grants ALL (including TRUNCATE) on every new table to anon and
-- authenticated. setup.sql revoked that for `suggestions` (from anon), but
-- tables added later kept it: app_config, staff, suggestion_votes,
-- submission_throttle -- and authenticated still held it on suggestions.
--
-- Row level security was on with no policies, so these privileges could not
-- read or change a single row through the API, and PostgREST cannot issue
-- TRUNCATE. This is defence in depth, not a live hole: if anyone ever added a
-- careless policy, these grants would turn it into one.
--
-- Safe because nothing relies on them. Every function that touches a table
-- is `security definer` (runs as its owner), and the public_suggestions view
-- is owned by postgres, so it reads with the owner's rights too.

revoke all on public.app_config          from anon, authenticated;
revoke all on public.staff               from anon, authenticated;
revoke all on public.suggestion_votes    from anon, authenticated;
revoke all on public.submission_throttle from anon, authenticated;
revoke all on public.suggestions         from anon, authenticated;
revoke all on public.submission_quota    from anon, authenticated;
revoke all on public.moderation_rules    from anon, authenticated;

-- And stop it happening again: tables created later in this schema start
-- with no grants to the API roles. A future table that the API must reach
-- needs an explicit grant, which is the point.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- THE VIEW WAS A REAL HOLE. setup-private-list.sql recreated it with
-- `create view`, which picked up Supabase's default ALL grants, then only
-- revoked anon. So signed-in users held INSERT/UPDATE/DELETE on it. It is a
-- simple single-table view, so Postgres makes it writable, and writes run
-- with the view owner's rights -- skipping RLS on the table. A signed-in
-- account could have edited or deleted approved ideas, or inserted one
-- already 'approved', straight through the API. Only reading is intended.
revoke all on public.public_suggestions from anon, authenticated;
grant select on public.public_suggestions to authenticated;

-- Belt and braces: even if a write grant comes back by mistake, rows written
-- through the view must still satisfy its filter.
create or replace view public.public_suggestions
with (security_barrier = true) as
select id, suggestion, category, summary, created_at, status, benefit
  from public.suggestions
 where status in ('approved', 'actioned')
   and public.board_access_error() is null
with cascaded check option;

-- A leftover debugging helper from the original RLS investigation. It only
-- reports the caller's own role, so it leaked nothing, but nothing uses it.
-- Not dropped, in case it is still handy from the SQL editor.
revoke all on function public.get_current_role() from public, anon, authenticated;

notify pgrst, 'reload schema';

-- Expected: only public_suggestions / authenticated / SELECT.
select table_name, grantee, string_agg(privilege_type, ',') as privileges
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon', 'authenticated')
 group by table_name, grantee
 order by table_name, grantee;
