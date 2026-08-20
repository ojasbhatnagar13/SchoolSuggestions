-- SchoolSuggestions -- submission rate limiting
-- Run AFTER docs/setup.sql. Independent of setup-auth.sql and setup-staff.sql.
--
-- Submissions stay anonymous and unauthenticated, per the original scope
-- decision, which means anyone with the site URL can post. This limits how
-- fast they can do it without introducing accounts.
--
-- WHY TWO TIERS
--
-- A school sits behind NAT: hundreds of students share one or two public IPs.
-- A per-IP limit tight enough to stop a spammer would lock out the whole
-- school after a handful of legitimate submissions. So:
--
--   device   a random token the browser keeps in localStorage. Tight limit.
--            Trivially bypassed by clearing storage -- that is accepted; it
--            stops casual repeat-spam, not a determined attacker.
--   network  the client IP. Very generous, purely a backstop against a
--            script hammering the endpoint.
--
-- PRIVACY
--
-- Neither the IP nor the device token is stored. The Edge Function sends only
-- salted SHA-256 hashes, so these rows cannot be linked back to a person or
-- to the suggestions themselves.


-- =====================================================================
-- SECTION 1 -- The throttle log
-- =====================================================================

create table if not exists public.submission_throttle (
    id          bigserial primary key,
    bucket      text not null check (bucket in ('device', 'network')),
    client_hash text not null,
    created_at  timestamptz not null default now()
);

create index if not exists submission_throttle_lookup
    on public.submission_throttle (bucket, client_hash, created_at desc);

alter table public.submission_throttle enable row level security;

-- No policies, no grants. Only the security definer function below touches it.

-- Expected: CREATE TABLE, CREATE INDEX, ALTER TABLE


-- =====================================================================
-- SECTION 2 -- Claim a submission slot
-- =====================================================================
-- Called by the Edge Function BEFORE it calls Gemini. Doing it in that order
-- means a flood costs no Gemini quota -- rejected requests never reach the
-- model.
--
-- Returns how many submissions remain in the device's daily allowance.

create or replace function public.claim_submission_slot(
    p_device_hash  text,
    p_network_hash text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    device_per_hour  constant int := 5;
    device_per_day   constant int := 20;
    network_per_hour constant int := 300;   -- NAT backstop, not a per-student cap

    used_hour int;
    used_day  int;
    used_net  int;
begin
    if p_device_hash is null or length(p_device_hash) < 32
       or p_network_hash is null or length(p_network_hash) < 32 then
        raise exception 'Invalid throttle token'
            using errcode = 'invalid_parameter_value';
    end if;

    -- Opportunistic cleanup, so the table cannot grow without bound. Cheap
    -- because it runs on the same rows the index already covers.
    delete from public.submission_throttle
    where created_at < now() - interval '2 days';

    select count(*) into used_hour
    from public.submission_throttle
    where bucket = 'device' and client_hash = p_device_hash
      and created_at > now() - interval '1 hour';

    if used_hour >= device_per_hour then
        raise exception 'You have sent several suggestions already. Please try again in an hour.';
    end if;

    select count(*) into used_day
    from public.submission_throttle
    where bucket = 'device' and client_hash = p_device_hash
      and created_at > now() - interval '1 day';

    if used_day >= device_per_day then
        raise exception 'Daily suggestion limit reached. Please try again tomorrow.';
    end if;

    select count(*) into used_net
    from public.submission_throttle
    where bucket = 'network' and client_hash = p_network_hash
      and created_at > now() - interval '1 hour';

    if used_net >= network_per_hour then
        raise exception 'The suggestion box is busy right now. Please try again shortly.';
    end if;

    insert into public.submission_throttle (bucket, client_hash)
    values ('device', p_device_hash), ('network', p_network_hash);

    return device_per_day - used_day - 1;
end;
$$;

revoke all on function public.claim_submission_slot(text, text) from public;
grant execute on function public.claim_submission_slot(text, text) to anon, authenticated;

-- Expected: CREATE FUNCTION, REVOKE, GRANT


-- =====================================================================
-- SECTION 3 -- Refresh PostgREST
-- =====================================================================
notify pgrst, 'reload schema';


-- =====================================================================
-- AFTER RUNNING
-- =====================================================================
-- Redeploy the Edge Function so it starts calling this:
--   npx supabase functions deploy moderate-suggestion
--
-- Optionally set a private salt first (otherwise a documented default is
-- used, which is fine but means the hashes are reproducible by anyone who
-- reads this repo):
--   npx supabase secrets set THROTTLE_SALT=some-long-random-string
--
-- To watch it working:
--   select bucket, count(*), max(created_at)
--   from public.submission_throttle group by bucket;
--
-- To tune the limits, edit the three constants at the top of the function and
-- re-run section 2. To lift a block during testing:
--   delete from public.submission_throttle;
