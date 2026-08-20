-- SchoolSuggestions -- staff review
-- Run AFTER docs/setup.sql and docs/setup-auth.sql.
--
-- Adds a staff registry, a status workflow, and the two functions the staff
-- page uses. Staff see everything students cannot: the spam verdict, the
-- feasibility call, and the AI's reasoning.
--
-- Run one section at a time and check the expected result before moving on.


-- =====================================================================
-- SECTION 1 -- Who counts as staff
-- =====================================================================
-- Staff and students share the same email domain, so there is nothing in the
-- address to tell them apart. Membership is therefore explicit: a row here or
-- you are not staff. Section 5 shows how to add yourself.

create table if not exists public.staff (
    user_id  uuid primary key references auth.users(id) on delete cascade,
    added_at timestamptz not null default now(),
    note     text
);

alter table public.staff enable row level security;

-- No policies and no grants. Nothing reads this table except the security
-- definer functions below, so students cannot enumerate who the staff are.

-- Expected: CREATE TABLE, ALTER TABLE


-- =====================================================================
-- SECTION 2 -- Status workflow
-- =====================================================================
-- The check constraint is the guard: an invalid status cannot be written even
-- by a bug in the function below.

alter table public.suggestions
    add column if not exists status text not null default 'pending';

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'suggestions_status_check'
    ) then
        alter table public.suggestions
            add constraint suggestions_status_check
            check (status in ('pending', 'approved', 'rejected', 'actioned'));
    end if;
end;
$$;

-- Expected: ALTER TABLE, DO
select id, suggestion, status from public.suggestions order by id;


-- =====================================================================
-- SECTION 3 -- Show students what happened to their suggestion
-- =====================================================================
-- Adds status to the student-facing view so the UI can show a badge. It is
-- deliberately NOT filtered: a suggestion marked rejected stays visible with
-- its label, so the process is transparent rather than things silently
-- disappearing. If you would rather hide rejected ones, add
--   and status <> 'rejected'
-- to the where clause.
--
-- spam, feasibility and reason remain excluded -- those stay staff-only.

create or replace view public.public_suggestions as
select
    id,
    suggestion,
    category,
    summary,
    votes,
    status,
    created_at
from public.suggestions
where spam = 'No';

grant select on public.public_suggestions to anon, authenticated;

-- Expected: CREATE VIEW, GRANT
select * from public.public_suggestions order by created_at desc;


-- =====================================================================
-- SECTION 4 -- The staff functions
-- =====================================================================

create or replace function public.is_staff()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select exists (select 1 from public.staff where user_id = auth.uid());
$$;

-- Everything staff see, including the moderation columns hidden from the
-- student view. Flagged suggestions are included -- reviewing them is the
-- point, since the AI is advisory and can be wrong.
create or replace function public.staff_suggestions()
returns table (
    id          bigint,
    suggestion  text,
    spam        text,
    feasibility text,
    category    text,
    reason      text,
    summary     text,
    votes       bigint,
    status      text,
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

    return query
        select s.id, s.suggestion, s.spam, s.feasibility, s.category,
               s.reason, s.summary, s.votes, s.status, s.created_at
        from public.suggestions s
        order by s.created_at desc;
end;
$$;

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

    if p_status not in ('pending', 'approved', 'rejected', 'actioned') then
        raise exception 'Invalid status: %', p_status;
    end if;

    update public.suggestions
       set status = p_status
     where id = p_id
    returning status into new_status;

    if new_status is null then
        raise exception 'Suggestion % not found', p_id
            using errcode = 'no_data_found';
    end if;

    return new_status;
end;
$$;

revoke all on function public.is_staff() from public, anon;
revoke all on function public.staff_suggestions() from public, anon;
revoke all on function public.staff_set_status(bigint, text) from public, anon;

grant execute on function public.is_staff() to authenticated;
grant execute on function public.staff_suggestions() to authenticated;
grant execute on function public.staff_set_status(bigint, text) to authenticated;

-- Expected: CREATE FUNCTION x3, REVOKE x3, GRANT x3


-- =====================================================================
-- SECTION 5 -- Make yourself staff
-- =====================================================================
-- You must sign in through the website at least once first: this looks you up
-- in auth.users, and that row only exists after a successful Google sign-in.

insert into public.staff (user_id, note)
select id, 'project owner'
from auth.users
where email = 'REPLACE-WITH-YOUR-SCHOOL-EMAIL@dpsiedge.edu.in'
on conflict (user_id) do nothing;

-- Expected: INSERT 0 1
-- If it says INSERT 0 0, the email did not match any signed-in user. Check:
--   select id, email from auth.users order by created_at desc;

select s.user_id, u.email, s.note
from public.staff s join auth.users u on u.id = s.user_id;


-- =====================================================================
-- SECTION 6 -- Refresh PostgREST
-- =====================================================================
notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY
-- =====================================================================
-- In the SQL editor (which is not a signed-in user) this should raise
-- 'Staff access required':
--   select * from public.staff_suggestions();
--
-- From the browser on staff.html, signed in as a staff member, you should see
-- every suggestion including flagged ones. Signed in as a non-staff student,
-- you should see the access-denied message instead.
