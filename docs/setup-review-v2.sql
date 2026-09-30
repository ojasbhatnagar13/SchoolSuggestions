-- SchoolSuggestions -- review round 2 (teacher feedback, 2026-09-30)
-- Run AFTER docs/setup-private-list.sql (and setup-limits.sql if you ran it).
--
-- Paste the WHOLE file into the SQL editor and run it once. It is written to
-- be safe to re-run.
--
-- WHAT CHANGES
--
-- 1. Spam is its own status. Before, spam and "breaks a guideline" both
--    became 'rejected', so staff could not tell a junk message from a real
--    idea the rules do not allow. Now the AI sends junk to 'spam' and real
--    but disallowed ideas to 'rejected'. Staff can use both too.
--
-- 2. Every decision records who made it. decided_by is 'ai' when the
--    suggestion was sorted automatically, 'staff' when a person chose the
--    status, with the time and which staff account. The staff page shows it.
--
-- 3. Students can say why their idea would help. Optional, stored in
--    `benefit`, screened by the AI with the suggestion, shown on the board.
--
-- 4. Staff decisions are final. The student view used to require spam='No'
--    as well as status='approved', which meant a suggestion the AI wrongly
--    called spam stayed hidden even after staff approved it. The AI's verdict
--    is still stored and shown to staff, but it no longer overrides a person.
--
-- 5. Only verified accounts can see the board or vote, and only from the
--    school domain when demo mode is off. Google sign-in always verifies the
--    address, so this changes nothing for real students. It closes the gap
--    where someone creates an account through the API with an unverified or
--    made-up address, and it means a personal Gmail can no longer read the
--    board once demo mode is off.
--
-- AFTERWARDS: redeploy the Edge Function (see the bottom of this file).
-- Submissions keep working in the meantime -- the new p_benefit argument has
-- a default, so the currently deployed function is unaffected.


-- =====================================================================
-- SECTION 1 -- Schema
-- =====================================================================

alter table public.suggestions
    add column if not exists benefit     text
        check (benefit is null or length(benefit) <= 1000),
    add column if not exists decided_by  text
        check (decided_by in ('ai', 'staff')),
    add column if not exists decided_at  timestamptz,
    add column if not exists reviewed_by uuid
        references auth.users(id) on delete set null;

alter table public.suggestions drop constraint if exists suggestions_status_check;
alter table public.suggestions
    add constraint suggestions_status_check
    check (status in ('pending', 'approved', 'rejected', 'spam', 'actioned'));


-- =====================================================================
-- SECTION 2 -- The auto-sorting rule
-- =====================================================================
-- Same signature and return type, so a plain replace. The keep-alive
-- workflow calls this function and is unaffected.

create or replace function public.auto_status(p_spam text, p_feasibility text)
returns text
language sql
immutable
as $$
    select case
        when p_spam = 'Yes'                 then 'spam'
        when p_feasibility = 'Not Feasible' then 'rejected'
        else 'pending'
    end;
$$;


-- =====================================================================
-- SECTION 3 -- Backfill what is already there
-- =====================================================================
-- Order matters: the new constraint and the new auto_status must exist first.

-- Rejected rows the AI called spam become spam.
update public.suggestions
   set status = 'spam'
 where status = 'rejected' and spam = 'Yes';

-- Anything whose status is exactly what the AI rule produces was sorted by
-- the AI. Its decision time is unknown, so use when it was submitted.
update public.suggestions
   set decided_by = 'ai', decided_at = created_at
 where decided_by is null
   and status in ('rejected', 'spam')
   and status = public.auto_status(spam, feasibility);

-- Everything else that is not pending was set by a person. Which person was
-- not recorded before today, so reviewed_by stays empty for these.
update public.suggestions
   set decided_by = 'staff'
 where decided_by is null
   and status <> 'pending';


-- =====================================================================
-- SECTION 4 -- Who may see the board and vote
-- =====================================================================
-- One function decides, so the board and voting can never disagree. Returns
-- NULL when the signed-in user is allowed, otherwise the reason they are not,
-- worded for a student. The website calls it to explain an empty board.

create or replace function public.board_access_error()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_email     text;
    v_confirmed timestamptz;
    v_domain    text;
begin
    if auth.uid() is null then
        return 'Sign in to see the board.';
    end if;

    select email, email_confirmed_at
      into v_email, v_confirmed
      from auth.users
     where id = auth.uid();

    if v_confirmed is null then
        return 'Your email address has not been verified yet.';
    end if;

    select vote_email_domain into v_domain from public.app_config where id;

    -- NULL domain = demo mode: any verified account.
    if v_domain is not null
       and lower(coalesce(v_email, '')) not like '%@' || lower(v_domain) then
        return format('Only @%s accounts can see the board. Sign out and sign in with your school account.', v_domain);
    end if;

    return null;
end;
$$;

revoke all on function public.board_access_error() from public, anon;
grant execute on function public.board_access_error() to authenticated;


-- =====================================================================
-- SECTION 5 -- The student view
-- =====================================================================
-- `benefit` is appended LAST: `create or replace view` can only add columns
-- at the end (42P16 otherwise). Grants survive a replace.
--
-- Functions a view calls run with the permissions of the person querying it,
-- which is why board_access_error() is granted to authenticated above.

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
where status = 'approved'
  and public.board_access_error() is null;


-- =====================================================================
-- SECTION 6 -- Voting
-- =====================================================================

create or replace function public.vote_for_suggestion(p_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user    uuid := auth.uid();
    v_block   text;
    new_votes bigint;
begin
    if v_user is null then
        raise exception 'You must be signed in to vote'
            using errcode = 'insufficient_privilege';
    end if;

    v_block := public.board_access_error();
    if v_block is not null then
        raise exception '%', v_block using errcode = 'insufficient_privilege';
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


-- =====================================================================
-- SECTION 7 -- Submitting
-- =====================================================================
-- Gains p_benefit, so the 7-argument version must be dropped first or
-- PostgREST sees two overloads. Dropping discards grants; they are re-granted
-- below.

drop function if exists public.submit_suggestion(text, text, text, text, text, text, text);

create or replace function public.submit_suggestion(
    p_suggestion   text,
    p_spam         text,
    p_feasibility  text,
    p_category     text,
    p_reason       text,
    p_summary      text,
    p_topic        text default null,
    p_benefit      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    new_id     bigint;
    new_status text := public.auto_status(p_spam, p_feasibility);
    v_benefit  text := nullif(trim(coalesce(p_benefit, '')), '');
    threshold  real;
    dup_id     bigint;
    dup_text   text;
begin
    if v_benefit is not null and length(v_benefit) > 1000 then
        raise exception 'The explanation is limited to 1000 characters'
            using errcode = 'invalid_parameter_value';
    end if;

    -- Duplicates are only looked for among live ideas. See
    -- docs/setup-duplicates.sql for why both similarity directions are used.
    if new_status = 'pending' and p_topic is not null and length(trim(p_topic)) > 0 then
        select duplicate_threshold into threshold from public.app_config where id;

        select s.id, s.suggestion
          into dup_id, dup_text
          from public.suggestions s
         where s.status in ('approved', 'pending', 'actioned')
           and s.topic is not null
           and greatest(
                   similarity(s.topic, p_topic),
                   word_similarity(p_topic, s.topic),
                   word_similarity(s.topic, p_topic)
               ) >= coalesce(threshold, 0.55)
         order by greatest(
                   similarity(s.topic, p_topic),
                   word_similarity(p_topic, s.topic),
                   word_similarity(s.topic, p_topic)
               ) desc
         limit 1;

        if dup_id is not null then
            return jsonb_build_object(
                'status',       'duplicate',
                'duplicate_of', dup_id,
                'existing',     dup_text
            );
        end if;
    end if;

    insert into public.suggestions
        (suggestion, benefit, spam, feasibility, category, reason, summary,
         votes, status, topic, decided_by, decided_at)
    values
        (p_suggestion, v_benefit, p_spam, p_feasibility, p_category, p_reason, p_summary,
         0, new_status, p_topic,
         case when new_status = 'pending' then null else 'ai'  end,
         case when new_status = 'pending' then null else now() end)
    returning id into new_id;

    return jsonb_build_object('id', new_id, 'status', new_status);
end;
$$;

revoke all on function public.submit_suggestion(text,text,text,text,text,text,text,text) from public;
grant execute on function public.submit_suggestion(text,text,text,text,text,text,text,text)
    to anon, authenticated;


-- =====================================================================
-- SECTION 8 -- Staff functions
-- =====================================================================
-- staff_suggestions returns new columns, which counts as a new return type
-- (42P13 on a plain replace), so it is dropped and recreated.

drop function if exists public.staff_suggestions();

create function public.staff_suggestions()
returns table (
    id          bigint,
    suggestion  text,
    benefit     text,
    spam        text,
    feasibility text,
    category    text,
    reason      text,
    summary     text,
    votes       bigint,
    status      text,
    decided_by  text,
    decided_at  timestamptz,
    reviewer    text,
    created_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_staff() then
        raise exception 'Staff access required'
            using errcode = 'insufficient_privilege';
    end if;

    -- Pending first: it is the only group that needs someone to act.
    return query
        select s.id, s.suggestion, s.benefit, s.spam, s.feasibility, s.category,
               s.reason, s.summary, s.votes, s.status, s.decided_by, s.decided_at,
               u.email::text, s.created_at
          from public.suggestions s
          left join auth.users u on u.id = s.reviewed_by
         order by
               case s.status
                   when 'pending'  then 0
                   when 'approved' then 1
                   when 'actioned' then 2
                   when 'rejected' then 3
                   else 4
               end,
               s.created_at desc;
end;
$$;

-- Same signature and return type as before, so a plain replace.
create or replace function public.staff_set_status(p_id bigint, p_status text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    new_status text;
begin
    if not public.is_staff() then
        raise exception 'Staff access required'
            using errcode = 'insufficient_privilege';
    end if;

    if p_status not in ('pending', 'approved', 'rejected', 'spam', 'actioned') then
        raise exception 'Invalid status: %', p_status;
    end if;

    update public.suggestions
       set status      = p_status,
           decided_by  = 'staff',
           decided_at  = now(),
           reviewed_by = auth.uid()
     where id = p_id
    returning status into new_status;

    if new_status is null then
        raise exception 'Suggestion % not found', p_id
            using errcode = 'no_data_found';
    end if;

    return new_status;
end;
$$;

revoke all on function public.staff_suggestions() from public, anon;
revoke all on function public.staff_set_status(bigint, text) from public, anon;
grant execute on function public.staff_suggestions() to authenticated;
grant execute on function public.staff_set_status(bigint, text) to authenticated;

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY
-- =====================================================================
-- The editor shows only this last result. Every signed-in account should be
-- verified = true (Google always verifies). If yours says false, voting and
-- the board will refuse it -- tell Claude before doing anything else.

select u.email,
       u.email_confirmed_at is not null as verified,
       exists (select 1 from public.staff s where s.user_id = u.id) as is_staff,
       (select count(*) from public.suggestions) as suggestions,
       (select count(*) from public.suggestions where status = 'spam') as spam,
       (select count(*) from public.suggestions where decided_by is not null) as decided
  from auth.users u
 order by u.created_at;


-- =====================================================================
-- THEN
-- =====================================================================
-- Redeploy the Edge Function so the AI tells spam and rejected apart and
-- screens the new "how would it help" box. In PowerShell, from the project
-- folder, on a network without TLS interception (not school Wi-Fi):
--
--   npx.cmd supabase functions deploy moderate-suggestion
