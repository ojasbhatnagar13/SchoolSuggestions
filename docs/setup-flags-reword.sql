-- SchoolSuggestions -- wording warnings and staff rewording
-- Run AFTER docs/setup-owner-access.sql.
--
-- 1. FLAGS. The AI tags each suggestion with any wording problems, shown to
--    staff as coloured warnings:
--      no_suggestion     states a problem or opinion but asks for nothing
--      rude              a real suggestion or issue phrased with insults
--      sarcastic         sarcastic or mocking wording
--      unclear           hard to tell what is being asked for
--      several_requests  more than one unrelated request
--      names_person      mentions a specific teacher, staff member or student
--      hidden_concern    a normal suggestion with a report of harm inside it
--                        (also sets concern, so it goes to the red section)
--
-- 2. REWORDING. A teacher can replace a suggestion's wording (and its "how it
--    helps" text) with a clearer, respectful version -- usually drafted by
--    the AI, always checked by the teacher. Students only see the new
--    wording. The student's original is kept for staff and can be restored.

alter table public.suggestions
    add column if not exists flags               text[] not null default '{}',
    add column if not exists original_suggestion text,
    add column if not exists original_benefit    text,
    add column if not exists reworded_by         uuid references auth.users(id) on delete set null,
    add column if not exists reworded_at         timestamptz;

create or replace function public.valid_flags(p_flags text[])
returns text[]
language sql
immutable
set search_path = public
as $$
    -- Keep only known flags, once each, so the AI cannot invent new ones.
    select coalesce(array_agg(distinct f order by f), '{}')
      from unnest(coalesce(p_flags, '{}')) as f
     where f in ('no_suggestion', 'rude', 'sarcastic', 'unclear',
                 'several_requests', 'names_person', 'hidden_concern');
$$;
revoke all on function public.valid_flags(text[]) from public, anon, authenticated;


-- =====================================================================
-- Submitting stores the flags
-- =====================================================================
-- Gains p_flags, so the 12-argument version is dropped first.

drop function if exists public.submit_suggestion(text, text, text, text, text, text, text, text, text, boolean, text, uuid);

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
    p_author       uuid default null,
    p_flags        text[] default null
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
    v_flags    text[] := public.valid_flags(p_flags);
    v_concern  boolean := coalesce(p_concern, false) or 'hidden_concern' = any (public.valid_flags(p_flags));
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

    insert into public.suggestions
        (suggestion, benefit, spam, feasibility, category, reason, summary,
         votes, status, topic, decided_by, decided_at, concern,
         author_id, author_seen_status, flags)
    values
        (p_suggestion, v_benefit, p_spam, p_feasibility, p_category, p_reason, p_summary,
         0, new_status, p_topic,
         case when new_status = 'pending' then null else 'ai'  end,
         case when new_status = 'pending' then null else now() end,
         v_concern,
         p_author, public.student_status(new_status), v_flags)
    returning id into new_id;

    return jsonb_build_object('id', new_id, 'status', new_status, 'concern', v_concern);
end;
$$;

revoke all on function public.submit_suggestion(text,text,text,text,text,text,text,text,text,boolean,text,uuid,text[]) from public;
grant execute on function public.submit_suggestion(text,text,text,text,text,text,text,text,text,boolean,text,uuid,text[])
    to anon, authenticated;


-- =====================================================================
-- Staff list gains flags and rewording (never the sender)
-- =====================================================================

drop function if exists public.staff_suggestions();

create function public.staff_suggestions()
returns table (
    id                  bigint,
    suggestion          text,
    benefit             text,
    spam                text,
    feasibility         text,
    category            text,
    reason              text,
    summary             text,
    votes               bigint,
    status              text,
    decided_by          text,
    decided_at          timestamptz,
    reviewer            text,
    created_at          timestamptz,
    concern             boolean,
    concern_handled_at  timestamptz,
    concern_handled_by  text,
    flags               text[],
    original_suggestion text,
    original_benefit    text,
    reworded_at         timestamptz,
    reworder            text
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
               s.concern, s.concern_handled_at, h.email::text,
               s.flags, s.original_suggestion, s.original_benefit, s.reworded_at, w.email::text
          from public.suggestions s
          left join auth.users u on u.id = s.reviewed_by
          left join auth.users h on h.id = s.concern_handled_by
          left join auth.users w on w.id = s.reworded_by
         order by
               (s.concern and s.concern_handled_at is null) desc,
               case s.status
                   when 'pending'  then 0
                   when 'approved' then 1
                   when 'accepted' then 2
                   when 'actioned' then 3
                   when 'rejected' then 4
                   else 5
               end,
               s.created_at desc, s.id desc;
end;
$$;

revoke all on function public.staff_suggestions() from public, anon;
grant execute on function public.staff_suggestions() to authenticated;


-- =====================================================================
-- Rewording
-- =====================================================================

create or replace function public.staff_reword(p_id bigint, p_suggestion text, p_benefit text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_text    text := trim(coalesce(p_suggestion, ''));
    v_benefit text := nullif(trim(coalesce(p_benefit, '')), '');
begin
    if not public.is_staff() then
        raise exception 'Staff access required' using errcode = 'insufficient_privilege';
    end if;
    if length(v_text) < 3 then
        raise exception 'The suggestion cannot be empty.';
    end if;
    if length(v_text) > 2000 or length(coalesce(v_benefit, '')) > 1000 then
        raise exception 'Too long: 2000 characters for the suggestion, 1000 for how it helps.';
    end if;

    -- The student's own words are saved the first time only, so rewording
    -- twice never loses them.
    update public.suggestions
       set original_suggestion = coalesce(original_suggestion, suggestion),
           original_benefit    = case when original_suggestion is null then benefit else original_benefit end,
           suggestion          = v_text,
           benefit             = v_benefit,
           reworded_by         = auth.uid(),
           reworded_at         = now()
     where id = p_id and not concern;

    if not found then
        raise exception 'Suggestion % not found, or it is a wellbeing concern (those are never reworded or shown).', p_id;
    end if;
end;
$$;

create or replace function public.staff_restore_original(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_staff() then
        raise exception 'Staff access required' using errcode = 'insufficient_privilege';
    end if;

    update public.suggestions
       set suggestion          = original_suggestion,
           benefit             = original_benefit,
           original_suggestion = null,
           original_benefit    = null,
           reworded_by         = null,
           reworded_at         = null
     where id = p_id and original_suggestion is not null;

    if not found then
        raise exception 'Suggestion % has not been reworded.', p_id;
    end if;
end;
$$;

revoke all on function public.staff_reword(bigint, text, text) from public, anon;
revoke all on function public.staff_restore_original(bigint) from public, anon;
grant execute on function public.staff_reword(bigint, text, text) to authenticated;
grant execute on function public.staff_restore_original(bigint) to authenticated;

notify pgrst, 'reload schema';

-- Expected: flags column exists; staff list has flags and no sender column.
select
    exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'suggestions' and column_name = 'flags') as has_flags,
    (select array_to_string(proargnames, ',') like '%author%'
       from pg_proc where proname = 'staff_suggestions') as staff_sees_author;
