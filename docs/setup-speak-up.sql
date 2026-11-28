-- SchoolSuggestions -- "Speak Up": tell teachers about something wrong
-- Run AFTER docs/setup-class-totals.sql.
--
-- A second box on the home page (principal's request, 2026-11). A student who
-- sees something wrong -- bullying, cheating, theft, vaping, damage, anything
-- unsafe -- can tell staff.
--
--   * Anonymous by default: NOTHING about the account is stored with a
--     report, not even privately. The only trace is the hourly rate-limit
--     hash every send already leaves (salted, deleted after two days).
--   * The student can choose to include their name, e.g. when it involves
--     them. Only then is their email stored, and staff see it.
--   * Reports are never shown to students and never go on any public page.
--   * Time is rounded to the hour, like suggestions.

create table if not exists public.reports (
    id             bigint generated always as identity primary key,
    created_at     timestamptz not null default date_trunc('hour', now()),
    report         text not null check (char_length(report) between 1 and 2000),
    place          text check (place is null or char_length(place) <= 300),
    reporter_email text,              -- only when the student chose to include it
    category       text,              -- from the AI: Bullying, Safety, ...
    urgency        text not null default 'normal' check (urgency in ('urgent', 'normal')),
    summary        text,
    checked        boolean not null default true,  -- false: the AI was busy
    status         text not null default 'new' check (status in ('new', 'in_hand', 'closed'))
);
alter table public.reports enable row level security;
revoke all on public.reports from public, anon, authenticated;
-- No policies on purpose: only the functions below can touch it.

-- Written by the Edge Function, which proves itself with the server secret.
create or replace function public.submit_report(
    p_secret text, p_report text, p_place text, p_email text,
    p_category text, p_urgency text, p_summary text, p_checked boolean)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    new_id bigint;
begin
    if not public.submit_secret_ok(p_secret) then
        raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;
    insert into public.reports (report, place, reporter_email, category, urgency, summary, checked)
    values (left(p_report, 2000), nullif(left(coalesce(p_place, ''), 300), ''), nullif(p_email, ''),
            nullif(left(coalesce(p_category, ''), 60), ''),
            case when p_urgency = 'urgent' then 'urgent' else 'normal' end,
            nullif(left(coalesce(p_summary, ''), 400), ''), coalesce(p_checked, true))
    returning id into new_id;
    return new_id;
end;
$$;
revoke all on function public.submit_report(text, text, text, text, text, text, text, boolean) from public;
grant execute on function public.submit_report(text, text, text, text, text, text, text, boolean) to anon, authenticated;

create or replace function public.staff_reports()
returns table (id bigint, created_at timestamptz, report text, place text, reporter_email text,
               category text, urgency text, summary text, checked boolean, status text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.is_staff() then
        raise exception 'Staff access required' using errcode = 'insufficient_privilege';
    end if;
    return query
        select r.id, r.created_at, r.report, r.place, r.reporter_email,
               r.category, r.urgency, r.summary, r.checked, r.status
          from public.reports r
         order by (r.status = 'closed'), (r.urgency = 'urgent') desc, r.created_at desc, r.id desc
         limit 300;
end;
$$;

create or replace function public.staff_set_report_status(p_id bigint, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_staff() then
        raise exception 'Staff access required' using errcode = 'insufficient_privilege';
    end if;
    if p_status not in ('new', 'in_hand', 'closed') then
        raise exception 'Unknown status';
    end if;
    update public.reports set status = p_status where id = p_id;
end;
$$;

revoke all on function public.staff_reports() from public, anon;
revoke all on function public.staff_set_report_status(bigint, text) from public, anon;
grant execute on function public.staff_reports() to authenticated;
grant execute on function public.staff_set_report_status(bigint, text) to authenticated;

notify pgrst, 'reload schema';

select 'speak up installed' as ok;
