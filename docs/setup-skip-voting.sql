-- SchoolSuggestions -- suggestions that skip voting
-- Run AFTER docs/setup-new-label.sql.
--
-- Principal's feedback (2026-11): some suggestions don't need a vote -- a
-- broken tap, a missing sign, a safety fix. Staff can now approve one as
-- 'accepted': going ahead, no vote needed. Students see it in its own section
-- on the home page with no vote button. vote_for_suggestion already only
-- accepts status 'approved', so the database itself refuses votes on these.
--
-- Also: student-facing wording in the database says "suggestion", not "idea".


-- =====================================================================
-- SECTION 1 -- The new status
-- =====================================================================

alter table public.suggestions drop constraint if exists suggestions_status_check;
alter table public.suggestions
    add constraint suggestions_status_check
    check (status in ('pending', 'approved', 'accepted', 'rejected', 'spam', 'actioned'));


-- =====================================================================
-- SECTION 2 -- Students see it
-- =====================================================================
-- Same columns, options and check as setup-new-label.sql.

create or replace view public.public_suggestions
with (security_barrier = true) as
select id, suggestion, category, summary, created_at, status, benefit, decided_at
  from public.suggestions
 where status in ('approved', 'accepted', 'actioned')
   and not concern
   and public.board_access_error() is null
with cascaded check option;


-- =====================================================================
-- SECTION 3 -- Staff can set it
-- =====================================================================

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

    if p_status not in ('pending', 'approved', 'accepted', 'rejected', 'spam', 'actioned') then
        raise exception 'Invalid status: %', p_status;
    end if;

    select concern into is_concern from public.suggestions where id = p_id;
    if is_concern and p_status in ('approved', 'accepted', 'actioned') then
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

-- Same return type as setup-concerns.sql; only the sort order changes
-- (accepted sits with approved).
create or replace function public.staff_suggestions()
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
                   when 'accepted' then 2
                   when 'actioned' then 3
                   when 'rejected' then 4
                   else 5
               end,
               s.created_at desc, s.id desc;
end;
$$;


-- =====================================================================
-- SECTION 4 -- A going-ahead suggestion still counts for duplicates
-- =====================================================================
-- Same signature as setup-receipts.sql, so a plain replace; only the list of
-- live statuses changes.

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

    -- p_receipt is accepted for compatibility but no longer stored
    -- (docs/setup-remove-receipts.sql).
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


-- =====================================================================
-- SECTION 5 -- Wording: "suggestions", not "ideas"
-- =====================================================================
-- Same body as setup-signin-submit.sql; only the two messages change.

create or replace function public.claim_account_slot(p_secret text, p_account_hash text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    this_hour timestamptz := date_trunc('hour', now());
    lim_hour  int;
    lim_day   int;
    used_hour int;
    used_day  int;
begin
    if not public.submit_secret_ok(p_secret) then
        raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;

    if p_account_hash is null or length(p_account_hash) < 32 then
        raise exception 'Invalid account token' using errcode = 'invalid_parameter_value';
    end if;

    select coalesce(account_per_hour, 5), coalesce(account_per_day, 20)
      into lim_hour, lim_day
      from public.app_config where id;
    lim_hour := coalesce(lim_hour, 5);
    lim_day  := coalesce(lim_day, 20);

    delete from public.submission_quota where hour < now() - interval '2 days';

    select coalesce(sum(used) filter (where hour = this_hour), 0),
           coalesce(sum(used), 0)
      into used_hour, used_day
      from public.submission_quota
     where account_hash = p_account_hash
       and hour > now() - interval '24 hours';

    if used_hour >= lim_hour then
        raise exception 'You have sent % suggestions this hour. You can send more after the hour is up.', lim_hour;
    end if;
    if used_day >= lim_day then
        raise exception 'You have sent % suggestions today. Please try again tomorrow.', lim_day;
    end if;

    insert into public.submission_quota (account_hash, hour, used)
    values (p_account_hash, this_hour, 1)
    on conflict (account_hash, hour) do update set used = submission_quota.used + 1;

    return lim_day - used_day - 1;
end;
$$;

notify pgrst, 'reload schema';

-- Expected: the new status is allowed, and the view still reads only.
select pg_get_constraintdef(oid) as status_check
  from pg_constraint where conname = 'suggestions_status_check';
