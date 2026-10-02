# SchoolSuggestions

Students submit suggestions; an AI moderator reviews each one against the
school's rules; the suggestion plus its analysis is stored in Supabase. Later,
students browse and vote, and staff review and action.

AI moderation is **advisory**. The `spam` and `feasibility` fields help staff
prioritise; they are not automatic rejections.

## Pipeline

```
Student submits suggestion
    -> Gemini judges it against the staff-edited guidelines in the
       database (public.moderation_rules), plus school background
       taken from dpsiedge.edu.in (structured JSON out)
    -> spam / feasibility / category / reason / summary
    -> stored in Supabase via submit_suggestion() RPC
    -> students browse + vote     staff review + action
```

## Stack

| Layer | Choice |
|---|---|
| Language | Python 3.14.6 |
| AI | Google Gemini via `google-genai` |
| Database | Supabase (Postgres + PostgREST) |
| DB client | `supabase-py` (sync) |
| Frontend | vanilla HTML/CSS/JS on Cloudflare Workers (frontend/) |

Supabase project ref: `ywyjhgpcokrtzibcrqes`

## Layout

```
backend/
  .env              secrets, not in version control
  main.py           the pipeline: prompt -> Gemini -> Supabase
  verify_setup.py   checks the DB matches docs/setup.sql
  requirements.txt
  venv/
docs/
  rls-fix-options.md   the 42501 RLS blocker: cause and all 8 fixes
  setup.sql            DB setup + hardening, run in the SQL editor
frontend/            the site: Suggest, Ideas, How it works, Staff review
```

## Running

PowerShell blocks venv activation by default, and activation is unnecessary —
call the venv's Python directly:

```powershell
cd "C:\Users\Ojas Bhatnagar\Desktop\SchoolSuggestions\backend"
.\venv\Scripts\python.exe main.py
```

Check the database is set up correctly:

```powershell
.\venv\Scripts\python.exe verify_setup.py
```

## Security model

`SUPABASE_KEY` is a legacy JWT **anon** key. It is public-safe by design — RLS
is what protects the data, not key secrecy. Never put a `service_role` key in
this project while the frontend is a browser.

`anon` reaches the database through exactly three doors:

| Action | Route | Why |
|---|---|---|
| write | `submit_suggestion()` | `security definer`, so no INSERT policy needed |
| vote | `vote_for_suggestion()` | `security definer`, avoids a blanket UPDATE policy |
| read | `public_suggestions` view | hides `spam`, `feasibility`, `reason` |

Direct table access is revoked. See `docs/setup.sql` section 5.

**`GEMINI_API_KEY` must never reach the browser.** The moderation call has to
stay server-side — that constraint drives the frontend architecture.

## Known gaps

- Voting has **no duplicate-vote prevention**. Do not launch to students until
  it does; that needs a per-student identity decision.
- Staff review view needs Supabase Auth — not yet built.
- Suggestions are anonymous at the schema level; there is no student identity
  column.
- Free Supabase projects pause after 7 days of inactivity.
