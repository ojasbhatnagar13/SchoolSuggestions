-- SchoolSuggestions -- staff reasons, "My suggestions" page, site feedback
-- Run AFTER docs/setup-hide-reviewers.sql.
--
-- 1. STAFF REASONS. When staff reject a suggestion they are asked (optional)
--    for one sentence on why. It is shown to the student on their My
--    suggestions page. "Explain the no's": a reason lands far better than
--    silence.
--
-- 2. MY SUGGESTIONS. my_suggestions() now returns the reason, and leaves out
--    anything marked spam (which includes offensive or abusive messages) --
--    the page says so.
--
-- 3. SITE FEEDBACK. Signed-in users can tell the school about the site itself
--    (something broken, an improvement). Staff read it on the staff page. The
--    sender's account is kept only to cap feedback at 5 a day and is never
--    shown to anyone. Times are rounded to the hour.


-- =====================================================================
-- SECTION 1 -- Staff reasons
-- =====================================================================

alter table public.suggestions
    add column if not exists staff_reason text
        check (staff_reason is null or length(staff_reason) <= 500);

create or replace function public.staff_set_reason(p_id bigint, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_staff() then
        raise exception 'Staff access required' using errcode = 'insufficient_privilege';
    end if;
    if length(coalesce(p_reason, '')) > 500 then
        raise exception 'Keep the reason under 500 characters.';
    end if;
    update public.suggestions
       set staff_reason = nullif(trim(coalesce(p_reason, '')), '')
     where id = p_id;
    if not found then
        raise exception 'Suggestion % not found', p_id;
    end if;
end;
$$;

revoke all on function public.staff_set_reason(bigint, text) from public, anon;
grant execute on function public.staff_set_reason(bigint, text) to authenticated;


-- =====================================================================
-- SECTION 2 -- Staff list gains the reason (never staff names)
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
    ai_status           text,
    staff_reason        text
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

    -- reviewer, concern_handled_by and reworder: deliberately null
    -- (docs/setup-hide-reviewers.sql).
    return query
        select s.id, s.suggestion, s.benefit, s.spam, s.feasibility, s.category,
               s.reason, s.summary, s.votes, s.status, s.decided_by, s.decided_at,
               null::text, s.created_at,
               s.concern, s.concern_handled_at, null::text,
               s.flags, s.original_suggestion, s.original_benefit, s.reworded_at, null::text,
               s.ai_status, s.staff_reason
          from public.suggestions s
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
-- SECTION 3 -- My suggestions: reasons in, spam out
-- =====================================================================

drop function if exists public.my_suggestions();

create function public.my_suggestions()
returns table (
    id         bigint,
    suggestion text,
    status     text,
    created_at timestamptz,
    decided_at timestamptz,
    unseen     boolean,
    reason     text
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
           public.student_status(s.status) is distinct from s.author_seen_status,
           -- The staff reason if they gave one; otherwise, for something the
           -- AI turned down, the AI's reason (which the student saw at the
           -- time). Nothing for suggestions that are still going.
           case
               when s.staff_reason is not null then s.staff_reason
               when s.status = 'rejected' and s.decided_by = 'ai' then s.reason
           end
      from public.suggestions s
     where auth.uid() is not null
       and s.author_id = auth.uid()
       and not s.concern
       and s.status <> 'spam'          -- spam and offensive messages are not listed
     order by s.created_at desc, s.id desc
     limit 50;
$$;

revoke all on function public.my_suggestions() from public, anon;
grant execute on function public.my_suggestions() to authenticated;


-- =====================================================================
-- SECTION 4 -- Feedback about the site
-- =====================================================================

create table if not exists public.site_feedback (
    id         bigint generated always as identity primary key,
    kind       text not null check (kind in ('broken', 'improve', 'other')),
    message    text not null check (length(message) between 3 and 1000),
    page       text check (length(page) <= 100),
    created_at timestamptz not null default date_trunc('hour', now()),
    -- Only to cap feedback at 5 a day. Never returned by any function.
    user_id    uuid references auth.users(id) on delete set null,
    handled    boolean not null default false
);

alter table public.site_feedback enable row level security;
revoke all on public.site_feedback from anon, authenticated;

create or replace function public.send_feedback(p_kind text, p_message text, p_page text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_message text := trim(coalesce(p_message, ''));
begin
    if auth.uid() is null then
        raise exception 'Please sign in first.' using errcode = 'insufficient_privilege';
    end if;
    if p_kind not in ('broken', 'improve', 'other') then
        raise exception 'Choose what kind of feedback this is.';
    end if;
    if length(v_message) < 3 then
        raise exception 'Please write a little more.';
    end if;
    if length(v_message) > 1000 then
        raise exception 'Feedback is limited to 1000 characters.';
    end if;
    if (select count(*) from public.site_feedback
         where user_id = auth.uid() and created_at > now() - interval '1 day') >= 5 then
        raise exception 'You have sent 5 pieces of feedback today. Please try again tomorrow.';
    end if;

    insert into public.site_feedback (kind, message, page, user_id)
    values (p_kind, v_message, left(nullif(trim(coalesce(p_page, '')), ''), 100), auth.uid());
end;
$$;

create or replace function public.staff_feedback()
returns table (id bigint, kind text, message text, page text, created_at timestamptz, handled boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.is_staff() then
        raise exception 'Staff access required' using errcode = 'insufficient_privilege';
    end if;
    -- user_id is never returned.
    return query
        select f.id, f.kind, f.message, f.page, f.created_at, f.handled
          from public.site_feedback f
         order by f.handled, f.created_at desc, f.id desc
         limit 200;
end;
$$;

create or replace function public.staff_mark_feedback(p_id bigint, p_handled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_staff() then
        raise exception 'Staff access required' using errcode = 'insufficient_privilege';
    end if;
    update public.site_feedback set handled = coalesce(p_handled, true) where id = p_id;
end;
$$;

revoke all on function public.send_feedback(text, text, text) from public, anon;
revoke all on function public.staff_feedback() from public, anon;
revoke all on function public.staff_mark_feedback(bigint, boolean) from public, anon;
grant execute on function public.send_feedback(text, text, text) to authenticated;
grant execute on function public.staff_feedback() to authenticated;
grant execute on function public.staff_mark_feedback(bigint, boolean) to authenticated;

notify pgrst, 'reload schema';

-- Expected: true, false, false.
select exists (select 1 from information_schema.columns where table_schema = 'public'
                and table_name = 'suggestions' and column_name = 'staff_reason') as has_staff_reason,
       pg_get_functiondef('public.staff_feedback'::regproc) like '%user_id,%' as feedback_returns_sender,
       pg_get_functiondef('public.staff_suggestions'::regproc) like '%auth.users%' as staff_list_names_staff;
