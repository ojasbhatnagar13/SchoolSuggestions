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
    notice: "Staff approved it. It's on the Vote page for everyone to vote on.",
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

// The news, as a boarding pass: where the suggestion is "flying to".
const PASS = {
  approved: { to: "The Vote page", gate: "Vote", link: ["vote.html", "Go to the Vote page →"] },
  going_ahead: { to: "Straight to action", gate: "Go", link: ["index.html#ahead-section", "See it →"] },
  done: { to: "Done", gate: "Arrived", link: ["index.html#done-section", "See it →"] },
  not_taken_forward: { to: "Not this time", gate: "Closed", link: null },
};

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function boardingPass(s, n, total) {
  const state = STATES[s.status];
  const pass = PASS[s.status];
  const card = el("article", `bp bp-${s.status}`);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", `News about your suggestion: ${state.label}`);

  const main = el("div", "bp-main");
  const top = el("div", "bp-top");
  top.append(el("span", "bp-brand", "DPSI Suggestions"), el("span", "bp-kind mono",
    total > 1 ? `Boarding pass ${n} of ${total}` : "Boarding pass"));

  const field = (label, value) => {
    const f = el("div", "bp-field");
    f.append(el("span", "bp-label mono", label), el("span", "bp-value", value));
    return f;
  };
  const fields = el("div", "bp-fields");
  fields.append(
    field("Passenger", "You"),
    field("Flight", `#${s.id}`),
    field("From", "Your suggestion"),
    field("To", pass.to),
  );

  const quote = el("p", "bp-quote", `“${s.suggestion}”`);
  const note = el("p", "bp-note", state.notice);
  if (s.reason) note.append(el("span", "bp-reason", ` Staff said: ${s.reason}`));

  const actions = el("div", "bp-actions");
  const ok = el("button", "btn btn-primary bp-ok", n < total ? "Next" : "Got it");
  ok.type = "button";
  actions.append(ok);
  let link = null;
  if (pass.link) {
    link = el("a", "bp-link", pass.link[1]);
    link.href = pass.link[0];
    actions.append(link);
  }
  // The stamp lives in the main part, in space kept free for it.
  main.append(top, fields, quote, note, actions, el("span", "bp-stamp", state.label));

  const stub = el("div", "bp-stub");
  stub.append(
    field("Gate", pass.gate),
    field("Status", state.label),
    el("div", "bp-barcode"),
  );

  card.append(main, stub);
  return { card, ok, link };
}

// When staff decide on a suggestion, its sender gets a boarding pass the
// next time they open the site: it flips up, gets stamped with what
// happened, and tears away when they've read it. One pass per update.
// Sign-in fires more than one session event, and a page can ask from more
// than one place, so only one check runs at a time and only one pass shows.
let checking = false;

export async function showUpdates(session, rows = null) {
  if (!session) {
    document.querySelector(".bp-backdrop")?.remove();
    return;
  }
  if (checking || document.querySelector(".bp-backdrop")) return;
  checking = true;
  try {
    rows = rows ?? await mySuggestions();
  } finally {
    checking = false;
  }
  const updates = (rows ?? []).filter((s) => s.unseen && STATES[s.status]?.notice);
  if (!updates.length || document.querySelector(".bp-backdrop")) return;

  const backdrop = el("div", "bp-backdrop");
  document.body.append(backdrop);
  let i = 0;
  let busy = false;

  const markSeen = () => sb.rpc("mark_my_suggestions_seen", { p_ids: updates.map((s) => s.id) });

  const finish = async () => {
    backdrop.classList.add("is-leaving");
    document.removeEventListener("keydown", onKey);
    await markSeen();
    setTimeout(() => backdrop.remove(), reduceMotion() ? 0 : 300);
  };

  const show = () => {
    const { card, ok, link } = boardingPass(updates[i], i + 1, updates.length);
    backdrop.replaceChildren(card);
    ok.focus({ preventScroll: true });
    ok.addEventListener("click", () => tear(card));
    // Going to see it counts as reading it: close the pass and go, so it
    // can't come back on the next page or stay over the section it links to.
    link?.addEventListener("click", async (e) => {
      e.preventDefault();
      document.removeEventListener("keydown", onKey);
      await markSeen();
      backdrop.remove();
      const to = new URL(link.href);
      if (to.pathname === location.pathname && to.hash) {
        document.querySelector(to.hash)?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" });
        history.replaceState(null, "", to.hash);
      } else {
        location.href = link.href;
      }
    });
  };

  const tear = (card) => {
    if (busy || !card) return;
    busy = true;
    const next = () => {
      busy = false;
      i++;
      if (i < updates.length) show();
      else finish();
    };
    if (reduceMotion()) return next();
    card.classList.add("is-torn");
    setTimeout(next, 650);
  };

  const onKey = (e) => {
    if (e.key === "Escape") tear(backdrop.querySelector(".bp"));
  };
  document.addEventListener("keydown", onKey);
  show();
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
