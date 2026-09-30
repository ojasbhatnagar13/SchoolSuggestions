-- SchoolSuggestions -- sign in to submit, limits per account, no back door
-- Run AFTER docs/setup-review-v2.sql.
--
-- WHY
--
-- The old limits were per browser (a random id in localStorage) and per
-- network address. Incognito reset the first, a VPN reset the second, and on
-- school Wi-Fi the whole school shared one network address -- so one person
-- scripting submissions could lock everyone else out. And submit_suggestion
-- was callable directly with the public key, skipping the AI and the limit.
--
-- NOW
--
-- 1. Submitting needs a signed-in, verified account (checked by the Edge
--    Function with board_access_error(), the same rule as the board). The
--    limit is counted per account, so incognito, VPNs and shared Wi-Fi no
--    longer matter.
--
-- 2. Suggestions stay anonymous. The suggestion row still has no author
--    column. The quota table stores only a salted hash of the account id
--    (the salt lives in the Edge Function, not the database) and the HOUR,
--    never the exact time, and rows are deleted after two days.
--
-- 3. The database only accepts submissions carrying a secret that the Edge
--    Function holds and the browser never sees. Calling submit_suggestion
--    directly with the public key now fails.
--
-- AFTER RUNNING: the Edge Function needs the secret and a redeploy, or
-- submissions fail. See the bottom of this file.


-- =====================================================================
-- SECTION 1 -- Config: limits and the shared secret
-- =====================================================================

alter table public.app_config
    add column if not exists account_per_hour int not null default 5,
    add column if not exists account_per_day  int not null default 20,
    add column if not exists submit_secret    text;

-- Generated here, once. Re-running keeps the existing value.
update public.app_config
   set submit_secret = replace(gen_random_uuid()::text, '-', '')
                    || replace(gen_random_uuid()::text, '-', '')
 where submit_secret is null;

-- Only ever called from inside the security definer functions below.
create or replace function public.submit_secret_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.app_config
         where id and submit_secret is not null and submit_secret = p_secret
    );
$$;

revoke all on function public.submit_secret_ok(text) from public, anon, authenticated;


-- =====================================================================
-- SECTION 2 -- Per-account quota
-- =====================================================================

create table if not exists public.submission_quota (
    account_hash text        not null,
    hour         timestamptz not null,
    used         int         not null default 0,
    primary key (account_hash, hour)
);

alter table public.submission_quota enable row level security;
revoke all on public.submission_quota from anon, authenticated;

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
        raise exception 'You have sent % ideas this hour. You can send more after the hour is up.', lim_hour;
    end if;
    if used_day >= lim_day then
        raise exception 'You have sent % ideas today. Please try again tomorrow.', lim_day;
    end if;

    insert into public.submission_quota (account_hash, hour, used)
    values (p_account_hash, this_hour, 1)
    on conflict (account_hash, hour) do update set used = submission_quota.used + 1;

    return lim_day - used_day - 1;
end;
$$;

revoke all on function public.claim_account_slot(text, text) from public;
grant execute on function public.claim_account_slot(text, text) to anon, authenticated;


-- =====================================================================
-- SECTION 3 -- submit_suggestion requires the secret
-- =====================================================================
-- Granted to anon still, because the Edge Function calls it with the anon
-- key -- but without the secret every call is refused. Same body as in
-- setup-review-v2.sql apart from the check.

drop function if exists public.submit_suggestion(text, text, text, text, text, text, text, text);

create or replace function public.submit_suggestion(
    p_suggestion   text,
    p_spam         text,
    p_feasibility  text,
    p_category     text,
    p_reason       text,
    p_summary      text,
    p_secret       text,
    p_topic        text default null,
    p_benefit      text default null
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

    if new_status = 'pending' and p_topic is not null and length(trim(p_topic)) > 0 then
        select duplicate_threshold into threshold from public.app_config where id;

        select s.id, s.suggestion
          into dup_id, dup_text
          from public.suggestions s
         where s.status in ('approved', 'pending', 'actioned')
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
         votes, status, topic, decided_by, decided_at)
    values
        (p_suggestion, v_benefit, p_spam, p_feasibility, p_category, p_reason, p_summary,
         0, new_status, p_topic,
         case when new_status = 'pending' then null else 'ai'  end,
         case when new_status = 'pending' then null else now() end)
    returning id into new_id;

    return jsonb_build_object('id', new_id, 'status', new_status);
end;
$$;

revoke all on function public.submit_suggestion(text,text,text,text,text,text,text,text,text) from public;
grant execute on function public.submit_suggestion(text,text,text,text,text,text,text,text,text)
    to anon, authenticated;


-- =====================================================================
-- SECTION 4 -- Retire the old device/network limit
-- =====================================================================
-- Nothing calls it any more. Revoking closes it; clearing the log removes
-- the network fingerprints it was holding.

revoke all on function public.claim_submission_slot(text, text) from public, anon, authenticated;
delete from public.submission_throttle;


-- =====================================================================
-- SECTION 5 -- One wording for the board, voting and submitting
-- =====================================================================
-- Same function as setup-review-v2.sql; only the messages change, since it
-- now also guards submitting.

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

    select vote_email_domain into v_domain from public.app_config where id;

    if v_domain is not null
       and lower(coalesce(v_email, '')) not like '%@' || lower(v_domain) then
        return format('Only @%s accounts can use this. Sign out and sign in with your school account.', v_domain);
    end if;

    return null;
end;
$$;

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY
-- =====================================================================
-- Calling the write function without the secret must be refused. Expect an
-- error mentioning "Not allowed" if you run this line on its own:
--   select public.submit_suggestion('x','No','Feasible','Test','x','x','wrong');

select account_per_hour, account_per_day,
       submit_secret is not null as secret_set
  from public.app_config;


-- =====================================================================
-- THEN (PowerShell, project folder)
-- =====================================================================
-- Copy the secret into the Edge Function WITHOUT printing it, then redeploy:
--
--   $s = (npx.cmd supabase db query --linked "select submit_secret from public.app_config" | ConvertFrom-Json).rows[0].submit_secret
--   npx.cmd supabase secrets set "SUBMIT_SECRET=$s"
--   npx.cmd supabase functions deploy moderate-suggestion --use-api
--
-- Also add SUBMIT_SECRET to backend/.env if you use backend/main.py.
--
-- Classroom tip: limits are per student now, so a shared laptop is no longer
-- a problem as long as each student signs in. To change them:
--   update public.app_config set account_per_hour = 10, account_per_day = 30;
