-- SchoolSuggestions -- students can follow their own suggestions
-- Run AFTER docs/setup-skip-voting.sql.
--
-- DECISION (2026-11-19, principal's feedback, user chose option 2)
--
-- Each suggestion is now saved with the account that sent it, so a student
-- can see what happened to their suggestions on any device, and gets a
-- notice when one is approved, goes ahead, is done, or is not taken forward.
--
-- STAFF NEVER SEE WHO SENT A SUGGESTION. author_id is not returned by
-- staff_suggestions(), not in the student view, and not in any function
-- staff can call. tests/test_grants.py checks this. The only functions that
-- touch it answer "my own suggestions" for the signed-in student.
--
-- WHAT THIS CHANGES ABOUT ANONYMITY -- be precise when describing it:
-- suggestions are anonymous to staff and to other students, but no longer
-- to whoever administers the database. Anyone with full database access
-- could look up who sent a suggestion. That is why the school, not a
-- student, should hold that access. The site's wording says this.


-- =====================================================================
-- SECTION 1 -- Columns
-- =====================================================================

alter table public.suggestions
    add column if not exists author_id          uuid references auth.users(id) on delete set null,
    -- what the author has already been told, so a notice appears only once
    add column if not exists author_seen_status text;

create index if not exists suggestions_author on public.suggestions (author_id)
    where author_id is not null;


-- =====================================================================
-- SECTION 2 -- How a student describes a status
-- =====================================================================
-- Spam and rejected are both "not taken forward" to the student: they were
-- told the reason at the time, and the distinction is for staff.

create or replace function public.student_status(p_status text)
returns text
language sql
immutable
set search_path = public
as $$
    select case p_status
        when 'pending'  then 'waiting'
        when 'approved' then 'approved'
        when 'accepted' then 'going_ahead'
        when 'actioned' then 'done'
        else 'not_taken_forward'
    end;
$$;

revoke all on function public.student_status(text) from public, anon, authenticated;


-- =====================================================================
-- SECTION 3 -- Submitting records the author
-- =====================================================================
-- Gains p_author, so the 11-argument version is dropped first. Only the Edge
-- Function can set it: the function needs the server secret, and the Edge
-- Function takes the id from the student's verified session, never from the
-- request body.

drop function if exists public.submit_suggestion(text, text, text, text, text, text, text, text, text, boolean, text);

create or replace function public.submit_suggestion(
    p_suggestion   text,
    p_spam         text,
    p_feasibility  text,
    p_category     text,
    p_reason       text,
    p_summary      text,
    p_secret       text,
    p_topic        text default null,
    p_benefit      text default null,
    p_concern      boolean default false,
    p_receipt      text default null,
    p_author       uuid default null
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
    v_concern  boolean := coalesce(p_concern, false);
    threshold  real;
    dup_id     bigint;
    dup_text   text;
begin
    if not public.submit_secret_ok(p_secret) then
        raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;

    if v_benefit is not null and length(v_benefit) > 1000 then
        raise exception 'The explanation is limited to 1000 characters'
            using errcode = 'invalid_parameter_value';
    end if;

    if v_concern then
        new_status := 'pending';
    end if;

    if not v_concern and new_status = 'pending'
       and p_topic is not null and length(trim(p_topic)) > 0 then
        select duplicate_threshold into threshold from public.app_config where id;

        select s.id, s.suggestion
          into dup_id, dup_text
          from public.suggestions s
         where s.status in ('approved', 'accepted', 'pending', 'actioned')
           and not s.concern
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

    -- p_receipt is accepted for compatibility but no longer stored.
    insert into public.suggestions
        (suggestion, benefit, spam, feasibility, category, reason, summary,
         votes, status, topic, decided_by, decided_at, concern,
         author_id, author_seen_status)
    values
        (p_suggestion, v_benefit, p_spam, p_feasibility, p_category, p_reason, p_summary,
         0, new_status, p_topic,
         case when new_status = 'pending' then null else 'ai'  end,
         case when new_status = 'pending' then null else now() end,
         v_concern,
         -- What the student is told on screen right now counts as seen, so
         -- the first notice is the next real change.
         p_author, public.student_status(new_status))
    returning id into new_id;

    return jsonb_build_object('id', new_id, 'status', new_status, 'concern', v_concern);
end;
$$;

revoke all on function public.submit_suggestion(text,text,text,text,text,text,text,text,text,boolean,text,uuid) from public;
grant execute on function public.submit_suggestion(text,text,text,text,text,text,text,text,text,boolean,text,uuid)
    to anon, authenticated;


-- =====================================================================
-- SECTION 4 -- "My suggestions", for the signed-in student only
-- =====================================================================
-- Both functions use auth.uid(), so a student can only ever reach their own.
-- Wellbeing concerns are not listed: there is nothing to report back, and
-- listing them would show up on a shared screen.

create or replace function public.my_suggestions()
returns table (
    id         bigint,
    suggestion text,
    status     text,
    created_at timestamptz,
    decided_at timestamptz,
    unseen     boolean
)
language sql
stable
security definer
set search_path = public
as $$
    select s.id,
           left(s.suggestion, 200),
           public.student_status(s.status),
           s.created_at,
           s.decided_at,
           public.student_status(s.status) is distinct from s.author_seen_status
      from public.suggestions s
     where auth.uid() is not null
       and s.author_id = auth.uid()
       and not s.concern
     order by s.created_at desc, s.id desc
     limit 50;
$$;

create or replace function public.mark_my_suggestions_seen(p_ids bigint[])
returns integer
language sql
security definer
set search_path = public
as $$
    with marked as (
        update public.suggestions s
           set author_seen_status = public.student_status(s.status)
         where auth.uid() is not null
           and s.author_id = auth.uid()
           and s.id = any (p_ids[1:50])
        returning 1
    )
    select count(*)::integer from marked;
$$;

revoke all on function public.my_suggestions() from public, anon;
revoke all on function public.mark_my_suggestions_seen(bigint[]) from public, anon;
grant execute on function public.my_suggestions() to authenticated;
grant execute on function public.mark_my_suggestions_seen(bigint[]) to authenticated;

notify pgrst, 'reload schema';

-- Expected: author_id exists on the table, and is NOT in the student view
-- or in what staff_suggestions returns.
select
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'suggestions'
               and column_name = 'author_id')                                  as table_has_author,
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'public_suggestions'
               and column_name like 'author%')                                  as view_has_author,
    (select array_to_string(proargnames, ',') like '%author%'
       from pg_proc where proname = 'staff_suggestions')                        as staff_sees_author;
