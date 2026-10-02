-- SchoolSuggestions -- private receipts, and send times rounded to the hour
-- Run AFTER docs/setup-concerns.sql.
--
-- RECEIPTS
--
-- A student is told when their idea is approved, marked Done, or not taken
-- forward, without the idea being linked to their account. When they send
-- one, their browser makes a random receipt code and keeps it. The database
-- stores only a SHA-256 hash of the code next to the idea. Later the browser
-- asks receipt_statuses() about the codes it holds.
--
-- Holding a code is the only way to ask about an idea, and the codes are 64
-- random hex characters, so they cannot be guessed. Nothing ties a code to an
-- account: it lives only in that browser, so it works on that device only.
--
-- ROUNDED TIMES
--
-- Ideas used to be stored with the exact second they were sent. Someone who
-- saw a student on their laptop at 10:03 could match that to an idea that
-- arrived at 10:03. Ideas now record only the hour, which is all the staff
-- page and the Ideas page need. (The per-account rate limit already stores
-- only the hour, so the two now give away the same, coarser, information.)


-- =====================================================================
-- SECTION 1 -- Columns and rounding
-- =====================================================================

alter table public.suggestions
    add column if not exists receipt_hash text;

create unique index if not exists suggestions_receipt_hash
    on public.suggestions (receipt_hash) where receipt_hash is not null;

alter table public.suggestions
    alter column created_at set default date_trunc('hour', now());

update public.suggestions
   set created_at = date_trunc('hour', created_at)
 where created_at <> date_trunc('hour', created_at);


-- =====================================================================
-- SECTION 2 -- Submitting stores the receipt's hash
-- =====================================================================
-- Gains p_receipt, so the 10-argument version is dropped first. The raw code
-- is hashed here and never stored.

drop function if exists public.submit_suggestion(text, text, text, text, text, text, text, text, text, boolean);

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
    p_receipt      text default null
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
    v_receipt  text;
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

    -- Only well-formed codes are kept; anything else is simply ignored, so a
    -- bad receipt never costs a student their idea.
    if p_receipt ~ '^[0-9a-f]{64}$' then
        v_receipt := encode(sha256(convert_to(p_receipt, 'UTF8')), 'hex');
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
         votes, status, topic, decided_by, decided_at, concern, receipt_hash)
    values
        (p_suggestion, v_benefit, p_spam, p_feasibility, p_category, p_reason, p_summary,
         0, new_status, p_topic,
         case when new_status = 'pending' then null else 'ai'  end,
         case when new_status = 'pending' then null else now() end,
         v_concern, v_receipt)
    returning id into new_id;

    return jsonb_build_object('id', new_id, 'status', new_status, 'concern', v_concern);
end;
$$;

revoke all on function public.submit_suggestion(text,text,text,text,text,text,text,text,text,boolean,text) from public;
grant execute on function public.submit_suggestion(text,text,text,text,text,text,text,text,text,boolean,text)
    to anon, authenticated;


-- =====================================================================
-- SECTION 3 -- Looking receipts up
-- =====================================================================
-- Callable signed in or not: holding the code is the proof. Returns only
-- what the student already knows (their own idea) plus where it stands.
-- Wellbeing concerns are never returned.

create or replace function public.receipt_statuses(p_receipts text[])
returns table (
    id         bigint,
    suggestion text,
    status     text,
    changed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
    select s.id,
           left(s.suggestion, 140),
           case s.status
               when 'approved' then 'approved'
               when 'actioned' then 'done'
               when 'pending'  then 'waiting'
               else 'not_taken_forward'
           end,
           s.decided_at
      from public.suggestions s
     where s.receipt_hash = any (
               select encode(sha256(convert_to(r, 'UTF8')), 'hex')
                 from unnest(p_receipts[1:50]) as r
                where r ~ '^[0-9a-f]{64}$'
           )
       and not s.concern;
$$;

revoke all on function public.receipt_statuses(text[]) from public;
grant execute on function public.receipt_statuses(text[]) to anon, authenticated;

notify pgrst, 'reload schema';

-- Expected: every created_at on the hour, and the new default in place.
select count(*) filter (where created_at <> date_trunc('hour', created_at)) as not_rounded,
       (select column_default from information_schema.columns
         where table_schema = 'public' and table_name = 'suggestions'
           and column_name = 'created_at') as created_at_default
  from public.suggestions;
