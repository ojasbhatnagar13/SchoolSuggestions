-- SchoolSuggestions -- staff decisions are not attributed to a person
-- Run AFTER docs/setup-ai-queue.sql.
--
-- Decision 2026-11-19: nobody on the staff page sees which staff member
-- approved, changed the status of, handled, reworded or edited anything.
-- The page still shows THAT staff (not the AI) made a decision, and when.
--
-- reviewed_by, concern_handled_by, reworded_by and moderation_rules.updated_by
-- are still recorded in the database, so an administrator with direct
-- database access could find out in an emergency. They are simply never sent
-- to the staff page. (To stop recording them too, set those columns to null
-- and drop the "= auth.uid()" assignments in the staff functions.)
--
-- Same return types as before, so plain replaces: the name columns stay in
-- the result but are always null.

create or replace function public.staff_suggestions()
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
    ai_status           text
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

    -- reviewer, concern_handled_by and reworder: deliberately null.
    return query
        select s.id, s.suggestion, s.benefit, s.spam, s.feasibility, s.category,
               s.reason, s.summary, s.votes, s.status, s.decided_by, s.decided_at,
               null::text, s.created_at,
               s.concern, s.concern_handled_at, null::text,
               s.flags, s.original_suggestion, s.original_benefit, s.reworded_at, null::text,
               s.ai_status
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

create or replace function public.staff_get_rules()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.is_staff() then
        raise exception 'Staff access required' using errcode = 'insufficient_privilege';
    end if;
    -- updated_by deliberately not returned: when, not who.
    return (select jsonb_build_object(
                'rules', r.rules,
                'school_context', r.school_context,
                'updated_at', r.updated_at)
              from public.moderation_rules r
             where r.id);
end;
$$;

notify pgrst, 'reload schema';

-- Expected: false, false -- neither function reads a staff email any more.
select pg_get_functiondef('public.staff_suggestions'::regproc) like '%auth.users%' as staff_list_reads_emails,
       pg_get_functiondef('public.staff_get_rules'::regproc) like '%auth.users%' as rules_read_emails;
