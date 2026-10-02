"""Run the test suite.

    python tests/run_tests.py            code checks + live security/database checks
    python tests/run_tests.py --offline  code checks only, no network
    python tests/run_tests.py --ai       everything, plus the AI's verdicts
                                         on sample ideas (uses Gemini quota)

To test one model alone, with no fallback:
    AI_TEST_MODEL=gemini-3.5-flash-lite python tests/run_tests.py --ai

On Windows use the project's Python:
    backend\\venv\\Scripts\\python.exe tests\\run_tests.py

What each file covers:
    test_static.py    secrets, XSS, links, limits, prompt copies in step
    test_security.py  everything the public key must NOT be able to do
    test_grants.py    the privileges themselves, read from the database
                      (needs the Supabase CLI logged in; skipped otherwise)
    test_database.py  auto-sorting, rate limit, duplicates, guidelines
    test_ai.py        how the AI sorts realistic ideas (opt-in)

Not covered, because it needs a real Google sign-in: a full submission
through the website, voting, and the staff page. Check those by hand after a
big change.
"""

import argparse
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--offline", action="store_true", help="skip everything that needs the network")
    parser.add_argument("--ai", action="store_true", help="also test the AI's verdicts (uses Gemini quota)")
    args = parser.parse_args()

    if args.ai:
        os.environ["RUN_AI_TESTS"] = "1"

    names = ["test_static"] if args.offline else ["test_static", "test_security", "test_grants", "test_database", "test_ai"]
    suite = unittest.defaultTestLoader.loadTestsFromNames(names)
    result = unittest.TextTestRunner(verbosity=2).run(suite)

    skipped = len(result.skipped)
    if skipped:
        reasons = sorted({reason for _, reason in result.skipped})
        print(f"\n{skipped} skipped: " + "; ".join(reasons))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
