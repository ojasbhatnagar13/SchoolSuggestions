"""Accuracy test: does the AI sort realistic student submissions correctly?

    backend\\venv\\Scripts\\python.exe tests\\eval\\accuracy.py
    backend\\venv\\Scripts\\python.exe tests\\eval\\accuracy.py --limit 20     quick look
    backend\\venv\\Scripts\\python.exe tests\\eval\\accuracy.py --only concern  one kind

Runs every case in tests/eval/cases.json through the same instructions,
guidelines and model order as the live site, paced to stay inside the
free-tier per-minute limit, and saves nothing. Then checks that each group of
differently-worded duplicates would really be caught, using the database's
own similarity function.

Writes a report to tests/eval/results/ and prints a summary. Exits non-zero
if ANY wellbeing concern is missed, or overall accuracy is under 90%.

Cost: one Gemini request per case (about 150), sometimes two if a model is
busy. Takes roughly 10-15 minutes at the default pace.
"""

import argparse
import itertools
import json
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime

from common import HERE, ROOT, load_main, load_rules, make_client, moderate, outcome

PASS_RATE = 0.90


def accepted(case) -> list[str]:
    return case["expect"] if isinstance(case["expect"], list) else [case["expect"]]


def topic_similarities(groups: dict) -> tuple[list, float | None]:
    """Ask Postgres itself how alike each pair of topics in a group is, with
    the exact expression submit_suggestion uses. Needs the Supabase CLI."""
    npx = shutil.which("npx.cmd") or shutil.which("npx")
    pairs = [(g, a, b) for g, topics in groups.items() for a, b in itertools.combinations(topics, 2)]
    if not npx or not pairs:
        return [], None

    def lit(s):
        return "'" + s.replace("'", "''") + "'"

    values = ", ".join(f"({lit(g)}, {lit(a)}, {lit(b)})" for g, a, b in pairs)
    sql = (
        "select g, a, b, greatest(similarity(a, b), word_similarity(a, b), word_similarity(b, a)) as score, "
        "(select duplicate_threshold from public.app_config where id) as threshold "
        f"from (values {values}) as t(g, a, b)"
    )
    out = subprocess.run(
        [npx, "--yes", "supabase@latest", "db", "query", "--remote", "--read-only", sql],
        cwd=ROOT, capture_output=True, text=True, timeout=180,
    )
    if out.returncode != 0:
        return [], None
    rows = json.loads(out.stdout)["rows"]
    threshold = rows[0]["threshold"] if rows else None
    return rows, threshold


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, help="only the first N cases")
    parser.add_argument("--only", help="only cases expecting this outcome (pending/rejected/spam/concern)")
    parser.add_argument("--delay", type=float, default=4.0, help="seconds between requests (default 4)")
    args = parser.parse_args()

    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))["cases"]
    if args.only:
        cases = [c for c in cases if args.only in accepted(c)]
    if args.limit:
        cases = cases[: args.limit]

    main_py = load_main()
    rules = load_rules()
    client = make_client()

    results = []
    print(f"Running {len(cases)} cases, {args.delay}s apart...\n")
    for i, case in enumerate(cases, 1):
        benefit = case.get("benefit", "")
        analysis, model, seconds, errors = moderate(main_py, client, rules, case["text"], benefit, retry_wait=30)
        got = outcome(analysis, case["text"], benefit)
        ok = got in accepted(case)
        results.append({**case, "got": got, "ok": ok, "model": model, "seconds": seconds,
                        "reason": (analysis or {}).get("reason", ""), "topic": (analysis or {}).get("topic"),
                        "errors": errors})
        mark = "ok  " if ok else "MISS"
        print(f"[{i:3}/{len(cases)}] {mark} {got:<10} {case['text'][:70]}")
        time.sleep(args.delay)

    # ---------------------------------------------------------------- scoring
    checked = [r for r in results if r["got"] != "unchecked"]
    unchecked = [r for r in results if r["got"] == "unchecked"]
    correct = sum(r["ok"] for r in checked)
    rate = correct / len(checked) if checked else 0.0

    by_kind = defaultdict(lambda: [0, 0])
    for r in checked:
        kind = r["expect"] if isinstance(r["expect"], str) else "borderline"
        by_kind[kind][0] += r["ok"]
        by_kind[kind][1] += 1

    missed_concerns = [r for r in results if accepted(r) == ["concern"] and r["got"] != "concern"]
    false_alarms = [r for r in checked if r["got"] == "concern" and "concern" not in accepted(r)]
    misses = [r for r in checked if not r["ok"]]
    models = Counter(r["model"] or "none (would be saved unchecked)" for r in results)
    avg = sum(r["seconds"] for r in results) / len(results) if results else 0

    groups = defaultdict(list)
    for r in results:
        if r.get("group") and r["topic"]:
            groups[r["group"]].append(r["topic"])
    pairs, threshold = topic_similarities(groups)
    dup_fail = [p for p in pairs if threshold is not None and p["score"] < threshold]

    # ---------------------------------------------------------------- report
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    lines = [
        f"# Accuracy test, {datetime.now():%d %b %Y %H:%M}",
        "",
        f"- Cases: {len(results)} ({len(unchecked)} could not be checked because every model was busy)",
        f"- **Correct: {correct}/{len(checked)} ({rate:.0%})**",
        f"- **Wellbeing concerns missed: {len(missed_concerns)}** (must be 0)",
        f"- False alarms (sent to the red section by mistake): {len(false_alarms)}",
        f"- Average time per check: {avg:.1f}s",
        "- Answered by: " + ", ".join(f"{m} x{n}" for m, n in models.most_common()),
        "",
        "## By kind",
        "",
        "| Expected | Correct |",
        "|---|---|",
        *[f"| {k} | {ok}/{n} |" for k, (ok, n) in sorted(by_kind.items())],
        "",
    ]
    if missed_concerns:
        lines += ["## MISSED CONCERNS (fix before launch)", ""]
        lines += [f"- “{r['text']}” -> {r['got']}. AI said: {r['reason']}" for r in missed_concerns]
        lines.append("")
    if misses:
        lines += ["## Everything it got wrong", "", "| Submission | Expected | Got | AI's reason |", "|---|---|---|---|"]
        for r in misses:
            exp = "/".join(accepted(r))
            lines.append(f"| {r['text'][:80]} | {exp} | {r['got']} | {r['reason'][:120]} |")
        lines.append("")
    if pairs:
        lines += [f"## Duplicate groups (threshold {threshold})", "",
                  "Every pair in a group must reach the threshold to be caught as the same suggestion.", ""]
        for g in groups:
            scores = [p["score"] for p in pairs if p["g"] == g]
            lines.append(f"- **{g}**: topics {sorted(set(groups[g]))}; weakest pair {min(scores):.2f}"
                         + (" -- would NOT all be caught" if min(scores) < threshold else ""))
        lines.append("")
    elif groups:
        lines += ["## Duplicate groups", "", "Skipped: the Supabase CLI was not available.", ""]

    results_dir = HERE / "results"
    results_dir.mkdir(exist_ok=True)
    report = results_dir / f"accuracy-{stamp}.md"
    report.write_text("\n".join(lines), encoding="utf-8")
    (results_dir / f"accuracy-{stamp}.json").write_text(json.dumps(results, indent=1), encoding="utf-8")

    print("\n" + "\n".join(lines[:9]))
    if dup_fail:
        print(f"- Duplicate pairs below the threshold: {len(dup_fail)}")
    print(f"\nFull report: {report}")
    return 1 if missed_concerns or rate < PASS_RATE else 0


if __name__ == "__main__":
    sys.exit(main())
