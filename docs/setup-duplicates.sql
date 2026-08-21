-- SchoolSuggestions -- duplicate detection
-- Run AFTER docs/demo-mode.sql.
--
-- WHAT THIS DOES
--
-- If a student submits an idea that already exists, no new row is created.
-- They are told it already exists and pointed at the original.
--
-- HOW IT MATCHES
--
-- Not on the raw text: "add bike racks" and "We need more bike racks near the
-- gym" share few words but are the same idea.
--
-- Not on the summary either: every summary begins "The student suggests...",
-- so all summaries look alike and everything would match everything.
--
-- Instead the AI emits a short canonical `topic` for each suggestion -- a few
-- lowercase words naming the core request, e.g. "bike racks". Two students
-- asking for the same thing produce near-identical topics, and trigram
-- similarity on that short string is both accurate and cheap.
--
-- The comparison happens inside the database, so pending suggestions are
-- never sent to the browser to be compared against.


-- =====================================================================
-- SECTION 1 -- Schema
-- =====================================================================

create extension if not exists pg_trgm;

alter table public.suggestions
    add column if not exists topic text;

-- How alike two topics must be to count as the same idea. Tune without
-- touching code: raise it if unrelated ideas get merged, lower it if obvious
-- duplicates slip through.
alter table public.app_config
    add column if not exists duplicate_threshold real not null default 0.55;

create index if not exists suggestions_topic_trgm
    on public.suggestions using gin (topic gin_trgm_ops);

-- Expected: CREATE EXTENSION, ALTER TABLE x2, CREATE INDEX
select vote_email_domain, duplicate_threshold from public.app_config;


-- =====================================================================
-- SECTION 2 -- submit_suggestion rejects duplicates before inserting
-- =====================================================================
-- Signature gains p_topic, so the old version must go first.
-- p_topic defaults to null, which skips the check -- an older caller that
-- does not send a topic still works, it just cannot detect duplicates.

drop function if exists public.submit_suggestion(text, text, text, text, text, text);

create or replace function public.submit_suggestion(
    p_suggestion   text,
    p_spam         text,
    p_feasibility  text,
    p_category     text,
    p_reason       text,
    p_summary      text,
    p_topic        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    new_id       bigint;
    new_status   text := public.auto_status(p_spam, p_feasibility);
    threshold    real;
    dup_id       bigint;
    dup_text     text;
begin
    -- Only look for duplicates among suggestions that are actually alive.
    -- Something the AI is about to bin does not need deduplicating, and a
    -- previously rejected idea should be resubmittable in case it was
    -- rejected wrongly or can be reworded better.
    if new_status = 'pending' and p_topic is not null and length(trim(p_topic)) > 0 then
        select duplicate_threshold into threshold from public.app_config where id;

        select s.id, s.suggestion
          into dup_id, dup_text
          from public.suggestions s
         where s.status in ('approved', 'pending')
           and s.topic is not null
           and similarity(s.topic, p_topic) >= coalesce(threshold, 0.55)
         order by similarity(s.topic, p_topic) desc
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
        (suggestion, spam, feasibility, category, reason, summary, votes, status, topic)
    values
        (p_suggestion, p_spam, p_feasibility, p_category, p_reason, p_summary, 0, new_status, p_topic)
    returning id into new_id;

    return jsonb_build_object('id', new_id, 'status', new_status);
end;
$$;

revoke all on function public.submit_suggestion(text,text,text,text,text,text,text) from public;
grant execute on function public.submit_suggestion(text,text,text,text,text,text,text)
    to anon, authenticated;

notify pgrst, 'reload schema';

-- Expected: DROP FUNCTION, CREATE FUNCTION, REVOKE, GRANT


-- =====================================================================
-- SECTION 3 -- Backfill topics for existing suggestions
-- =====================================================================
-- Existing rows have no topic, so they cannot be matched against. Rather than
-- re-running them through the AI, seed a rough topic from the category and
-- the first few words. Good enough for the ones already in the system; every
-- new submission gets a proper AI topic.

update public.suggestions
   set topic = lower(
           coalesce(category, '') || ' ' ||
           array_to_string((string_to_array(suggestion, ' '))[1:6], ' ')
       )
 where topic is null;

-- Expected: UPDATE <n>
select id, status, category, topic from public.suggestions order by id;


-- =====================================================================
-- TUNING
-- =====================================================================
-- Unrelated ideas being merged? Raise the threshold:
--   update public.app_config set duplicate_threshold = 0.7;
--
-- Obvious duplicates getting through? Lower it:
--   update public.app_config set duplicate_threshold = 0.45;
--
-- See how alike two topics actually are:
--   select similarity('bike racks', 'bike racks near the gym');
--
-- NOT HANDLED: two identical suggestions submitted at the same instant can
-- both pass the check before either is inserted. At school volumes this is
-- vanishingly unlikely, and the cost is one duplicate row a staff member can
-- reject.
