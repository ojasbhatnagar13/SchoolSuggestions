# Portable architecture notes

Written 2026-08-22, from building the DPSI school suggestion system.

**Purpose.** This is a handoff for building the same *kind* of system somewhere
else. It records the architecture worth reusing, the reasoning behind the
non-obvious decisions, and — most valuably — the platform traps that cost real
time here so they cost none next time.

**How to use it.** Point a new session at this file before starting. It is a
reference, not a spec: the next build should re-decide anything the new context
changes, but should not re-discover section 8.

---

## 1. What the system does

Anonymous submissions, AI triage, human approval, then a readable list.

```
person submits (no account)
   -> rate limit check          rejected here costs no AI call
   -> AI reads it against rules returns structured verdict + a topic phrase
   -> duplicate check           matched against existing live items
   -> auto-status               obvious rejects binned, rest queued
   -> staff approve             nothing is public until a human says so
   -> readers see it, sign in to vote
```

The order matters. Each stage can stop the item, and the cheap checks run first.

---

## 2. The security model — the most reusable part

The rule that shaped everything: **the browser is not a security boundary.**
Every access decision lives in the database.

Three doors, nothing else:

| Action | Route | Why |
|---|---|---|
| write | `submit_suggestion()` | `security definer` — no INSERT policy needed |
| vote | `vote_for_suggestion()` | avoids a blanket UPDATE grant |
| read | a filtered view | hides moderation columns |

Direct table access is revoked entirely. The pattern:

```sql
create or replace function public.do_thing(...)
returns jsonb
language plpgsql
security definer
set search_path = public          -- NOT optional, see §8
as $$ ... $$;

revoke all on function public.do_thing(...) from public, anon;
grant execute on function public.do_thing(...) to anon;  -- or authenticated
```

`security definer` means the function runs as its owner, bypassing RLS on the
tables it touches. That is what lets you revoke everything from the client role
and still have it work. It also means the function itself must do any checking —
there is no policy behind it as a safety net.

Key points that generalise:

- **The anon/publishable key is public by design.** It ships to the browser. RLS
  and function grants are what protect data, not key secrecy. Never put a
  service-role key anywhere a browser can reach.
- **Secrets that must stay server-side get their own hop.** The AI provider key
  lives in an edge function, never the client. The browser calls the function;
  the function calls the AI.
- **Hiding UI is not access control.** The staff page checks membership inside
  the database, so calling the RPC directly gets refused just the same.
- **Separate identity from content.** Submissions carry no author column at all.
  Votes are attributed, but live in a different table. A vote can never be
  joined back to who wrote something, because the link does not exist.

---

## 3. AI moderation

Use **structured output**, not prose parsing. Constrain the fields that drive
logic to enums so the model cannot return something unhandled:

```
spam         Yes | No
feasibility  Feasible | Not Feasible | Needs Review
category     free text
reason       free text, staff-facing
summary      free text, one neutral sentence
topic        2-4 lowercase words, for duplicate matching
```

Notes worth carrying over:

- Put the rules in the **system instruction**, the user's text as **content**,
  and say explicitly that the content is data rather than instructions. Tested
  with `"Ignore all previous instructions..."` and it was correctly flagged.
- `temperature: 0`. This is classification, not writing.
- **Decide what the AI is allowed to decide.** Here it started advisory, then
  was changed to auto-reject spam and infeasible items. Both are defensible; the
  choice is a policy decision, not a technical one. Whatever you pick, make
  "rejected" recoverable rather than deleted — the model will be wrong sometimes
  and unrecoverable mistakes are the wrong default.
- Keep the rules text in one place. Ours is duplicated between the edge function
  and the CLI tool, which is a known wart — a config table would be better.

---

## 4. Duplicate detection

The problem: "add bike racks" and "we need more bike racks near the gym" are the
same idea with almost no shared words.

What failed:

- **Raw text similarity** — too little overlap between differently-worded
  versions of the same idea.
- **Summary similarity** — worse. Every summary began "The student suggests…",
  so all summaries resembled each other and everything matched everything.

What worked: have the model emit a short canonical **topic** (`bike racks`), and
match on that with `pg_trgm`:

```sql
greatest(
    similarity(existing.topic, new_topic),
    word_similarity(new_topic, existing.topic),
    word_similarity(existing.topic, new_topic)
) >= threshold
```

`similarity()` alone is not enough — it divides shared trigrams by their union,
so a short string scores badly against a longer one even when contained in it
verbatim (`bike racks` vs a longer topic scored 0.25). `word_similarity()`
measures containment, which is the case that matters. Test both directions.

Keep the threshold in a config table so it can be tuned without a deploy.
0.55 worked here.

Run the comparison **inside the database**. The alternative — sending the
existing list to the browser to compare — would leak unapproved content.

---

## 5. Rate limiting

Two tiers, because **an organisation is usually behind one or two public IPs**.
A per-IP limit tight enough to stop one abuser locks out everyone.

| Bucket | Limit | Purpose |
|---|---|---|
| device token | 5/hour, 20/day | the real limit |
| IP | 300/hour | flood backstop only |

- The device token is a random UUID in `localStorage`. It is **not** an identity:
  never tied to content, and defeated by clearing site data. That is accepted —
  it stops casual repeat-spam, and the IP cap catches scripted floods.
- Store **salted SHA-256 hashes**, never raw IPs or tokens. The throttle log
  then cannot be linked back to a person.
- Check the limit **before** the AI call. A flood should cost no API quota.

---

## 6. Approval workflow

- `status` column: `pending | approved | rejected | actioned`, with a check
  constraint so an invalid value cannot be written even by a bug.
- The public view filters on `status = 'approved'` **and** the spam flag. The
  second condition is redundant but cheap insurance against a mis-click.
- Reviewers are an **explicit table of user ids**, not an email pattern — staff
  and students shared a domain, so nothing in the address distinguished them.
- Rejected items stay visible to reviewers and can be restored.

Two behavioural findings from staff feedback, both worth pre-empting next time:

- **Showing vote counts causes bandwagoning.** Popular items attract votes for
  being visibly popular. Fixed by removing the count from the reader-facing view
  entirely (not just hiding it in the UI) and dropping "sort by most voted",
  which is the same mechanism. Reviewers still see counts.
- **A public list of complaints is a reputational surface.** Fixed by requiring
  sign-in to read. You cannot prevent screenshots; you can limit who sees the
  page and show a neutral summary rather than raw wording.

---

## 7. Stack

| Layer | Choice | Note |
|---|---|---|
| DB + auth | Supabase (Postgres) | RLS and `security definer` do the heavy lifting |
| Server logic | Supabase Edge Function (Deno/TS) | keeps the AI key off the client |
| AI | Gemini, structured output | any provider with JSON schema output works |
| Frontend | vanilla HTML/CSS/JS, no build | right call at this scale; revisit if it grows |
| Hosting | Cloudflare Workers static assets | git push deploys; Pages is maintenance-only now |

The no-framework choice held up well for a form, a list, and a review page. It
would not hold up for something with real application state.

---

## 8. Traps — do not rediscover these

Platform behaviours that cost hours here.

**Postgres / Supabase**

- `INSERT ... RETURNING` is checked against **SELECT** policies. With no SELECT
  policy, every insert fails `42501` with a message that says *new row violates
  row-level security policy* — pointing at the INSERT policy, which is fine. This
  cost a full day. If a client requests the row back and there is no read policy,
  this is why.
- `create or replace view` can **append** columns only. Reordering or removing
  one fails `42P16`. Removing requires `drop view` — which discards its grants,
  so reapply them.
- `create or replace function` **cannot change the return type**. Changing
  `bigint` to `jsonb` fails `42P13`. Drop first, then recreate, then re-grant.
- The **Supabase SQL editor runs a pasted block as one transaction.** A failure
  anywhere rolls back everything, including statements that appeared to succeed.
  Never assume the earlier half went through — end every block with a
  verification `select` and read it.
- The editor shows only the **last statement's** result. Multi-statement pastes
  hide everything before it.
- Supabase grants **ALL** on new tables to `anon`, and `ALL` includes
  `TRUNCATE`, `REFERENCES` and `TRIGGER`. Revoking only
  INSERT/SELECT/UPDATE/DELETE leaves TRUNCATE — which bypasses RLS entirely and
  can empty the table. Revoke all seven.
- `security definer` without `set search_path` is hijackable via a
  caller-controlled schema. Always pin it.
- **Free projects pause after ~7 days** of inactivity. Once paused you have 90
  days to restore, then data is download-only. A weekly scheduled query prevents
  it; a paid tier removes it.

**PostgREST**

- RPCs resolve **by argument name**. `rpc("fn", {})` returns `PGRST202` even when
  the function exists, because no zero-argument overload matches. Existence
  probes must use real argument names.
- After creating functions or views, `notify pgrst, 'reload schema';` if you get
  "could not find … in the schema cache".

**Browser**

- The **disk cache** serves stale JS keyed on the exact URL. A new tab is not
  enough, and fetching `/app.js?x=1` to check the file misses the stale entry
  because it is a different cache key. Verify with a versioned `src`.

**Networks**

- Corporate and school Wi-Fi with **TLS interception** breaks Python, Go and CLI
  clients (`CERTIFICATE_VERIFY_FAILED`) while browsers keep working, because the
  interception CA is installed in the OS store but not in `certifi`. Symptoms
  look like server failure and are not.
- Consequently: **verification scripts must distinguish transport errors from
  API errors.** Ours reported two false PASSes under interception because probes
  ended with `return True` for "any error that isn't the specific one I expect".
  Check connectivity first and abort, rather than scoring a broken run.

**Tooling**

- Heredocs mangle backslash escapes. `\\n` inside a shell heredoc arrives as a
  literal newline and breaks the file. Write files with an editor tool instead of
  shelling out when the content contains escapes.

---

## 9. If building this for a company

Different problem, not just a bigger one.

- **"Anonymous" is a promise with weight.** Technical anonymity is not legal
  anonymity — auth logs, timestamps and writing style all narrow things down. Be
  precise about what is actually promised, and get it agreed before building.
- **Serious reports need a defined path.** Harassment or safety reports must not
  sit in a queue with cafeteria suggestions. Decide who is alerted and how,
  before launch. This is a policy decision, not a software one.
- **Reviewer actions need an audit trail.** Who approved what, and when. The
  school version overwrites `status` with no history; a workplace version should
  not.
- **Retention.** How long items are kept, and who can delete them.
- **Routing.** One queue works for a school. A company likely needs suggestions
  directed to the right department, which means categories that map to owners.
- **Use the paid database tier.** Auto-pause is unacceptable for anything real.
- **Reconsider the frontend.** No-build was right for three pages. Dashboards,
  filtering and per-department views justify a framework.

---

## 10. What I would do differently

- **Design the read path first.** The whole `42501` saga came from adding a write
  path with no read policy. Deciding who can read what, first, would have avoided
  it entirely.
- **Put tunable values in a config table from the start.** Thresholds, limits and
  domain restrictions all ended up there eventually; starting there would have
  avoided several redeploys.
- **Keep the rules text in one place.** It is currently duplicated between the
  edge function and the CLI tool.
- **Write the verification script before the features.** It caught real problems,
  but only after being fixed to stop reporting false passes — a check that can
  pass while proving nothing is worse than no check.
