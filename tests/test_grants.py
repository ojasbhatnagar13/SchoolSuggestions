"""What the API roles are actually granted, read from the database itself.

test_security.py can only see the outside: a table that answers "200, []"
looks fine there even when the role holds full write privileges and only
row security is hiding the rows. That is how the writable student view was
missed until 2026-10-02 (see docs/setup-tighten-grants.sql). This test reads
the grants directly so it cannot be missed again.

Needs the Supabase CLI, logged in and linked (npx supabase login / link), so
it runs on the project owner's machine and is skipped anywhere else.
"""

import json
import shutil
import subprocess
import unittest

from helpers import ROOT

NPX = shutil.which("npx.cmd") or shutil.which("npx")

# The only table-level grants the API roles should hold.
EXPECTED = {("public_suggestions", "authenticated", "SELECT")}

# Functions that must be callable without signing in. Everything else that
# anon can execute is a mistake.
ANON_FUNCTIONS = {
    "auto_status", "public_rules", "submit_suggestion", "claim_account_slot", "refund_account_slot",
    "moderation_config", "live_topics",
    # the AI queue (docs/setup-ai-queue.sql); all demand the server secret
    "queued_suggestions", "apply_ai_check", "queue_attempt_failed",
}


def query(sql: str):
    out = subprocess.run(
        # --read-only: newer CLIs refuse any unflagged query against a hosted
        # project from an automated run, and these only ever read.
        [NPX, "--yes", "supabase@latest", "db", "query", "--remote", "--read-only", sql],
        cwd=ROOT, capture_output=True, text=True, timeout=180,
    )
    if out.returncode != 0:
        raise unittest.SkipTest(f"Supabase CLI unavailable: {out.stderr.strip()[-160:]}")
    return json.loads(out.stdout)["rows"]


@unittest.skipUnless(NPX, "npx not installed")
class TestGrants(unittest.TestCase):
    def test_tables_and_views(self):
        rows = query(
            # Straight from the ACLs. In --read-only mode the CLI runs as a
            # limited role, and information_schema.role_table_grants only lists
            # grants involving that role, so it would come back empty.
            "select c.relname as table_name, r.rolname as grantee, a.privilege_type "
            "from pg_class c join pg_namespace n on n.oid = c.relnamespace "
            "cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid = a.grantee "
            "where n.nspname = 'public' and c.relkind in ('r', 'v') "
            "and r.rolname in ('anon', 'authenticated')"
        )
        found = {(r["table_name"], r["grantee"], r["privilege_type"]) for r in rows}
        self.assertEqual(found - EXPECTED, set(), "API roles hold privileges they should not")
        self.assertEqual(EXPECTED - found, set(), "the student view lost its read grant")

    def test_rls_on_every_table(self):
        rows = query(
            "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace "
            "where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity"
        )
        self.assertEqual([r["relname"] for r in rows], [], "tables without row level security")

    def test_anon_can_only_run_the_intended_functions(self):
        rows = query(
            "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
            "where n.nspname = 'public' and p.prokind = 'f' "
            "and has_function_privilege('anon', p.oid, 'execute') "
            "and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')"
        )
        extra = {r["proname"] for r in rows} - ANON_FUNCTIONS
        self.assertEqual(extra, set(), "anon can run functions it should not")

    def test_nobody_is_handed_the_sender(self):
        """Suggestions record their sender so students can follow their own
        (docs/setup-my-suggestions.sql), but staff must never see it: no view
        column and no function result may carry author_id."""
        views = query(
            "select table_name, column_name from information_schema.columns "
            "where table_schema = 'public' and column_name like 'author%' "
            "and table_name <> 'suggestions'"
        )
        self.assertEqual(views, [], "a view exposes the sender")
        outputs = query(
            "select p.proname, a.name from pg_proc p "
            "join pg_namespace n on n.oid = p.pronamespace "
            "cross join lateral unnest(p.proargnames, p.proargmodes) as a(name, mode) "
            "where n.nspname = 'public' and a.mode in ('o', 't', 'b') and a.name like 'author%'"
        )
        self.assertEqual(outputs, [], "a function returns the sender")

    def test_staff_page_never_names_staff(self):
        """Decision 2026-11-19: nobody sees which member of staff made a
        decision. The staff page's data must not look up anyone's email."""
        rows = query(
            "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
            "where n.nspname = 'public' and p.proname in ('staff_suggestions', 'staff_get_rules') "
            "and pg_get_functiondef(p.oid) like '%auth.users%'"
        )
        self.assertEqual([r["proname"] for r in rows], [])

    def test_definer_functions_pin_search_path(self):
        """A security definer function without a fixed search_path can be hijacked."""
        rows = query(
            "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
            "where n.nspname = 'public' and p.prosecdef "
            "and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')"
        )
        self.assertEqual([r["proname"] for r in rows], [])


if __name__ == "__main__":
    unittest.main()
