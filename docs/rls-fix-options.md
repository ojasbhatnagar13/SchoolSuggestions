# Fixing the `42501` RLS insert blocker

**Status:** diagnosed and confirmed empirically on 2026-08-19.
**Applies to:** `public.suggestions`, Supabase project `ywyjhgpcokrtzibcrqes`.

---

## 1. The symptom

Every insert through the Supabase REST API failed:

```
postgrest.exceptions.APIError: {'message': 'new row violates row-level security
policy for table "suggestions"', 'code': '42501', 'hint': None, 'details': None}
```

...while the same insert run directly in the SQL editor as `anon` succeeded.

## 2. The cause

**The table had an INSERT policy but no SELECT policy, and every failing request
asked for the inserted row back.**

In PostgreSQL's `rewrite/rowsecurity.c`, when an INSERT requires read access —
which a `RETURNING` clause triggers — the **SELECT** policies are added as
`WCO_RLS_INSERT_CHECK` check-options, the same kind used for the INSERT policy's
own `WITH CHECK`. Two consequences follow:

1. When the permissive SELECT policy list is **empty**, the check folds to a
   constant `false`, so it always fails.
2. It reuses the INSERT error string, so a *SELECT*-policy failure is reported as
   `new row violates row-level security policy`.

That second point is why this looked like an INSERT problem for so long, and why
widening the INSERT policy to `to public with check (true)` changed nothing —
the INSERT policy was never the gate.

The chain was:

```
supabase-py .insert() defaults to returning=representation
  -> sends header  Prefer: return=representation
  -> PostgREST issues  INSERT ... RETURNING *
  -> RETURNING re-checks the new row against SELECT policies
  -> no SELECT policy exists
  -> 42501
```

The one test that passed — `set role anon; insert ...` in the SQL editor — was a
bare INSERT with no RETURNING clause. That was the only structural difference
between the passing case and every failing case.

## 3. Evidence

| Probe | Result | Conclusion |
|---|---|---|
| `select("*")` as `anon` | `0 rows`, **no error** | No SELECT policy. RLS SELECT policies filter silently; they never raise |
| `insert(...).select("id")` | `42501` | Reproduces the blocker |
| `insert(..., returning="minimal")` | **succeeds** | The INSERT policy was always fine. `RETURNING` was the only gate |

## 4. What the client actually sends

Verified against supabase-py **2.31.0** / postgrest **2.31.0**:

| Call | Query params | `Prefer` header |
|---|---|---|
| `insert(data).select('id')` | `{'select': 'id'}` | `return=representation` |
| `insert(data)` | `{}` | `return=representation` |
| `insert(data, returning='minimal')` | `{}` | `return=minimal` |
| `insert(data, returning='minimal').select('id')` | `{'select': 'id'}` | `return=representation` |

Two things to note:

- `.insert(data).select("id")` **does** work as it appears to in this version. It
  adds `?select=id` and returns only that column. (An earlier note in the project
  handoff said otherwise; that was outdated.)
- **Row 4 is a trap.** Chaining `.select()` rewrites `return=minimal` back to
  `representation`, which brings the `42501` straight back. If you use Solution 2,
  do not chain `.select()`.

---

## 5. The options

| # | Solution | DB change | Returns `id` | Flagged content readable | Verdict |
|---|---|---|---|---|---|
| 1 | SELECT policy `using (true)` | yes | yes | **yes** | Fastest unblock |
| 2 | `returning="minimal"` | none | no | no | Zero-DB-change escape hatch |
| 3 | `security definer` RPC | yes | yes | no | **Chosen** |
| 4 | Narrow SELECT policy | yes | conditional | no | Has a sharp edge |
| 5 | Filtered view for reads | yes | yes | no | Pairs with 1 or 3 |
| 6 | Supabase Auth | large | yes | no | Correct long-term |
| 7 | `service_role` server-side | none | yes | no | Excluded by project constraint |
| 8 | Disable RLS | yes | yes | **all** | Never |

### Solution 1 — add a SELECT policy

```sql
create policy allow_anonymous_select
on public.suggestions
as permissive
for select
to anon
using (true);
```

Expected result: `supabase.table("suggestions").insert(data).select("id").execute()`
returns `data=[{'id': <n>}] count=None`.

Trade-off: every row becomes world-readable with the public anon key, including
rows the AI flagged `spam = 'Yes'`. Fine while the URL is private; not fine once
students have it.

### Solution 2 — `returning="minimal"`

```python
supabase.table("suggestions").insert(data, returning="minimal").execute()
```

Expected result: `data=[] count=None`.

Needs no database access at all, but returns no `id`, so you cannot link a vote
or a staff action back to the row you just wrote. Do not chain `.select()` (§4).

### Solution 3 — `security definer` RPC  ← implemented

Gives back the `id` without making anything publicly readable.

```sql
create or replace function public.submit_suggestion(
    p_suggestion   text,
    p_spam         text,
    p_feasibility  text,
    p_category     text,
    p_reason       text,
    p_summary      text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    new_id bigint;
begin
    insert into public.suggestions
        (suggestion, spam, feasibility, category, reason, summary, votes)
    values
        (p_suggestion, p_spam, p_feasibility, p_category, p_reason, p_summary, 0)
    returning id into new_id;
    return new_id;
end;
$$;

revoke all on function public.submit_suggestion(text,text,text,text,text,text) from public;
grant execute on function public.submit_suggestion(text,text,text,text,text,text) to anon;
```

This works because the function runs as its owner (`postgres`), and
`relforcerowsecurity = false` on the table, so the owner is exempt from RLS.

`set search_path = public` is not optional. A `security definer` function without
a pinned search_path can be hijacked via a caller-controlled schema.

Expected result: `resp.data` is an integer, e.g. `29`.

It is also the natural home for server-side validation (length limits, rate
limiting) later, and the same pattern you will want for the vote increment.

### Solution 4 — narrow SELECT policy (read the caveat)

```sql
create policy allow_public_read_clean
on public.suggestions
for select
to anon
using (spam = 'No');
```

**This does not work as an insert fix on its own.** Because `RETURNING` re-checks
the new row against SELECT policies, inserting a row with `spam = 'Yes'` fails
with the identical `42501` — the system would crash precisely when the AI catches
spam. `spam` is also nullable, and `NULL = 'No'` is `NULL` rather than true, so a
row with no verdict fails too.

Use this policy for reads only, paired with Solution 2 or 3 for writes.

### Solution 5 — filtered view for reads

Keeps the base table unreadable while exposing only safe columns.

```sql
create view public.public_suggestions as
select id, suggestion, category, summary, votes
from public.suggestions
where spam = 'No';

grant select on public.public_suggestions to anon;
```

Expected result: `supabase.table("public_suggestions").select("*").execute()`
returns only non-spam rows, and `reason` never leaves the server.

Check the view's `security_invoker` setting. With it **off**, the view runs as its
owner and bypasses base-table RLS, which is what makes this work. With it **on**,
base-table RLS still applies and you need Solution 1 underneath.

### Solutions 6-8 — for completeness

**6. Supabase Auth.** Policies keyed on `auth.uid()`. The real answer once staff
review exists, and what unblocks per-student vote limits. Large change.

**7. `service_role` key.** Bypasses RLS entirely and would work instantly. Banned
in this project, correctly, *because the frontend is a browser*. To be precise
about the rule: if the Python backend becomes a real server-side API, holding
`service_role` **on that server only** is standard practice. What matters is that
it never reaches the client. Since the frontend framework is undecided, the ban
stays.

**8. Disable RLS.** Works; makes the table world-writable to anyone holding the
public key. Never do this.

---

## 6. Proven pointless — do not retry

- Widening the INSERT policy (no effect — it was never the gate)
- Table grants: `anon` already holds INSERT and SELECT
- Key validity, JWT signing, role resolution: settled by the `get_auth_role()` RPC
- Rebuilding the venv or reinstalling packages
- Network: `nslookup ywyjhgpcokrtzibcrqes.supabase.co` resolved cleanly

## 7. Verify which policies exist

```sql
select policyname, cmd, roles, permissive, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'suggestions';
```

## 8. Cleanup of diagnostic artefacts

```sql
delete from public.suggestions
where suggestion in (
    'DIAG-2026-08-19-minimal-return',
    'Final RLS diagnostic test',
    'ANON ROLE TEST',
    'Python REST test',
    'test',
    'Install more charging ports in the library.'
);

drop function if exists public.get_auth_role();
drop function if exists public.debug_insert_test();
```

## 9. Follow-ups this leaves open

- `backend/requirements.txt` is empty; populate it with `pip freeze`.
- Rotate `GEMINI_API_KEY` — it was exposed in a chat transcript.
- Tighten the over-broad `UPDATE` / `DELETE` grants held by `anon`.
- Voting still needs its own `security definer` function that only increments
  `votes`, rather than a blanket UPDATE policy.
- `created_at timestamptz default now()` is still missing and will be wanted for
  sorting.
