// The My suggestions page: where each of the student's own suggestions
// stands, with any reason staff gave. Only ever their own -- the database
// answers for the signed-in account only (docs/setup-my-suggestions.sql).
import { sb, el, signIn, watchSession } from "./common.js";
import { mySuggestions, renderMine } from "./mine.js?v=4";

const list = document.getElementById("mine-list");
const empty = document.getElementById("mine-empty");
const summary = document.getElementById("mine-summary");

function emptyState(title, body, action) {
  const box = el("div", "board-state");
  const left = el("div");
  left.append(el("h3", null, title), el("p", null, body));
  if (action) left.append(action);
  box.append(left);
  empty.replaceChildren(box);
  empty.hidden = false;
  list.hidden = true;
  summary.textContent = "";
}

watchSession(async (session) => {
  if (!session) {
    const button = el("button", "btn btn-primary", "Sign in with Google");
    button.type = "button";
    button.addEventListener("click", signIn);
    return emptyState("Sign in to see your suggestions.",
      "This list is private: only you can see it, and only when you're signed in.", button);
  }

  const rows = await mySuggestions();
  if (rows === null) {
    return emptyState("Your suggestions couldn't load.", "Please try again in a minute.");
  }
  if (!rows.length) {
    const link = el("a", "btn btn-primary", "Make a suggestion →");
    link.href = "index.html";
    return emptyState("Nothing here yet.",
      "When you send a suggestion, it appears here so you can see what happens to it.", link);
  }

  const counts = rows.reduce((c, s) => ((c[s.status] = (c[s.status] || 0) + 1), c), {});
  const parts = [`${rows.length} sent`];
  if (counts.waiting) parts.push(`${counts.waiting} waiting`);
  if (counts.approved) parts.push(`${counts.approved} open for votes`);
  if (counts.going_ahead) parts.push(`${counts.going_ahead} going ahead`);
  if (counts.done) parts.push(`${counts.done} done`);
  summary.textContent = parts.join(" · ");

  empty.hidden = true;
  list.hidden = false;
  renderMine(list, rows);

  // They are looking at it now, so any news counts as seen: the notice at
  // the top of the site won't repeat it.
  const updated = rows.filter((s) => s.unseen && s.status !== "waiting").map((s) => s.id);
  if (updated.length) await sb.rpc("mark_my_suggestions_seen", { p_ids: updated });
}, { askToSignIn: true });
