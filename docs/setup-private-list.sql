-- SchoolSuggestions -- private list, no public vote counts
-- Run AFTER docs/setup-duplicates.sql.
--
-- Two changes, both from staff feedback:
--
-- 1. Vote counts are no longer sent to students at all. Showing a running
--    tally invites the bandwagon effect: a suggestion that is already popular
--    attracts more votes because it is visibly popular, not because more
--    people independently agree with it. Staff still see counts.
--
-- 2. Reading the list now requires signing in with a school account.
--    Previously anyone with the link could browse every approved suggestion,
--    which made the page easy to screenshot and share outside school.
--    Submitting stays anonymous and needs no account.


-- =====================================================================
-- SECTION 1 -- Rebuild the view without votes
-- =====================================================================
-- DROP is required. `create or replace view` can add columns at the end but
-- cannot remove one -- it fails with
--   42P16: cannot drop columns from view
-- Dropping also discards the view's grants, which is why they are reapplied
-- below rather than left alone.

drop view if exists public.public_suggestions;

create view public.public_suggestions as
select
    id,
    suggestion,
    category,
    summary,
    created_at,
    status
from public.suggestions
where spam = 'No'
  and status = 'approved';

-- anon can no longer read the list. Note this does NOT affect submitting:
-- that goes through submit_suggestion(), which is security definer and still
-- granted to anon.
revoke all on public.public_suggestions from anon;
grant select on public.public_suggestions to authenticated;

notify pgrst, 'reload schema';

-- Expected: DROP VIEW, CREATE VIEW, REVOKE, GRANT


-- =====================================================================
-- VERIFY
-- =====================================================================
-- The votes column should be gone:
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'public_suggestions'
order by ordinal_position;
-- Expected: id, suggestion, category, summary, created_at, status
--           (no votes)

-- anon should hold nothing on the view, authenticated should hold SELECT:
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'public_suggestions'
order by grantee;
-- Expected: authenticated / SELECT only


-- =====================================================================
-- WHAT DID NOT CHANGE
-- =====================================================================
-- votes is still counted and still stored on public.suggestions. It is only
-- hidden from students. staff_suggestions() still returns it, so the staff
-- page shows the real numbers -- which is the point: staff need the signal to
-- prioritise, students do not need it to form an opinion.
--
-- One consequence worth knowing: because the students' list no longer carries
-- vote counts, it can no longer be sorted by popularity. That is deliberate,
-- not a limitation -- ordering by "most voted" is the bandwagon mechanism.
-- The list is ordered newest first.
