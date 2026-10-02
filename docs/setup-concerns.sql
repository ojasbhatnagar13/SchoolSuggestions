-- SchoolSuggestions -- wellbeing concerns get their own urgent path
-- Run AFTER docs/setup-tighten-grants.sql.
--
-- WHY
--
-- Students will sometimes use a suggestion box to report bullying, self-harm
-- or feeling unsafe, however clearly the site says not to. Those must never
-- sit in an ordinary queue, never be shown to other students, and never be
-- answered with "someone already suggested this".
--
-- WHAT CHANGES
--
-- 1. suggestions.concern marks a submission as a possible wellbeing or
--    safety report. The Edge Function sets it (AI verdict, plus a keyword
--    check that still works when the AI is down).
-- 2. Concerns skip duplicate matching, so a second student reporting
--    bullying is never told it "already exists".
-- 3. Concerns are never shown to students and cannot be approved or marked
--    Done. Staff either mark one handled or, if it was flagged by mistake,
--    "not a concern", which returns it to the normal queue.
-- 4. The staff page shows open concerns in a red section above everything.


-- =====================================================================
-- SECTION 1 -- Columns
-- =====================================================================

alter table public.suggestions
    add column if not exists concern            boolean not null default false,
    add column if not exists concern_handled_at timestamptz,
    add column if not exists concern_handled_by uuid references auth.users(id) on delete set null;


-- =====================================================================
-- SECTION 2 -- Students never see a concern
-- =====================================================================
-- Same columns, options and check as setup-tighten-grants.sql; one extra
-- condition. Grants survive a replace.

create or replace view public.public_suggestions
with (security_barrier = true) as
select id, suggestion, category, summary, created_at, status, benefit
  from public.suggestions
 where status in ('approved', 'actioned')
   and not concern
   and public.board_access_error() is null
with cascaded check option;


-- =====================================================================
-- SECTION 3 -- Submitting
-- =====================================================================
-- Gains p_concern, so the 9-argument version is dropped first.

drop function if exists public.submit_suggestion(text, text, text, text, text, text, text, text, text);

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
    p_concern      boolean default false
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

    -- A concern is never spam-binned and never treated as a duplicate: it
    -- always reaches a person.
    if v_concern then
        new_status := 'pending';
    end if;

    if not v_concern and new_status = 'pending'
       and p_topic is not null and length(trim(p_topic)) > 0 then
        select duplicate_threshold into threshold from public.app_config where id;

        select s.id, s.suggestion
          into dup_id, dup_text
          from public.suggestions s
         where s.status in ('approved', 'pending', 'actioned')
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

    insert into public.suggestions
        (suggestion, benefit, spam, feasibility, category, reason, summary,
         votes, status, topic, decided_by, decided_at, concern)
    values
        (p_suggestion, v_benefit, p_spam, p_feasibility, p_category, p_reason, p_summary,
         0, new_status, p_topic,
         case when new_status = 'pending' then null else 'ai'  end,
         case when new_status = 'pending' then null else now() end,
         v_concern)
    returning id into new_id;

    return jsonb_build_object('id', new_id, 'status', new_status, 'concern', v_concern);
end;
$$;

revoke all on function public.submit_suggestion(text,text,text,text,text,text,text,text,text,boolean) from public;
grant execute on function public.submit_suggestion(text,text,text,text,text,text,text,text,text,boolean)
    to anon, authenticated;


-- =====================================================================
-- SECTION 4 -- Staff: list, decide, resolve
-- =====================================================================

drop function if exists public.staff_suggestions();

create function public.staff_suggestions()
returns table (
    id                 bigint,
    suggestion         text,
    benefit            text,
    spam               text,
    feasibility        text,
    category           text,
    reason             text,
    summary            text,
    votes              bigint,
    status             text,
    decided_by         text,
    decided_at         timestamptz,
    reviewer           text,
    created_at         timestamptz,
    concern            boolean,
    concern_handled_at timestamptz,
    concern_handled_by text
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

    return query
        select s.id, s.suggestion, s.benefit, s.spam, s.feasibility, s.category,
               s.reason, s.summary, s.votes, s.status, s.decided_by, s.decided_at,
               u.email::text, s.created_at,
               s.concern, s.concern_handled_at, h.email::text
          from public.suggestions s
          left join auth.users u on u.id = s.reviewed_by
          left join auth.users h on h.id = s.concern_handled_by
         order by
               (s.concern and s.concern_handled_at is null) desc,
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

-- Same signature as before; now refuses to publish a concern.
create or replace function public.staff_set_status(p_id bigint, p_status text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    new_status text;
    is_concern boolean;
begin
    if not public.is_staff() then
        raise exception 'Staff access required'
            using errcode = 'insufficient_privilege';
    end if;

    if p_status not in ('pending', 'approved', 'rejected', 'spam', 'actioned') then
        raise exception 'Invalid status: %', p_status;
    end if;

    select concern into is_concern from public.suggestions where id = p_id;
    if is_concern and p_status in ('approved', 'actioned') then
        raise exception 'This is flagged as a wellbeing concern, so it cannot be shown to students. If it was flagged by mistake, choose "Not a concern" first.';
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

-- p_outcome: 'handled'      passed on to pastoral care; stays a concern,
--                           hidden from students, moves to "Handled"
--            'not_concern'  flagged by mistake; back to the normal queue
--            'reopen'       undo 'handled'
create or replace function public.staff_resolve_concern(p_id bigint, p_outcome text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_staff() then
        raise exception 'Staff access required'
            using errcode = 'insufficient_privilege';
    end if;

    if p_outcome = 'handled' then
        update public.suggestions
           set concern_handled_at = now(), concern_handled_by = auth.uid()
         where id = p_id and concern;
    elsif p_outcome = 'reopen' then
        update public.suggestions
           set concern_handled_at = null, concern_handled_by = null
         where id = p_id and concern;
    elsif p_outcome = 'not_concern' then
        update public.suggestions
           set concern = false, concern_handled_at = now(), concern_handled_by = auth.uid()
         where id = p_id;
    else
        raise exception 'Invalid outcome: %', p_outcome;
    end if;

    if not found then
        raise exception 'Suggestion % not found', p_id using errcode = 'no_data_found';
    end if;
end;
$$;

revoke all on function public.staff_suggestions() from public, anon;
revoke all on function public.staff_set_status(bigint, text) from public, anon;
revoke all on function public.staff_resolve_concern(bigint, text) from public, anon;
grant execute on function public.staff_suggestions() to authenticated;
grant execute on function public.staff_set_status(bigint, text) to authenticated;
grant execute on function public.staff_resolve_concern(bigint, text) to authenticated;


-- =====================================================================
-- SECTION 5 -- Anything already in the database
-- =====================================================================
-- Earlier submissions the AI answered with the counsellor wording.

update public.suggestions
   set concern = true
 where not concern
   and reason like 'This sounds like a personal concern%';

notify pgrst, 'reload schema';

-- Expected: how many are flagged (probably 0).
select count(*) filter (where concern) as concerns,
       count(*) filter (where concern and concern_handled_at is null) as open
  from public.suggestions;
