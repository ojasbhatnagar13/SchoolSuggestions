// The Leaderboard page: which grade and section has the most approved
// suggestions. Staff never see the class on any suggestion; only these
// totals exist outside the database.
import { sb, el, signIn, watchSession } from "./common.js";
import { showUpdates } from "./mine.js?v=4";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Weekly totals of approved suggestions per grade and
// section (docs/setup-class-totals.sql). Votes are given for the leading class only.
const classesEl = document.getElementById("classes");
let classes = [];

function renderClasses() {
  if (!classesEl) return;
  if (!classes.length) {
    const empty = el("div", "classes-empty");
    empty.append(
      el("p", "classes-empty-title", "No class is on the board yet."),
      el("p", null, "When you send a suggestion, pick your grade and section. " +
        "Once your class has 3 approved suggestions, it shows up here."),
    );
    classesEl.replaceChildren(empty);
    return;
  }
  const [lead, ...rest] = classes;
  const stat = (n, label) => {
    const d = el("div", "lead-stat");
    d.append(el("span", "lead-n", String(n)), el("span", "lead-label mono", label));
    return d;
  };
  const leader = el("div", "class-lead");
  const name = el("div", "lead-name");
  name.append(el("span", "lead-place mono", "Leading"), el("span", "lead-class", `${lead.grade} ${lead.section}`));
  const stats = el("div", "lead-stats");
  stats.append(stat(lead.approved, "approved"), stat(lead.done, "done"), stat(lead.votes ?? 0, "votes"));
  leader.append(name, stats);

  const list = el("ol", "class-list");
  for (const c of rest) {
    const li = el("li", "class-row");
    li.append(
      el("span", "class-place mono", String(c.place)),
      el("span", "class-name", `${c.grade} ${c.section}`),
      el("span", "class-nums mono", `${plural(c.approved, "approved")} · ${c.done} done`),
    );
    list.append(li);
  }
  classesEl.replaceChildren(leader, ...(rest.length ? [list] : []));
}

watchSession(async (session) => {
  classes = [];
  if (!session) {
    // The popup asks first; if it was closed, one quiet line remains.
    const line = el("p", "signed-out-line");
    const button = el("button", "link-btn", "Sign in");
    button.type = "button";
    button.addEventListener("click", signIn);
    line.append(button, " with your school Google account to see the leaderboard.");
    classesEl.replaceChildren(line);
    return;
  }
  {
    showUpdates(session);
    const { data, error } = await sb.rpc("class_leaderboard");
    classes = error ? [] : data ?? [];
  }
  renderClasses();
}, { askToSignIn: true });
