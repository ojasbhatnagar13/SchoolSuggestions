-- SchoolSuggestions -- guidelines live in the database, editable by staff
-- Run AFTER docs/setup-done-ideas.sql.
--
-- WHY
--
-- The rules the AI judges against were written into the code twice (the Edge
-- Function and backend/rules.txt), so changing one meant a developer and a
-- redeploy, and the copies could drift. Now there is one copy, here, and
-- staff edit it from the staff page.
--
-- Two fields:
--
--   rules           The guidelines themselves. Students see these on the How
--                   it works page, so write them for students. Format:
--                   a heading line ending in ":" then "- " bullet lines.
--                   Headings containing "not" show red, "review" amber,
--                   anything else green.
--
--   school_context  Background facts the AI uses to judge whether an idea is
--                   realistic, already exists, or clashes with how the school
--                   works. Taken from dpsiedge.edu.in (October 2026) plus
--                   things staff have said. Not shown to students. Not rules:
--                   the AI is told not to reject anything on the strength of
--                   this alone.


-- =====================================================================
-- SECTION 1 -- Table
-- =====================================================================

create table if not exists public.moderation_rules (
    id             boolean primary key default true check (id),  -- one row only
    rules          text not null check (length(rules) between 20 and 8000),
    school_context text not null default '' check (length(school_context) <= 12000),
    updated_at     timestamptz not null default now(),
    updated_by     uuid references auth.users(id) on delete set null
);

alter table public.moderation_rules enable row level security;
revoke all on public.moderation_rules from anon, authenticated;


-- =====================================================================
-- SECTION 2 -- Starting content (only if the table is empty)
-- =====================================================================

insert into public.moderation_rules (id, rules, school_context)
values (true,
$rules$Usually acceptable:
- New clubs and societies
- Events and activities
- Improvements to school facilities
- Student activities and anything that gets students involved

Needs special review:
- Projects with a large budget
- Changes to school policy
- Changes to the timetable

Not allowed:
- Changing the curriculum
- Removing mandatory classes
- Changing exam requirements
- Anything against safety rules
- Sporting equipment at recess$rules$,
$ctx$ABOUT THE SCHOOL
- DPS International Edge (DPSI), Gurgaon: a co-educational IB World School in the Delhi Public School Society network (first DPS school 1949). Motto: "Service Before Self".
- Programmes: IB Primary Years Programme (Pre-Nursery to Grade 5, ages 3-11), Middle Years Programme (Grades 6-10), Diploma Programme and Career-related Programme (Grades 11-12).
- Vision: a compassionate, future-focused community nurturing critical thinkers who are ethical and responsible global citizens. The mission includes wellbeing and belonging in a safe, inclusive community, and sustainability through local and global action.
- There is an elected Student Senate.

CAMPUS AND FACILITIES
- 5-acre campus with separate Primary and Secondary wings and natural-grass outdoor play areas.
- Indoor courts for basketball, badminton and squash, and a swimming pool.
- Buildings are centrally air-conditioned; classrooms have air purifiers; lifts and ramps throughout.
- Primary and Secondary libraries (10,000+ books) plus a Virtual Library; computer labs; science and technology labs; a yoga and meditation room; music, dance, drama and visual art studios; a large auditorium.
- Campus-wide Wi-Fi, smart boards and interactive panels, tablets for learning.
- Corridors have student artwork, game stations, friendship benches and peace corners.
- CCTV on the perimeter, in corridors and on school buses.
- The school runs a sewage treatment plant; sustainability is part of the curriculum.
- The canteen is indoors.

SPORT
- Indoor: table tennis, carrom, chess, billiards, squash, swimming, badminton, skating.
- Outdoor: athletics, football, cricket, basketball, lawn tennis.
- Also martial arts, gymnastics, aerobics, gym fitness and yoga.

FOOD
- The school provides breakfast, lunch and an evening snack. There are no tiffin boxes: students eat school meals, on purpose, to build community and healthy habits.
- The menu is entirely vegetarian: North Indian, South Indian and Continental dishes, prepared in-house, planned by chefs with a nutritionist, no artificial flavours or enhancers. Allergens are marked.
- Lunch is usually dal, sabzi, rice, rotis, salad, curd and a small dessert. Fridays have treats, with salads still available.
- Special diets (lactose intolerance, diabetes, other medical needs, no onion no garlic) are catered for with prior notice.
- The weekly menu is published on the school website.

LIBRARY
- Open 8:00-3:30 Monday to Thursday, 8:00-2:30 Friday.
- Borrowing: Nursery to Grade 2 one book a week, Grades 3-5 two, MYP three; loans last one week.

TRANSPORT
- Air-conditioned buses on fixed routes across Gurgaon and parts of New Delhi.
- The bus service is optional and seats are not guaranteed. Routes and stops are not changed for individual requests.

WELLBEING AND SAFEGUARDING
- Child Protection and Safeguarding Policy and an Anti-Bullying Policy; staff trained in POCSO awareness.
- Counsellors in both Primary and Secondary, a Head of Pastoral Care, a social-emotional learning programme, learning support for neurodiverse students, and a student Wellbeing Club.
- Personal concerns such as bullying, safety or wellbeing belong with a counsellor or the pastoral care team, not the suggestion box.

BEYOND ACADEMICS
- Camps from Grade 3, international visits, Model UN, the International Award for Young People (IAYP), community service and MYP Service as Action, CAS in the Diploma Programme, career counselling, art, music, dance and theatre.$ctx$)
on conflict (id) do nothing;


-- =====================================================================
-- SECTION 3 -- Reading the rules
-- =====================================================================

-- Students (signed in or not) see the guidelines on How it works. Only the
-- rules, not the background notes.
create or replace function public.public_rules()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object('rules', rules, 'updated_at', updated_at)
      from public.moderation_rules where id;
$$;

revoke all on function public.public_rules() from public;
grant execute on function public.public_rules() to anon, authenticated;

-- The Edge Function and main.py: rules and background, behind the same
-- secret as submitting.
create or replace function public.moderation_config(p_secret text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.submit_secret_ok(p_secret) then
        raise exception 'Not allowed' using errcode = 'insufficient_privilege';
    end if;
    return (select jsonb_build_object('rules', rules, 'school_context', school_context)
              from public.moderation_rules where id);
end;
$$;

revoke all on function public.moderation_config(text) from public;
grant execute on function public.moderation_config(text) to anon, authenticated;


-- =====================================================================
-- SECTION 4 -- Staff editing
-- =====================================================================

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
    return (select jsonb_build_object(
                'rules', r.rules,
                'school_context', r.school_context,
                'updated_at', r.updated_at,
                'updated_by', u.email)
              from public.moderation_rules r
              left join auth.users u on u.id = r.updated_by
             where r.id);
end;
$$;

create or replace function public.staff_set_rules(p_rules text, p_school_context text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rules text := trim(coalesce(p_rules, ''));
    v_ctx   text := trim(coalesce(p_school_context, ''));
begin
    if not public.is_staff() then
        raise exception 'Staff access required' using errcode = 'insufficient_privilege';
    end if;
    if length(v_rules) < 20 then
        raise exception 'The guidelines are too short. Write at least one heading and one rule.';
    end if;
    if length(v_rules) > 8000 then
        raise exception 'The guidelines are limited to 8000 characters.';
    end if;
    if length(v_ctx) > 12000 then
        raise exception 'The background notes are limited to 12000 characters.';
    end if;

    update public.moderation_rules
       set rules = v_rules, school_context = v_ctx,
           updated_at = now(), updated_by = auth.uid()
     where id;

    return public.staff_get_rules();
end;
$$;

revoke all on function public.staff_get_rules() from public, anon;
revoke all on function public.staff_set_rules(text, text) from public, anon;
grant execute on function public.staff_get_rules() to authenticated;
grant execute on function public.staff_set_rules(text, text) to authenticated;

notify pgrst, 'reload schema';

-- Expected: one row, with both fields filled.
select length(rules) as rules_chars, length(school_context) as context_chars, updated_at
  from public.moderation_rules;
