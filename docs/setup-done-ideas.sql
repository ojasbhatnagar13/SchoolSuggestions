-- SchoolSuggestions -- show students what the school has done
-- Run AFTER docs/setup-unvote.sql.
--
-- Ideas staff mark as 'actioned' used to vanish from the student board. Now
-- they stay, labelled Done, so students can see suggestions lead somewhere.
--
-- Same columns as before, so a plain `create or replace view` (grants are
-- kept). Voting is unchanged: vote_for_suggestion still only accepts
-- 'approved', so a Done idea cannot collect new votes. Taking a vote back
-- still works on anything.

create or replace view public.public_suggestions as
select
    id,
    suggestion,
    category,
    summary,
    created_at,
    status,
    benefit
from public.suggestions
where status in ('approved', 'actioned')
  and public.board_access_error() is null;

notify pgrst, 'reload schema';

-- Expected: how many students will now see in each state.
select status, count(*)
  from public.suggestions
 where status in ('approved', 'actioned')
 group by status;
