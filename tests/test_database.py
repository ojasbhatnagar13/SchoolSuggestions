"""The database's own rules, run against the live project.

Most of these need SUBMIT_SECRET (in backend/.env, or as a GitHub secret) and
are skipped without it. They never create a suggestion:

- the rate-limit test uses a random, throwaway account code; its quota row
  holds only that code and the hour, and is purged after two days.
- the duplicate test submits an idea that already exists, which is stopped
  before anything is written. Set DUPLICATE_PROBE_TOPIC if the probe idea
  ever changes.
"""

import os
import secrets
import unittest

from helpers import load_env, rpc

load_env()
SECRET = os.getenv("SUBMIT_SECRET")
needs_secret = unittest.skipUnless(SECRET, "SUBMIT_SECRET not set")


class TestAutoSorting(unittest.TestCase):
    """What the AI's verdict turns into. Pure function, safe to call."""

    CASES = [
        ("Yes", "Feasible", "spam"),
        ("Yes", "Not Feasible", "spam"),
        ("No", "Not Feasible", "rejected"),
        ("No", "Needs Review", "pending"),
        ("No", "Feasible", "pending"),
    ]

    def test_verdict_to_status(self):
        for spam, feasibility, expected in self.CASES:
            with self.subTest(spam=spam, feasibility=feasibility):
                res = rpc("auto_status", {"p_spam": spam, "p_feasibility": feasibility})
                self.assertEqual(res.json, expected, res)


@needs_secret
class TestRateLimit(unittest.TestCase):
    def test_five_an_hour_then_blocked(self):
        account = secrets.token_hex(32)  # a made-up account, never a real one
        for n in range(5):
            res = rpc("claim_account_slot", {"p_secret": SECRET, "p_account_hash": account})
            self.assertEqual(res.status, 200, f"slot {n + 1} refused: {res}")
        res = rpc("claim_account_slot", {"p_secret": SECRET, "p_account_hash": account})
        self.assertNotEqual(res.status, 200, "the 6th submission in an hour was allowed")
        self.assertIn("this hour", res.message)

    def test_rejects_a_malformed_account_code(self):
        res = rpc("claim_account_slot", {"p_secret": SECRET, "p_account_hash": "short"})
        self.assertNotEqual(res.status, 200)


@needs_secret
class TestDuplicates(unittest.TestCase):
    def test_same_idea_in_other_words_is_caught_without_writing(self):
        topic = os.getenv("DUPLICATE_PROBE_TOPIC", "school food quality")
        res = rpc("submit_suggestion", {
            "p_secret": SECRET,
            "p_suggestion": "[automated test] the canteen food should be better",
            "p_spam": "No", "p_feasibility": "Feasible", "p_category": "Test",
            "p_reason": "automated test", "p_summary": "automated test",
            "p_topic": topic,
        })
        self.assertEqual(res.status, 200, res)
        if res.json.get("status") != "duplicate":
            self.fail(
                f"Expected a duplicate but a row was written (id {res.json.get('id')}). "
                f"No live idea matches '{topic}' any more: reject that test row on the "
                f"staff page and set DUPLICATE_PROBE_TOPIC to an existing idea's topic."
            )


@needs_secret
class TestModerationConfig(unittest.TestCase):
    def test_rules_and_background_load(self):
        res = rpc("moderation_config", {"p_secret": SECRET})
        self.assertEqual(res.status, 200, res)
        self.assertGreater(len(res.json["rules"]), 20)
        self.assertIn("school_context", res.json)


if __name__ == "__main__":
    unittest.main()
