-- SchoolSuggestions -- a queue for suggestions the AI could not check yet
-- Run AFTER docs/setup-live-topics.sql.
--
-- WHY
--
-- tests/eval/burst.py (2026-11-19): with 30 students sending at once on the
-- free Gemini tier, 12 of 30 got no AI check and were saved unchecked.
--
-- NOW
--
-- 1. The Edge Function keeps retrying for about 15 seconds while the student
--    watches a loading animation (most busy spells clear by then).
-- 2. If it still cannot get a check, the suggestion is saved as QUEUED
--    (ai_status = 'queued') instead of unchecked.
-- 3. Every minute, pg_cron asks the Edge Function to check queued
--    suggestions, oldest first, a few at a time. Only when something is
--    queued -- an empty queue costs nothing.
-- 4. A queued suggestion is checked exactly like a fresh one, including
--    duplicates and wellbeing concerns. If it turns out to be a duplicate it
--    is set to rejected with the reason, which the student sees under "Your
--    suggestions". If staff already decided on it, their decision stands
--    and the AI only fills in its verdict.
-- 5. After 20 failed attempts it stops retrying and stays with staff,
--    marked as never screened.


-- =====================================================================
-- SECTION 1 -- Columns
-- =====================================================================

alter table public.suggestions
    add column if not exists ai_status   text not null default 'checked'
        check (ai_status in ('checked', 'queued')),
    add column if not exists ai_attempts int  not null default 0;

create index if not exists suggestions_ai_queue on public.suggestions (created_at)
    where ai_status = 'queued';


-- =====================================================================
-- SECTION 2 -- Submitting can queue
-- =====================================================================
-- Gains p_queued, so the 13-argument version is dropped first.

drop function if exists public.submit_suggestion(text, text, text, text, text, text, text, text, text, boolean, text, uuid, text[]);

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
    p_flags        text[] default null,
    p_queued       boolean default false
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
    v_queued   boolean := coalesce(p_queued, false);
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

    -- Queued and concern rows always wait for a person or the queue.
    if v_concern or v_queued then
        new_status := 'pending';
    end if;

    if not v_concern and not v_queued and new_status = 'pending'
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
         author_id, author_seen_status, flags, ai_status)
    values
        (p_suggestion, v_benefit, p_spam, p_feasibility, p_category, p_reason, p_summary,
         0, new_status, p_topic,
         case when new_status = 'pending' then null else 'ai'  end,
         case when new_status = 'pending' then null else now() end,
         v_concern,
         p_author, public.student_status(new_status), v_flags,
         case when v_queued then 'queued' else 'checked' end)
    returning id into new_id;

    return jsonb_build_object('id', new_id, 'status', new_status, 'concern', v_concern,
                              'queued', v_queued);
end;
$$;

revoke all on function public.submit_suggestion(text,text,text,text,text,text,text,text,text,boolean,text,uuid,text[],boolean) from public;
grant execute on function public.submit_suggestion(text,text,text,text,text,text,text,text,text,boolean,text,uuid,text[],boolean)
    to anon, authenticated;


-- =====================================================================
-- SECTION 3 -- Working through the queue (Edge Function only)
-- =====================================================================

create or replace function public.queued_suggestions(p_secret text, p_limit int default 5)
returns table (id bigint, suggestion text, benefit text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.submit_secret_ok(p_secret) then
        raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;
    return query
        select s.id, s.suggestion, s.benefit
          from public.suggestions s
         where s.ai_status = 'queued'
         order by s.created_at, s.id
         limit least(greatest(coalesce(p_limit, 5), 1), 10);
end;
$$;

create or replace function public.apply_ai_check(
    p_secret      text,
    p_id          bigint,
    p_spam        text,
    p_feasibility text,
    p_category    text,
    p_reason      text,
    p_summary     text,
    p_topic       text,
    p_flags       text[],
    p_concern     boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_flags     text[] := public.valid_flags(p_flags);
    v_concern   boolean := coalesce(p_concern, false) or 'hidden_concern' = any (public.valid_flags(p_flags));
    new_status  text := public.auto_status(p_spam, p_feasibility);
    v_reason    text := p_reason;
    staff_owned boolean;
    threshold   real;
    dup_id      bigint;
begin
    if not public.submit_secret_ok(p_secret) then
        raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;

    select decided_by = 'staff' into staff_owned
      from public.suggestions where id = p_id and ai_status = 'queued';
    if not found then
        return jsonb_build_object('id', p_id, 'result', 'not queued');
    end if;

    if v_concern then
        new_status := 'pending';
    elsif new_status = 'pending' and p_topic is not null and length(trim(p_topic)) > 0 then
        select duplicate_threshold into threshold from public.app_config where id;
        select s.id into dup_id
          from public.suggestions s
         where s.id <> p_id
           and s.status in ('approved', 'accepted', 'pending', 'actioned')
           and s.ai_status = 'checked'
           and not s.concern
           and s.topic is not null
           and greatest(
                   similarity(s.topic, p_topic),
                   word_similarity(p_topic, s.topic),
                   word_similarity(s.topic, p_topic)
               ) >= coalesce(threshold, 0.55)
         order by s.created_at
         limit 1;
        if dup_id is not null then
            new_status := 'rejected';
            v_reason := format('Someone had already suggested this (#%s), so it was not filed twice.', dup_id);
        end if;
    end if;

    update public.suggestions
       set spam        = p_spam,
           feasibility = p_feasibility,
           category    = p_category,
           reason      = v_reason,
           summary     = p_summary,
           topic       = p_topic,
           flags       = v_flags,
           concern     = concern or v_concern,
           ai_status   = 'checked',
           -- A decision staff already made stands; the AI only adds its view.
           status      = case when coalesce(staff_owned, false) then status else new_status end,
           decided_by  = case when coalesce(staff_owned, false) then decided_by
                              when new_status = 'pending' then null else 'ai' end,
           decided_at  = case when coalesce(staff_owned, false) then decided_at
                              when new_status = 'pending' then null else now() end
     where id = p_id;

    return jsonb_build_object('id', p_id, 'result', case when dup_id is not null then 'duplicate' else new_status end);
end;
$$;

create or replace function public.queue_attempt_failed(p_secret text, p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.submit_secret_ok(p_secret) then
        raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;
    update public.suggestions
       set ai_attempts = ai_attempts + 1,
           -- Give up after 20 tries: it stays with staff, marked never screened.
           ai_status   = case when ai_attempts + 1 >= 20 then 'checked' else ai_status end
     where id = p_id and ai_status = 'queued';
end;
$$;

revoke all on function public.queued_suggestions(text, int) from public;
revoke all on function public.apply_ai_check(text, bigint, text, text, text, text, text, text, text[], boolean) from public;
revoke all on function public.queue_attempt_failed(text, bigint) from public;
grant execute on function public.queued_suggestions(text, int) to anon, authenticated;
grant execute on function public.apply_ai_check(text, bigint, text, text, text, text, text, text, text[], boolean) to anon, authenticated;
grant execute on function public.queue_attempt_failed(text, bigint) to anon, authenticated;


-- =====================================================================
-- SECTION 4 -- Staff see what is still queued
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
    reworder            text,
    ai_status           text
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
               s.flags, s.original_suggestion, s.original_benefit, s.reworded_at, w.email::text,
               s.ai_status
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
-- SECTION 5 -- The once-a-minute nudge
-- =====================================================================
-- pg_cron runs inside the database; pg_net lets it call the Edge Function.
-- The request carries the server secret in a header, which is how the
-- function knows it is the queue runner and not a student. The anon key in
-- it is public by design (frontend/config.js).

create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'ai-queue';

select cron.schedule(
    'ai-queue',
    '* * * * *',
    $job$
    select net.http_post(
        url     := 'https://ywyjhgpcokrtzibcrqes.supabase.co/functions/v1/moderate-suggestion',
        headers := jsonb_build_object(
            'Content-Type',   'application/json',
            'apikey',         'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3eWpoZ3Bjb2tydHppYmNycWVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2OTQ1MDcsImV4cCI6MjEwMDI3MDUwN30.fyKWPSG31gbxviEIp45FozViqov7VL9elZBqKzFA-YA',
            'Authorization',  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3eWpoZ3Bjb2tydHppYmNycWVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2OTQ1MDcsImV4cCI6MjEwMDI3MDUwN30.fyKWPSG31gbxviEIp45FozViqov7VL9elZBqKzFA-YA',
            'x-queue-secret', (select submit_secret from public.app_config where id)
        ),
        body    := '{"queue": true}'::jsonb,
        timeout_milliseconds := 60000
    )
    where exists (select 1 from public.suggestions where ai_status = 'queued');
    $job$
);

notify pgrst, 'reload schema';

select jobname, schedule, active from cron.job where jobname = 'ai-queue';
