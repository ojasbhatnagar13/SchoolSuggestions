-- SchoolSuggestions -- auto-rejection and the staff approval gate
-- Run AFTER docs/setup-staff.sql.
--
-- WHAT CHANGES
--
-- 1. Nothing is publicly visible until a staff member approves it.
-- 2. The AI now auto-rejects: spam or Not Feasible goes straight to the bin
--    without reaching the staff queue. Needs Review and Feasible land in the
--    queue for a human.
--
-- This overrides the project's original scope decision, which had the AI
-- purely advisory with staff reviewing everything. That is a deliberate
-- choice, with one consequence worth being clear about: when the model gets
-- a call wrong, no human sees the suggestion by default.
--
-- Mitigation: "binned" means status='rejected', NOT deleted. Rejected rows
-- stay in the database and appear under the staff page's Rejected filter, so
-- a bad call can be found and reversed. Nothing is destroyed.
--
-- CONSEQUENCE, READ FIRST
--
-- Every existing suggestion is status='pending', so the student page will be
-- EMPTY until you approve some. Section 4 covers approving without signing
-- in, which matters while Google sign-in is still blocked.


-- =====================================================================
-- SECTION 1 -- Students see only approved suggestions
-- =====================================================================
-- Column list is unchanged, so `create or replace view` is safe. Only the
-- where clause moves.
--
-- spam='No' is kept even though status='approved' would be enough on its own,
-- so a spam row cannot become public through a mis-click in the staff UI.

create or replace view public.public_suggestions as
select
    id,
    suggestion,
    category,
    summary,
    votes,
    created_at,
    status
from public.suggestions
where spam = 'No'
  and status = 'approved';

grant select on public.public_suggestions to anon, authenticated;

-- Expected: CREATE VIEW, GRANT
select count(*) as visible_to_students from public.public_suggestions;
-- 0 until you approve something. That is correct, not a failure.


-- =====================================================================
-- SECTION 2 -- The auto-rejection rule
-- =====================================================================
-- One place decides this, so the website, main.py and anything added later
-- all behave identically.

create or replace function public.auto_status(p_spam text, p_feasibility text)
returns text
language sql
immutable
as $$
    select case
        when p_spam = 'Yes'                then 'rejected'
        when p_feasibility = 'Not Feasible' then 'rejected'
        else 'pending'
    end;
$$;

-- submit_suggestion now returns jsonb rather than a bare id, so callers can
-- tell the student what actually happened instead of guessing.
create or replace function public.submit_suggestion(
    p_suggestion   text,
    p_spam         text,
    p_feasibility  text,
    p_category     text,
    p_reason       text,
    p_summary      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    new_id     bigint;
    new_status text := public.auto_status(p_spam, p_feasibility);
begin
    insert into public.suggestions
        (suggestion, spam, feasibility, category, reason, summary, votes, status)
    values
        (p_suggestion, p_spam, p_feasibility, p_category, p_reason, p_summary, 0, new_status)
    returning id into new_id;

    return jsonb_build_object('id', new_id, 'status', new_status);
end;
$$;

revoke all on function public.submit_suggestion(text,text,text,text,text,text) from public;
grant execute on function public.submit_suggestion(text,text,text,text,text,text) to anon, authenticated;
grant execute on function public.auto_status(text, text) to anon, authenticated;

-- Expected: CREATE FUNCTION x2, REVOKE, GRANT x2


-- =====================================================================
-- SECTION 3 -- You can only vote on what you can see
-- =====================================================================
-- Without this, a student who knew an id could vote on an unapproved or
-- rejected suggestion by calling the RPC directly.

create or replace function public.vote_for_suggestion(p_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    school_domain constant text := 'dpsiedge.edu.in';

    v_user   uuid := auth.uid();
    v_email  text := auth.jwt() ->> 'email';
    new_votes bigint;
begin
    if v_user is null then
        raise exception 'You must be signed in to vote'
            using errcode = 'insufficient_privilege';
    end if;

    if v_email is null or lower(v_email) not like '%@' || lower(school_domain) then
        raise exception 'Voting is limited to % accounts', school_domain
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

-- Expected: CREATE FUNCTION, REVOKE, GRANT


-- =====================================================================
-- SECTION 4 -- Apply the rule to what is already there
-- =====================================================================
-- Existing rows predate the rule, so bin the ones it would have caught.
-- Only touches rows still pending -- anything already approved or rejected
-- by hand keeps that decision.

update public.suggestions
   set status = 'rejected'
 where status = 'pending'
   and public.auto_status(spam, feasibility) = 'rejected';

-- Expected: UPDATE <n>

-- The queue as it now stands. This is what the staff page shows, including
-- the columns students never see:
select id, status, spam, feasibility, category, votes,
       left(suggestion, 50) as suggestion, left(reason, 70) as ai_reason
from public.suggestions
order by
    case status when 'pending' then 0 else 1 end,
    created_at desc;


-- =====================================================================
-- SECTION 5 -- Approving without signing in
-- =====================================================================
-- The staff page is the normal route, but it needs a Google login. While
-- that is blocked, approve straight from here using ids from section 4:
--
--   update public.suggestions set status = 'approved' where id in (13, 14);
--
-- To reverse a bad auto-rejection:
--
--   update public.suggestions set status = 'pending' where id = 21;


-- =====================================================================
-- SECTION 6 -- Refresh PostgREST
-- =====================================================================
notify pgrst, 'reload schema';


-- =====================================================================
-- AFTERWARDS
-- =====================================================================
-- submit_suggestion changed shape (bigint -> jsonb), so both callers must be
-- updated or submissions will break:
--   - the Edge Function: npx.cmd supabase functions deploy moderate-suggestion
--   - backend/main.py, already updated in the same commit as this file
