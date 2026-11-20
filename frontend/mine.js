// "Your suggestions": what happened to the signed-in student's own
// suggestions, and a notice at the top of the site when one changes.
//
// Suggestions are saved with the sender's account so this works on any
// device. Staff never see that link: the database only answers these
// questions for the signed-in student's own suggestions
// (docs/setup-my-suggestions.sql).
import { sb, el } from "./common.js";

// How each state is described to the student. "waiting" never triggers a
// notice -- it is what they were told when they sent it.
export const STATES = {
  waiting: {
    label: "Waiting for staff",
    notice: null,
  },
  approved: {
    label: "Open for votes",
    notice: "Staff approved it. It's on the home page for everyone to vote on.",
  },
  going_ahead: {
    label: "Going ahead",
    notice: "Staff approved it with no vote needed. The school is going ahead with it.",
  },
  done: {
    label: "Done",
    notice: "The school has acted on it. Thank you for suggesting it.",
  },
  not_taken_forward: {
    label: "Not taken forward",
    notice: "Staff read it and decided not to take it forward this time.",
  },
};

export async function mySuggestions() {
  const { data, error } = await sb.rpc("my_suggestions");
  return error ? null : data ?? [];
}

// A notice inside the sticky nav, so it stays on screen while scrolling
// until the student dismisses it.
export async function showUpdates(session, rows = null) {
  document.querySelector(".updates")?.remove();
  if (!session) return;

  rows = rows ?? await mySuggestions();
  const updates = (rows ?? []).filter((s) => s.unseen && STATES[s.status]?.notice);
  if (!updates.length) return;

  const banner = el("section", "updates");
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-label", "News about your suggestions");
  const wrap = el("div", "wrap updates-inner");

  const head = el("div", "updates-head");
  const ok = el("button", "btn btn-ghost updates-dismiss", "Got it");
  ok.type = "button";
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    await sb.rpc("mark_my_suggestions_seen", { p_ids: updates.map((s) => s.id) });
    banner.remove();
  });
  head.append(
    el("p", "eyebrow", updates.length === 1
      ? "News about your suggestion"
      : "News about your suggestions"),
    ok,
  );

  const items = el("div", "update-list");
  for (const s of updates) {
    const state = STATES[s.status];
    const item = el("div", `update update-${s.status}`);
    const text = el("div");
    text.append(
      el("span", "update-title", state.label),
      el("p", "update-text", `“${s.suggestion}”`),
      el("p", "update-body", state.notice),
    );
    item.append(text);
    if (["approved", "going_ahead", "done"].includes(s.status)
        && !/\/(index\.html)?$/.test(location.pathname)) {
      const a = el("a", "update-link", "See it →");
      a.href = "index.html";
      item.append(a);
    }
    items.append(item);
  }

  wrap.append(head, items);
  banner.append(wrap);
  const nav = document.querySelector(".nav");
  if (nav) nav.append(banner);
  else document.body.prepend(banner);
}

// The list on the My suggestions page. Anything updated since the student
// last looked is marked "Updated"; the page then marks it seen.
export function renderMine(list, rows) {
  list.replaceChildren(...rows.map((s) => {
    const row = el("li", `mine-row mine-${s.status}` + (s.unseen && s.status !== "waiting" ? " is-updated" : ""));
    const state = el("span", "mine-state", STATES[s.status]?.label ?? s.status);
    const text = el("div", "mine-main");
    text.append(el("p", "mine-text", s.suggestion));
    if (s.reason) {
      const why = el("p", "mine-reason");
      why.append(el("span", "mono", "Why"), el("span", null, s.reason));
      text.append(why);
    }
    const side = el("div", "mine-side");
    if (s.unseen && s.status !== "waiting") side.append(el("span", "new-badge", "Updated"));
    side.append(el("span", "mono mine-date", new Date(s.created_at).toLocaleDateString(undefined, {
      day: "numeric", month: "short",
    })));
    row.append(state, text, side);
    return row;
  }));
}
