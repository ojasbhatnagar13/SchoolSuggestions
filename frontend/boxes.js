// The two boxes on the home page: "Suggest a change" (submit.js) and
// "Speak Up" (speakup.js), shown one at a time under two tabs. Each box's
// AI check can tell when something was sent to the wrong one, and offers to
// move the student's text across.
import { el } from "./common.js";

// Who students can contact for help. Also in the note under the heading in
// index.html; tests/test_static.py checks the two match.
export const HELP = { name: "Meenakshi Sharma", email: "meenakshi.sharma@dpsiedge.edu.in" };

const $ = (id) => document.getElementById(id);
const grid = $("boxes");
const tabs = { suggest: $("tab-suggest"), speak: $("tab-speak") };

export function showBox(name, { focus = false } = {}) {
  const speak = name === "speak";
  grid.classList.toggle("is-speak", speak);
  tabs.suggest.setAttribute("aria-selected", String(!speak));
  tabs.speak.setAttribute("aria-selected", String(speak));
  tabs.suggest.tabIndex = speak ? -1 : 0;
  tabs.speak.tabIndex = speak ? 0 : -1;
  // So a reload, or the link back from Google sign-in, opens the same box.
  history.replaceState(null, "", speak ? "#speak-up" : location.pathname + location.search);
  if (focus) (speak ? $("report") : $("suggestion")).focus({ preventScroll: true });
}

export const currentBox = () => (grid.classList.contains("is-speak") ? "speak" : "suggest");

tabs.suggest.addEventListener("click", () => showBox("suggest"));
tabs.speak.addEventListener("click", () => showBox("speak"));
// Arrow keys move between the tabs, as in any tab list.
for (const tab of Object.values(tabs)) {
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = currentBox() === "speak" ? "suggest" : "speak";
    showBox(next);
    tabs[next].focus();
  });
}

// "Speak Up" links elsewhere on the page.
for (const link of document.querySelectorAll(".to-speak-up")) {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    showBox("speak", { focus: true });
    $("suggest").scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

if (location.hash === "#speak-up") showBox("speak");

// "This belongs in the other box": a popup with the reason, a button that
// moves the text across, and a way to stay. Nothing has been sent either way.
export function offerMove({ title, body, button, onMove }) {
  document.querySelector(".move-dialog")?.remove();
  const dialog = el("dialog", "clarify-dialog move-dialog");
  const move = el("button", "btn btn-primary", button);
  move.type = "button";
  const stay = el("button", "link-btn move-stay", "Keep it here and edit it");
  stay.type = "button";
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  move.addEventListener("click", () => {
    close();
    onMove();
  });
  stay.addEventListener("click", close);
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dialog.append(el("h3", null, title), ...body.map((t) => el("p", "clarify-note", t)), move, stay);
  document.body.append(dialog);
  dialog.showModal();
  move.focus();
}
