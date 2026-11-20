"""Attacks anyone with the public key could try, run against the live project.

The anon key ships to every browser, so these are exactly the requests a
curious student with the developer tools open could make. Each one must be
refused. Nothing here writes data.
"""

import unittest

from helpers import SSL_CONTEXT, edge, is_refused, request, rpc, table, public_config

TABLES = [
    "suggestions", "suggestion_votes", "staff", "app_config",
    "submission_quota", "submission_throttle", "moderation_rules",
]

STAFF_ONLY = {
    "staff_suggestions": {},
    "staff_set_status": {"p_id": 1, "p_status": "approved"},
    "staff_get_rules": {},
    "staff_set_rules": {"p_rules": "Usually acceptable:\n- anything", "p_school_context": ""},
    "staff_resolve_concern": {"p_id": 1, "p_outcome": "not_concern"},
    "staff_reword": {"p_id": 1, "p_suggestion": "hijacked wording", "p_benefit": ""},
    "staff_restore_original": {"p_id": 1},
    "staff_set_reason": {"p_id": 1, "p_reason": "hijacked"},
    "staff_feedback": {},
    "staff_mark_feedback": {"p_id": 1, "p_handled": True},
}

SIGNED_IN_ONLY = {
    "vote_for_suggestion": {"p_id": 1},
    "unvote_suggestion": {"p_id": 1},
    "my_votes": {},
    "board_access_error": {},
    "my_suggestions": {},
    "mark_my_suggestions_seen": {"p_ids": [1]},
    "send_feedback": {"p_kind": "other", "p_message": "spam from outside"},
}

INTERNAL = {
    "submit_secret_ok": {"p_secret": "guess"},
    "claim_submission_slot": {"p_device_hash": "a" * 64, "p_network_hash": "b" * 64},
}

NEEDS_SECRET = {
    "submit_suggestion": {
        "p_suggestion": "test", "p_spam": "No", "p_feasibility": "Feasible",
        "p_category": "Test", "p_reason": "test", "p_summary": "test", "p_secret": "guess",
    },
    "claim_account_slot": {"p_secret": "guess", "p_account_hash": "a" * 64},
    "refund_account_slot": {"p_secret": "guess", "p_account_hash": "a" * 64},
    "moderation_config": {"p_secret": "guess"},
    "live_topics": {"p_secret": "guess"},
    "queued_suggestions": {"p_secret": "guess", "p_limit": 5},
    "queue_attempt_failed": {"p_secret": "guess", "p_id": 1},
    "apply_ai_check": {"p_secret": "guess", "p_id": 1, "p_spam": "No", "p_feasibility": "Feasible",
                       "p_category": "x", "p_reason": "x", "p_summary": "x", "p_topic": "x",
                       "p_flags": [], "p_concern": False},
}


class TestTablesAreClosed(unittest.TestCase):
    def test_no_table_readable_with_the_public_key(self):
        for name in TABLES:
            with self.subTest(table=name):
                res = table(name)
                self.assertTrue(is_refused(res) or res.status == 404, f"{name}: {res}")

    def test_student_view_needs_sign_in(self):
        res = table("public_suggestions")
        self.assertTrue(is_refused(res), f"public_suggestions readable without signing in: {res}")


class TestFunctionsAreGuarded(unittest.TestCase):
    def check_all_refused(self, calls):
        for name, body in calls.items():
            with self.subTest(function=name):
                res = rpc(name, body)
                self.assertTrue(is_refused(res), f"{name} was not refused: {res}")

    def test_staff_functions(self):
        self.check_all_refused(STAFF_ONLY)

    def test_signed_in_functions(self):
        self.check_all_refused(SIGNED_IN_ONLY)

    def test_internal_functions(self):
        self.check_all_refused(INTERNAL)

    def test_writes_need_the_server_secret(self):
        """Without the secret, nobody can skip the AI and the limit."""
        for name, body in NEEDS_SECRET.items():
            with self.subTest(function=name):
                res = rpc(name, body)
                self.assertTrue(is_refused(res), f"{name}: {res}")
                self.assertIn("Not allowed", res.message)


class TestPublicSurface(unittest.TestCase):
    """The few things that are meant to work without signing in."""

    def test_guidelines_are_public(self):
        res = rpc("public_rules")
        self.assertEqual(res.status, 200, res)
        self.assertIn(":", res.json["rules"])
        self.assertNotIn("school_context", res.json, "background notes must stay staff/AI-only")

    def test_keepalive_function(self):
        """The GitHub keep-alive workflow depends on this answering."""
        res = rpc("auto_status", {"p_spam": "No", "p_feasibility": "Feasible"})
        self.assertEqual(res.status, 200, res)


class TestEdgeFunction(unittest.TestCase):
    def test_refuses_without_sign_in(self):
        res = edge({"suggestion": "Add more benches"})
        self.assertEqual(res.status, 401, res)
        self.assertTrue(res.json.get("signin"))

    def test_refuses_a_made_up_token(self):
        res = edge({"suggestion": "Add more benches"}, token="not.a.real-token")
        self.assertIn(res.status, (401, 403), res)

    def test_cors_preflight(self):
        res = request("OPTIONS", f"{public_config()['url']}/functions/v1/moderate-suggestion")
        self.assertEqual(res.status, 200, res)

    def test_queue_run_needs_the_server_secret(self):
        """Only pg_cron, holding the secret, may trigger a queue run."""
        url = f"{public_config()['url']}/functions/v1/moderate-suggestion"
        import json, urllib.request, urllib.error
        cfg = public_config()
        req = urllib.request.Request(url, data=b'{"queue": true}', method="POST", headers={
            "apikey": cfg["key"], "Authorization": f"Bearer {cfg['key']}",
            "Content-Type": "application/json", "x-queue-secret": "guess"})
        try:
            status = urllib.request.urlopen(req, timeout=30, context=SSL_CONTEXT).status
        except urllib.error.HTTPError as err:
            status = err.code
        self.assertEqual(status, 403)

    def test_rewording_is_staff_only(self):
        """The rephrase function spends AI quota, so nobody but staff may use it."""
        for token in (None, "not.a.real-token"):
            with self.subTest(token=token):
                res = edge({"suggestion": "anything"}, token=token, function="rephrase-suggestion")
                self.assertIn(res.status, (401, 403), res)


if __name__ == "__main__":
    unittest.main()
