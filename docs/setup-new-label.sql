-- SchoolSuggestions -- "New since your last visit" on the Ideas page
-- Run AFTER docs/setup-remove-receipts.sql.
--
-- The Ideas page (now the home page) labels ideas approved since the
-- student's last visit. That needs the approval time, so the student view
-- gains decided_at -- when staff last set the status. It says nothing about
-- who sent the idea. The "last visit" time lives only in the student's
-- browser; nothing about visits is stored here.
--
-- Appended LAST (create or replace view can only add columns at the end);
-- options, check and filters are unchanged from setup-concerns.sql.

create or replace view public.public_suggestions
with (security_barrier = true) as
select id, suggestion, category, summary, created_at, status, benefit, decided_at
  from public.suggestions
 where status in ('approved', 'actioned')
   and not concern
   and public.board_access_error() is null
with cascaded check option;

notify pgrst, 'reload schema';

select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'public_suggestions'
 order by ordinal_position;
