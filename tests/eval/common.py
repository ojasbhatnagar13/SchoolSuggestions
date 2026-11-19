"""Shared by tests/eval/accuracy.py and tests/eval/burst.py.

Mirrors how the live Edge Function decides, without saving anything:
  - the same instructions (backend/main.py, kept identical by test_static)
  - the live guidelines and school background, read from the database
  - the same model order, with the same 10 second timeout per model
  - the same concern check: the AI's exact reply, or the keyword net
"""

import importlib.util
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE.parent))
from helpers import load_env, rpc  # noqa: E402

load_env()

EDGE = ROOT / "supabase" / "functions" / "moderate-suggestion" / "index.ts"


def _edge_source() -> str:
    return EDGE.read_text(encoding="utf-8")


def live_models() -> list[str]:
    """The model order from the Edge Function itself, so the two cannot drift."""
    block = re.search(r"const MODELS = \[(.*?)\];", _edge_source(), re.S).group(1)
    return re.findall(r'"([^"]+)"', block)


def concern_pattern() -> re.Pattern:
    block = re.search(r"const CONCERN_WORDS = new RegExp\(\s*\[(.*?)\]\.join", _edge_source(), re.S).group(1)
    return re.compile("|".join(re.findall(r'"([^"]+)"', block)), re.I)


TIMEOUT_MS = int(re.search(r"const MODEL_TIMEOUT_MS = ([\d_]+);", _edge_source()).group(1).replace("_", ""))
SUPPORT_PREFIX = "This sounds like a personal concern"


def load_main():
    spec = importlib.util.spec_from_file_location("main", ROOT / "backend" / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_rules() -> dict:
    secret = os.getenv("SUBMIT_SECRET")
    if not secret:
        raise SystemExit("SUBMIT_SECRET is missing from backend/.env")
    res = rpc("moderation_config", {"p_secret": secret})
    if res.status != 200:
        raise SystemExit(f"Could not read the guidelines: {res}")
    return {
        "rules": res.json["rules"],
        "school_context": res.json.get("school_context") or "(none provided)",
        # Callers replace this as they go; see accuracy.py.
        "topics": "(none yet)",
    }


def make_client():
    """A Gemini client with the live site's per-model timeout."""
    from google import genai
    from google.genai import types

    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise SystemExit("GEMINI_API_KEY is missing from backend/.env")
    return genai.Client(api_key=key, http_options=types.HttpOptions(timeout=TIMEOUT_MS))


def moderate(main, client, rules, text, benefit="", models=None, retry_wait=0.0):
    """Run one submission through the model chain the way the site does.

    Returns (analysis or None, model that answered or None, seconds, errors).
    None means every model failed: the live site would save it unchecked.
    With retry_wait > 0, a full failure is retried once after that pause
    (the accuracy run uses this to ride out per-minute limits; the burst test
    does not, because a real student would not wait).
    """
    models = models or live_models()
    errors = []
    started = time.monotonic()
    for attempt in range(2 if retry_wait else 1):
        for model in models:
            main.MODEL = model
            try:
                analysis = main.analyse_suggestion(client, rules, text, benefit)
                return analysis, model, time.monotonic() - started, errors
            except Exception as exc:  # noqa: BLE001 -- any failure moves on, as live
                errors.append(f"{model}: {str(exc)[:140]}")
        if retry_wait and attempt == 0:
            time.sleep(retry_wait)
    return None, None, time.monotonic() - started, errors


def outcome(analysis, text, benefit="") -> str:
    """What the student and staff would end up with, as the live site decides."""
    words = concern_pattern()
    if analysis is None:
        return "concern" if words.search(text) or words.search(benefit) else "unchecked"
    hidden = "hidden_concern" in (analysis.get("flags") or [])
    if hidden or (analysis.get("reason") or "").startswith(SUPPORT_PREFIX) or words.search(text) or words.search(benefit):
        return "concern"
    if analysis["spam"] == "Yes":
        return "spam"
    if analysis["feasibility"] == "Not Feasible":
        return "rejected"
    return "pending"
