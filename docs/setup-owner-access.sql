-- SchoolSuggestions -- permanent access for the project owner
-- Run AFTER docs/setup-my-suggestions.sql.
--
-- The owner (ojasbhatnagar13@gmail.com) builds, tests and fixes the site, so
-- that account must always be able to use everything, whatever the school
-- domain rule says. Everyone else outside @dpsiedge.edu.in stays blocked.
--
-- Accounts are listed by user id, not by email pattern, so a look-alike
-- address gets nothing. The account must still be email-verified (Google
-- always is).

create table if not exists public.access_exceptions (
    user_id  uuid primary key references auth.users(id) on delete cascade,
    note     text,
    added_at timestamptz not null default now()
);
alter table public.access_exceptions enable row level security;
revoke all on public.access_exceptions from anon, authenticated;

insert into public.access_exceptions (user_id, note)
select id, 'project owner: testing and fixes'
  from auth.users where lower(email) = 'ojasbhatnagar13@gmail.com'
on conflict (user_id) do nothing;

-- Make sure the owner is also staff, for the staff page.
insert into public.staff (user_id, note)
select id, 'project owner' from auth.users where lower(email) = 'ojasbhatnagar13@gmail.com'
on conflict (user_id) do nothing;

-- Same function as setup-signin-submit.sql, plus the exception check. The
-- board, voting and submitting all use it, so all three are covered.
create or replace function public.board_access_error()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_email     text;
    v_confirmed timestamptz;
    v_domain    text;
begin
    if auth.uid() is null then
        return 'Please sign in first.';
    end if;

    select email, email_confirmed_at
      into v_email, v_confirmed
      from auth.users
     where id = auth.uid();

    if v_confirmed is null then
        return 'Your email address has not been verified yet.';
    end if;

    -- Listed accounts (the project owner) are never blocked by the domain.
    if exists (select 1 from public.access_exceptions where user_id = auth.uid()) then
        return null;
    end if;

    select vote_email_domain into v_domain from public.app_config where id;

    if v_domain is not null
       and lower(coalesce(v_email, '')) not like '%@' || lower(v_domain) then
        return format('Only @%s accounts can use this. Sign out and sign in with your school account.', v_domain);
    end if;

    return null;
end;
$$;

notify pgrst, 'reload schema';

-- Expected: one exception, the owner is staff, and the domain rule is still on.
select u.email,
       exists (select 1 from public.access_exceptions e where e.user_id = u.id) as always_allowed,
       exists (select 1 from public.staff s where s.user_id = u.id) as is_staff,
       (select vote_email_domain from public.app_config) as domain_rule_for_everyone_else
  from auth.users u
 where lower(u.email) = 'ojasbhatnagar13@gmail.com';
