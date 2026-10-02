"""Checks on the code itself. No network, runs in a second.

These catch the mistakes that would be dangerous or embarrassing to ship:
a secret key in the frontend, student text rendered as HTML, a broken link
between pages, or a stale cache-busting version.
"""

import base64
import json
import re
import subprocess
import unittest

from helpers import FRONTEND, ROOT, public_config

PAGES = ["index.html", "ideas.html", "how.html", "staff.html"]
STUDENT_TABS = {"index.html": "Suggest", "ideas.html": "Ideas", "how.html": "How it works"}


def jwt_payload(token: str) -> dict:
    part = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def tracked_files() -> list:
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True)
    return [ROOT / p for p in out.stdout.splitlines()]


class TestSecrets(unittest.TestCase):
    def test_frontend_key_is_the_public_anon_key(self):
        """A service_role key in the browser would bypass every protection."""
        role = jwt_payload(public_config()["key"]).get("role")
        self.assertEqual(role, "anon", "frontend/config.js must hold the anon key, never service_role")

    def test_no_secret_keys_committed(self):
        jwt = re.compile(r"eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}")
        offenders = []
        for path in tracked_files():
            if path.suffix in {".png", ".jpg", ".ico"} or not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if re.search(r"\bsb_secret_[\w-]{10,}", text) or re.search(r"AIza[\w-]{30,}", text):
                offenders.append(f"{path.name}: secret-style key")
            for token in jwt.findall(text):
                try:
                    if jwt_payload(token).get("role") != "anon":
                        offenders.append(f"{path.name}: non-anon JWT")
                except Exception:
                    pass
        self.assertEqual(offenders, [])

    def test_env_file_not_committed(self):
        names = {p.relative_to(ROOT).as_posix() for p in tracked_files()}
        self.assertNotIn("backend/.env", names)


class TestXss(unittest.TestCase):
    def test_no_innerhtml_in_frontend_scripts(self):
        """Suggestion text is student-written and must only ever be set as text."""
        for js in FRONTEND.glob("*.js"):
            # Comments may mention innerHTML (to say it is never used).
            code = re.sub(r"//[^\n]*|/\*.*?\*/", "", js.read_text(encoding="utf-8"), flags=re.S)
            for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"):
                self.assertNotIn(bad, code, f"{js.name} uses {bad}")


class TestPages(unittest.TestCase):
    def read(self, name):
        return (FRONTEND / name).read_text(encoding="utf-8")

    def test_local_references_exist(self):
        for page in PAGES:
            html = self.read(page)
            for ref in re.findall(r'(?:href|src)="([^"#:]+?)(?:\?[^"]*)?(?:#[^"]*)?"', html):
                if ref.startswith(("http", "mailto", "//")) or not ref:
                    continue
                self.assertTrue((FRONTEND / ref).exists(), f"{page} links to missing {ref}")

    def test_student_pages_share_the_tab_nav(self):
        for page, current in STUDENT_TABS.items():
            html = self.read(page)
            for target in STUDENT_TABS:
                self.assertIn(f'href="{target}"', html, f"{page} is missing the {target} tab")
            match = re.search(r'aria-current="page">([^<]+)<', html)
            self.assertIsNotNone(match, f"{page} has no current tab")
            self.assertEqual(match.group(1), current)

    def test_one_stylesheet_version_everywhere(self):
        versions = {re.search(r'style\.css\?v=(\d+)', self.read(p)).group(1) for p in PAGES}
        self.assertEqual(len(versions), 1, f"style.css versions differ between pages: {versions}")

    def test_form_limits_match_the_server(self):
        index = self.read("index.html")
        edge = (ROOT / "supabase/functions/moderate-suggestion/index.ts").read_text(encoding="utf-8")
        submit = (FRONTEND / "submit.js").read_text(encoding="utf-8")
        server_max = re.search(r"const MAX_LENGTH = (\d[\d_]*)", edge).group(1).replace("_", "")
        benefit_max = re.search(r"const BENEFIT_MAX_LENGTH = (\d[\d_]*)", edge).group(1).replace("_", "")
        self.assertIn(f'id="suggestion" maxlength="{server_max}"', index)
        self.assertIn(f'maxlength="{benefit_max}"', index)
        self.assertIn(f"const MAX_LENGTH = {server_max};", submit)


class TestConcernWords(unittest.TestCase):
    """The keyword safety net that flags a report even when the AI is down."""

    def pattern(self):
        edge = (ROOT / "supabase/functions/moderate-suggestion/index.ts").read_text(encoding="utf-8")
        # Up to "].join", not the first "]": the words contain [character classes].
        block = re.search(r"const CONCERN_WORDS = new RegExp\(\s*\[(.*?)\]\.join", edge, re.S).group(1)
        words = re.findall(r'"([^"]+)"', block)
        return re.compile("|".join(words), re.I)

    def test_catches_reports(self):
        for text in [
            "I'm being bullied in grade 8",
            "I keep thinking about self harm",
            "sometimes I want to die",
            "a boy keeps threatening me after school",
            "I feel unsafe in the changing rooms",
        ]:
            with self.subTest(text=text):
                self.assertTrue(self.pattern().search(text))

    def test_leaves_ordinary_ideas_alone(self):
        for text in [
            "Add more healthy options to the canteen menu",
            "Start a robotics club on Thursdays",
            "Put more benches near the basketball court",
        ]:
            with self.subTest(text=text):
                self.assertFalse(self.pattern().search(text))


class TestPromptsInStep(unittest.TestCase):
    def test_edge_function_and_main_py_use_the_same_prompt(self):
        """The two copies of the moderator instructions must not drift."""
        edge = (ROOT / "supabase/functions/moderate-suggestion/index.ts").read_text(encoding="utf-8")
        main = (ROOT / "backend/main.py").read_text(encoding="utf-8")
        ts = re.search(r"return `(You are the moderator.*?)`;", edge, re.S).group(1)
        ts = ts.replace("${rules}", "{rules}").replace('${schoolContext || "(none provided)"}', "{school_context}")
        py = re.search(r'SYSTEM_INSTRUCTION = """\\\n(.*?)"""', main, re.S).group(1)
        self.assertEqual(ts.strip(), py.strip())


if __name__ == "__main__":
    unittest.main()
