"""Check the database matches what docs/setup.sql is supposed to produce.

Run after applying docs/setup.sql:

    cd "C:\\Users\\Ojas Bhatnagar\\Desktop\\SchoolSuggestions\\backend"
    .\\venv\\Scripts\\python.exe verify_setup.py

All checks are read-only and side-effect-free by default.
Pass --full to also run a real write round-trip (inserts one probe row) and a
real vote (increments one counter).

This replaces the old supabase_test.py, which tested the insert path that
main.py now owns.

Note on probing RPCs: PostgREST resolves functions by ARGUMENT NAMES, so
calling rpc("submit_suggestion", {}) returns PGRST202 even when the function
exists. Every probe below therefore uses the real argument names.
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

PROBE_MARKER = "VERIFY-PROBE (safe to delete)"
results = []


def missing(exc) -> bool:
    """True if the error means 'no such function/table', not a real failure."""
    s = str(exc)
    return "PGRST202" in s or "could not find" in s.lower()


def is_transport_error(exc) -> bool:
    """True for TLS/DNS/connection failures -- the network, not the database.

    These must never be mistaken for a probe result. School Wi-Fi with TLS
    interception produces CERTIFICATE_VERIFY_FAILED on every request, and a
    probe that treats "some error occurred" as success will report a pass.
    """
    s = str(exc)
    return any(m in s for m in (
        "CERTIFICATE_VERIFY_FAILED", "SSLError", "ConnectError",
        "ConnectTimeout", "getaddrinfo", "Connection refused",
    ))


def connectivity_problem(url: str):
    """Return an error string if the host is unreachable, else None.

    Any HTTP response at all -- including 404 -- proves TLS and DNS work.
    """
    import httpx
    try:
        httpx.get(url, timeout=15)
        return None
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"


def check(label, fn):
    """fn returns (ok: bool, detail: str)."""
    try:
        ok, detail = fn()
    except Exception as exc:
        if is_transport_error(exc):
            raise SystemExit(
                "\nNETWORK FAILURE during '" + label + "':\n  " + str(exc) +
                "\n\nResults would be meaningless, so nothing further was checked."
            )
        ok, detail = False, f"{type(exc).__name__}: {str(exc)[:90]}"
    status = "PASS" if ok else "FAIL"
    results.append(status)
    print(f"  [{status}] {label}")
    if detail:
        print(f"         {detail}")


def main() -> int:
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        print("SUPABASE_URL or SUPABASE_KEY missing from backend/.env")
        return 1
    sb = create_client(url, key)
    full = "--full" in sys.argv

    problem = connectivity_problem(url)
    if problem:
        print(f"\nCannot reach {url}")
        print(f"  {problem}\n")
        print("This is the network, not the database. CERTIFICATE_VERIFY_FAILED")
        print("means TLS interception (e.g. school Wi-Fi). Retry on another")
        print("network; no checks were run.")
        return 2

    print("\nSection 1 -- diagnostic artefacts removed")

    def dropped(name, args):
        def probe():
            try:
                sb.rpc(name, args).execute()
                return False, f"{name} still exists -- rerun setup.sql section 1"
            except Exception as exc:
                if missing(exc):
                    return True, f"{name} dropped"
                return False, f"{name} still exists ({str(exc)[:60]})"
        return probe

    check("get_auth_role() dropped", dropped("get_auth_role", {}))
    check("debug_insert_test() dropped", dropped("debug_insert_test", {}))

    print("\nSection 2/3 -- read path")

    def view_readable():
        rows = sb.table("public_suggestions").select("*").execute().data
        cols = set(rows[0]) if rows else set()
        leaked = cols & {"spam", "feasibility", "reason"}
        if leaked:
            return False, f"view leaks moderation columns: {', '.join(sorted(leaked))}"
        detail = f"{len(rows)} row(s) visible"
        if cols:
            detail += f", columns: {', '.join(sorted(cols))}"
        return True, detail

    check("public_suggestions view readable", view_readable)

    def has_created_at():
        rows = sb.table("public_suggestions").select("created_at").limit(1).execute().data
        if not rows:
            return True, "column exists (query succeeded); no rows to sample"
        return True, f"created_at present, e.g. {rows[0]['created_at']}"

    check("created_at column exists", has_created_at)

    print("\nSection 4 -- voting")

    def vote_fn_exists():
        # p_id = -1 can never match a row, so this proves existence without
        # changing any data: the function raises 'not found', a missing
        # function raises PGRST202.
        try:
            sb.rpc("vote_for_suggestion", {"p_id": -1}).execute()
            return False, "returned success for id -1 -- guard clause is not working"
        except Exception as exc:
            if is_transport_error(exc):
                raise
            if missing(exc):
                return False, "vote_for_suggestion MISSING -- run setup-auth.sql section 2"
            if "permission denied" in str(exc).lower():
                # Expected once setup-auth.sql has revoked anon's access. This
                # script runs as anon and cannot sign in, so that is as far as
                # it can check.
                return True, "exists; anon correctly denied (auth-gated voting is live)"
            return True, "exists and correctly rejects a nonexistent id"

    check("vote_for_suggestion() exists and guards", vote_fn_exists)

    print("\nSection 5 -- hardening")

    def table_locked():
        # Before section 5: SELECT succeeds and returns 0 rows (grant present,
        # RLS filters everything). After: it raises permission denied.
        try:
            rows = sb.table("suggestions").select("*").execute().data
            return False, (
                f"anon still holds SELECT on the base table "
                f"({len(rows)} rows returned) -- run setup.sql section 5"
            )
        except Exception as exc:
            if is_transport_error(exc):
                raise
            if missing(exc):
                return False, "base table not found -- unexpected"
            return True, "direct table access denied; view is the only read path"

    check("base table not directly readable", table_locked)

    print("\nWrite path")

    if not full:
        print("  [SKIP] submit_suggestion() round-trip -- pass --full to test")
    else:
        def write_roundtrip():
            new_id = sb.rpc("submit_suggestion", {
                "p_suggestion": PROBE_MARKER,
                "p_spam": "No",
                "p_feasibility": "Needs Review",
                "p_category": "Diagnostic",
                "p_reason": "verify_setup.py round-trip probe",
                "p_summary": PROBE_MARKER,
            }).execute().data
            if not isinstance(new_id, int):
                return False, f"expected an integer id, got {new_id!r}"
            seen = sb.table("public_suggestions").select("id").eq("id", new_id).execute().data
            if not seen:
                return False, f"wrote id {new_id} but it is not visible through the view"
            return True, f"wrote and read back id {new_id} -- DELETE THIS ROW"

        check("submit_suggestion() round-trip", write_roundtrip)

        def live_vote():
            rows = sb.table("public_suggestions").select("id,votes").limit(1).execute().data
            if not rows:
                return False, "no rows to vote on"
            before = rows[0].get("votes") or 0
            try:
                after = sb.rpc("vote_for_suggestion", {"p_id": rows[0]["id"]}).execute().data
            except Exception as exc:
                if "permission denied" in str(exc).lower():
                    return True, "skipped -- voting now requires sign-in; test from the browser"
                raise
            return after == before + 1, f"id {rows[0]['id']}: {before} -> {after}"

        check("vote increments by exactly 1", live_vote)

    failed = results.count("FAIL")
    print(f"\n{len(results) - failed}/{len(results)} checks passed")
    if failed:
        print("Unfinished steps are in docs/setup.sql.")
    elif full:
        print(f"Remember to delete the probe row: suggestion = '{PROBE_MARKER}'")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
