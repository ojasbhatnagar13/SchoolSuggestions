-- SchoolSuggestions -- configurable submission limits
-- Run AFTER docs/setup-throttle.sql and docs/demo-mode.sql.
--
-- WHY
--
-- The per-device limit (5 an hour) exists to stop one person spamming. But a
-- classroom demo often passes ONE laptop around, and every student on it shares
-- that device's limit -- the sixth student would be blocked. The limits were
-- hard-coded inside claim_submission_slot(), so changing them meant re-pasting
-- the whole function. They now live in app_config, like the other tunables,
-- and changing them is one UPDATE.
--
-- Same function signature and return type as before, so this is a plain
-- `create or replace` -- the Edge Function does not need redeploying.


-- =====================================================================
-- SECTION 1 -- Limits become config
-- =====================================================================

alter table public.app_config
    add column if not exists device_per_hour  int not null default 5,
    add column if not exists device_per_day   int not null default 20,
    add column if not exists network_per_hour int not null default 300;

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
    lim_hour int;
    lim_day  int;
    lim_net  int;
    used_hour int;
    used_day  int;
    used_net  int;
begin
    if p_device_hash is null or length(p_device_hash) < 32
       or p_network_hash is null or length(p_network_hash) < 32 then
        raise exception 'Invalid throttle token'
            using errcode = 'invalid_parameter_value';
    end if;

    -- Falls back to the original defaults if the config row is ever missing,
    -- rather than failing open with no limit at all.
    select coalesce(device_per_hour, 5),
           coalesce(device_per_day, 20),
           coalesce(network_per_hour, 300)
      into lim_hour, lim_day, lim_net
      from public.app_config where id;
    lim_hour := coalesce(lim_hour, 5);
    lim_day  := coalesce(lim_day, 20);
    lim_net  := coalesce(lim_net, 300);

    delete from public.submission_throttle
    where created_at < now() - interval '2 days';

    select count(*) into used_hour
    from public.submission_throttle
    where bucket = 'device' and client_hash = p_device_hash
      and created_at > now() - interval '1 hour';

    if used_hour >= lim_hour then
        raise exception 'You have sent several suggestions already. Please try again in an hour.';
    end if;

    select count(*) into used_day
    from public.submission_throttle
    where bucket = 'device' and client_hash = p_device_hash
      and created_at > now() - interval '1 day';

    if used_day >= lim_day then
        raise exception 'Daily suggestion limit reached. Please try again tomorrow.';
    end if;

    select count(*) into used_net
    from public.submission_throttle
    where bucket = 'network' and client_hash = p_network_hash
      and created_at > now() - interval '1 hour';

    if used_net >= lim_net then
        raise exception 'The suggestion box is busy right now. Please try again shortly.';
    end if;

    insert into public.submission_throttle (bucket, client_hash)
    values ('device', p_device_hash), ('network', p_network_hash);

    return lim_day - used_day - 1;
end;
$$;

revoke all on function public.claim_submission_slot(text, text) from public;
grant execute on function public.claim_submission_slot(text, text) to anon, authenticated;

notify pgrst, 'reload schema';

-- Expected: ALTER TABLE, CREATE FUNCTION, REVOKE, GRANT
select device_per_hour, device_per_day, network_per_hour from public.app_config;
-- Expected: 5 | 20 | 300 (the original limits, unchanged so far)


-- =====================================================================
-- SECTION 2 -- Classroom mode (one shared device)
-- =====================================================================
--   update public.app_config set device_per_hour = 40, device_per_day = 120;
--   delete from public.submission_throttle;   -- clear anything already counted
--
-- Back to normal afterwards:
--   update public.app_config set device_per_hour = 5, device_per_day = 20;
