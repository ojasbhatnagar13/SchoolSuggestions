-- SchoolSuggestions -- remove the "your idea was approved" receipts
-- Run AFTER docs/setup-receipts.sql.
--
-- Decided 2026-10-02: telling students their idea was approved, even
-- anonymously, made them suspect the site knew who they were, and explaining
-- the receipt mechanism to each one was not worth it. The site no longer
-- sends receipt codes; this removes the lookup and the stored hashes.
--
-- Kept: the receipt_hash column and submit_suggestion's p_receipt argument
-- (now always null), so the function signature does not have to change again.
-- Kept: send times rounded to the hour -- that part stays.

drop function if exists public.receipt_statuses(text[]);
update public.suggestions set receipt_hash = null where receipt_hash is not null;

notify pgrst, 'reload schema';

select count(*) filter (where receipt_hash is not null) as hashes_left,
       exists (select 1 from pg_proc where proname = 'receipt_statuses') as lookup_exists
  from public.suggestions;
