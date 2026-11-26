-- SchoolSuggestions -- grade and section totals (the class leaderboard)
-- Run AFTER docs/setup-clarify-refund.sql.
--
-- Students can optionally count a suggestion for their grade and section.
-- Agreed design (principal meeting, 2026-11):
--   * Staff never see the class on any single suggestion. It lives in its own
--     table that no API role can read, and staff_suggestions() never joins it.
--   * Only totals are ever shown, and only approved suggestions count
--     (open for votes, going ahead, done), so sending lots doesn't help.
--   * A class only appears once it has 3+ approved suggestions, so a total
--     can't point at one suggestion.
--   * Totals are a snapshot taken weekly (Monday) for the trial, not live, so
--     nobody can match a change in a total to a suggestion that just appeared.
--   * Total votes are shown for the leading class only.

create table if not exists public.suggestion_class (
    suggestion_id bigint primary key references public.suggestions(id) on delete cascade,
    grade   text not null check (grade in
              ('MYP 1','MYP 2','MYP 3','MYP 4','MYP 5','DP 1','DP 2','CP 1','CP 2')),
    section text not null check (section in ('A','B','C','D','E'))
);
alter table public.suggestion_class enable row level security;
revoke all on public.suggestion_class from public, anon, authenticated;
-- No policies on purpose: only the functions below can touch it.

create table if not exists public.class_totals (
    grade    text not null,
    section  text not null,
    approved int  not null,
    done     int  not null,
    votes    int  not null,
    as_of    timestamptz not null,
    primary key (grade, section)
);
alter table public.class_totals enable row level security;
revoke all on public.class_totals from public, anon, authenticated;

-- Called by the Edge Function right after a suggestion is saved. Needs the
-- server secret, like every other write from the function.
create or replace function public.tag_suggestion_class(
    p_secret text, p_id bigint, p_grade text, p_section text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.submit_secret_ok(p_secret) then
        raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;
    insert into public.suggestion_class (suggestion_id, grade, section)
    values (p_id, p_grade, p_section)
    on conflict (suggestion_id) do nothing;
end;
$$;
revoke all on function public.tag_suggestion_class(text, bigint, text, text) from public;
grant execute on function public.tag_suggestion_class(text, bigint, text, text) to anon, authenticated;

-- The monthly snapshot. Run by cron on the 1st; nobody else can call it.
create or replace function public.refresh_class_totals()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    delete from public.class_totals where true;
    insert into public.class_totals (grade, section, approved, done, votes, as_of)
    select c.grade, c.section,
           count(*),
           count(*) filter (where s.status = 'actioned'),
           coalesce(sum(v.n), 0),
           now()
      from public.suggestion_class c
      join public.suggestions s on s.id = c.suggestion_id
      left join (select suggestion_id, count(*) as n
                   from public.suggestion_votes group by suggestion_id) v
             on v.suggestion_id = s.id
     where s.status in ('approved', 'accepted', 'actioned')
     group by c.grade, c.section
    having count(*) >= 3;
end;
$$;
revoke all on function public.refresh_class_totals() from public, anon, authenticated;

-- What the Home page shows: signed-in school accounts only. Votes only for
-- the class in first place.
create or replace function public.class_leaderboard()
returns table (place int, grade text, section text, approved int, done int, votes int, as_of timestamptz)
language sql
stable
security definer
set search_path = public
as $$
    select r.place::int, r.grade, r.section, r.approved, r.done,
           case when r.place = 1 then r.votes end, r.as_of
      from (select t.*, row_number() over (
                     order by t.approved desc, t.done desc, t.votes desc, t.grade, t.section) as place
              from public.class_totals t) r
     where auth.uid() is not null
       and public.board_access_error() is null
     order by r.place;
$$;
revoke all on function public.class_leaderboard() from public, anon;
grant execute on function public.class_leaderboard() to authenticated;

-- Weekly for the trial: 00:05 UTC every Monday (05:35 in India). For monthly,
-- use '5 0 1 * *'.
select cron.unschedule(jobid) from cron.job where jobname = 'class-totals';
select cron.schedule('class-totals', '5 0 * * 1', $$select public.refresh_class_totals()$$);

-- First snapshot now (empty until classes reach 3 approved suggestions).
select public.refresh_class_totals();

notify pgrst, 'reload schema';

select 'class totals installed' as ok;
