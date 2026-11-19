"""Burst test: what happens when a whole class presses Send at once?

    backend\\venv\\Scripts\\python.exe tests\\eval\\burst.py            30 at once
    backend\\venv\\Scripts\\python.exe tests\\eval\\burst.py --size 60  a bigger class

Fires SIZE checks at the same moment through the live model order and
timeouts -- no retries, because a real student will not wait -- and at the
same time SIZE of the database steps every submission makes (reading the
guidelines and claiming a rate-limit slot). Saves no suggestions.

Answers: how many get the AI check from the main model, how many fall back,
how many would be saved unchecked for staff to read, and how long a student
waits. The free Gemini tier's per-minute limit is what this is looking for.

Side effect: SIZE rate-limit rows for random, made-up accounts. They hold no
link to anyone and are purged automatically after two days.

Cost: SIZE Gemini requests (more where models fall through). Run it at most
once a minute, or the second run measures the first one's limit.
"""

import argparse
import json
import os
import secrets
import statistics
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from common import HERE, live_models, load_main, load_rules, make_client, moderate, outcome
from helpers import rpc

SAMPLES = [
    "Can we start a robotics club for grade 7 and 8?",
    "more dustbins in the corridors please",
    "Add more fruit options at breakfast",
    "the wifi in the secondary block keeps dropping",
    "A student-run school podcast",
    "Bring footballs for recess",
    "Fix the broken tap in the boys toilet on the first floor",
    "Can the library stay open till 4 on fridays",
    "lol asdfgh",
    "inter house quiz competition every term",
]


def pct(values, p):
    if not values:
        return 0.0
    values = sorted(values)
    return values[min(len(values) - 1, round(p / 100 * (len(values) - 1)))]


def main() -> int:
    # Student text can contain emoji; Windows' default cp1252 cannot print them.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--size", type=int, default=30, help="submissions at once (default 30, one class)")
    args = parser.parse_args()

    main_py = load_main()
    rules = load_rules()
    models = live_models()
    secret = os.environ["SUBMIT_SECRET"]

    # Everyone waits at the gate, then all go together.
    gate = threading.Barrier(args.size * 2)

    def ai_check(i):
        client = make_client()  # one per "student", like separate requests
        text = SAMPLES[i % len(SAMPLES)]
        gate.wait()
        analysis, model, seconds, errors = moderate(main_py, client, rules, text)
        return {"model": model, "seconds": seconds, "outcome": outcome(analysis, text), "errors": errors}

    def db_steps(i):
        gate.wait()
        started = time.monotonic()
        cfg = rpc("moderation_config", {"p_secret": secret})
        slot = rpc("claim_account_slot", {"p_secret": secret, "p_account_hash": secrets.token_hex(32)})
        return {"ok": cfg.status == 200 and slot.status == 200, "seconds": time.monotonic() - started,
                "status": f"{cfg.status}/{slot.status}"}

    print(f"Sending {args.size} checks and {args.size} database steps at the same moment...")
    with ThreadPoolExecutor(max_workers=args.size * 2) as pool:
        ai_futures = [pool.submit(ai_check, i) for i in range(args.size)]
        db_futures = [pool.submit(db_steps, i) for i in range(args.size)]
        ai = [f.result() for f in ai_futures]
        db = [f.result() for f in db_futures]

    # ---------------------------------------------------------------- results
    answered = Counter(r["model"] or "unchecked" for r in ai)
    main_model = models[0]
    first_try = answered.get(main_model, 0)
    fell_back = sum(n for m, n in answered.items() if m not in (main_model, "unchecked"))
    unchecked = answered.get("unchecked", 0)
    waits = [r["seconds"] for r in ai]
    db_waits = [r["seconds"] for r in db]
    db_failed = [r for r in db if not r["ok"]]
    error_kinds = Counter(e.split(":", 1)[1].strip()[:40] for r in ai for e in r["errors"])

    lines = [
        f"# Burst test, {datetime.now():%d %b %Y %H:%M}: {args.size} at once",
        "",
        "## AI check",
        "",
        f"- Checked by the main model ({main_model}): **{first_try}/{args.size}**",
        f"- Checked by a backup model: {fell_back}",
        f"- **Would be saved unchecked for staff: {unchecked}/{args.size}**",
        f"- Student wait: median {statistics.median(waits):.1f}s, slowest 10% {pct(waits, 90):.1f}s, worst {max(waits):.1f}s",
        "- Answered by: " + ", ".join(f"{m} x{n}" for m, n in answered.most_common()),
        "",
        "## Database steps",
        "",
        f"- Succeeded: {len(db) - len(db_failed)}/{len(db)}",
        f"- Time: median {statistics.median(db_waits):.2f}s, worst {max(db_waits):.2f}s",
        "",
    ]
    if error_kinds:
        lines += ["## What the models said when they refused", ""]
        lines += [f"- {kind}... x{n}" for kind, n in error_kinds.most_common(6)]
        lines.append("")
    if db_failed:
        lines += ["## Database failures", ""] + [f"- {r['status']}" for r in db_failed[:10]] + [""]

    verdict = ("Fine for a class this size." if unchecked == 0 and not db_failed else
               "Some students would get an unchecked save: the free tier's per-minute limit "
               "is being hit. Turning on Gemini billing raises it." if unchecked else
               "The database struggled; see failures above.")
    lines += ["## Verdict", "", verdict, ""]

    results_dir = HERE / "results"
    results_dir.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    report = results_dir / f"burst-{args.size}-{stamp}.md"
    report.write_text("\n".join(lines), encoding="utf-8")
    (results_dir / f"burst-{args.size}-{stamp}.json").write_text(json.dumps({"ai": ai, "db": db}, indent=1), encoding="utf-8")

    print("\n".join(lines))
    print(f"Full report: {report}")
    return 0 if not db_failed else 1


if __name__ == "__main__":
    sys.exit(main())
