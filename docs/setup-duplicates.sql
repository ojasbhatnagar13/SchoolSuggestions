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

        -- similarity() alone is not enough: it divides shared trigrams by the
        -- union, so a short topic scores badly against a longer one even when
        -- the short one appears inside it verbatim. "bike racks" vs
        -- "facilities we need more bike racks near" scores only 0.25.
        --
        -- word_similarity() measures how well one string matches some run of
        -- words within the other, which is exactly the containment case. It is
        -- asymmetric, so both directions are tested.
        select s.id, s.suggestion
          into dup_id, dup_text
          from public.suggestions s
         where s.status in ('approved', 'pending')
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
-- Existing rows have no topic, so they cannot be matched against.
--
-- An earlier version of this seeded them from category + the first six words.
-- That produced topics like "facilities we need more bike racks near", which
-- scored only 0.25 against a real AI topic of "bike racks" -- long enough to
-- never match anything. Do not do that.
--
-- Set them by hand instead. There are only a handful, and a topic is meant to
-- be 2-4 words. Anything already rejected can be skipped: rejected rows are
-- excluded from duplicate checks anyway.

update public.suggestions set topic = 'bike racks'         where id = 14;
update public.suggestions set topic = 'school food quality' where id = 13;

-- Anything still without a topic: give it one, keeping it short.
select id, status, category, topic, left(suggestion, 45) as suggestion
from public.suggestions
where status in ('approved', 'pending')
order by id;

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
