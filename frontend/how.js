// How it works: shows the guidelines staff have set, straight from the
// database, so the page never disagrees with what the AI is checking.
import { sb, el, watchSession } from "./common.js";
import { showReceiptUpdates } from "./receipts.js";

const cards = document.getElementById("rules-cards");

// One line under each card, by kind. Unknown kinds get no note.
const NOTES = {
  ok: "Good fits for a suggestion. These go straight to staff.",
  warn: "Welcome, but staff will look closely at cost and impact.",
  bad: "Turned down automatically, and you're told which guideline it broke.",
};

// The format staff are asked to write in: a heading line ending in ":",
// then "- " bullet lines. Anything else is kept as a plain line in the
// current section, so a slightly off format still shows something sensible.
function parse(text) {
  const sections = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*•]\s*/.test(line)) {
      if (!current) sections.push((current = { heading: "Guidelines", items: [] }));
      current.items.push(line.replace(/^[-*•]\s*/, ""));
    } else if (line.endsWith(":")) {
      sections.push((current = { heading: line.slice(0, -1), items: [] }));
    } else {
      if (!current) sections.push((current = { heading: "Guidelines", items: [] }));
      current.items.push(line);
    }
  }
  return sections.filter((s) => s.items.length);
}

function kindOf(heading) {
  const h = heading.toLowerCase();
  if (/\bnot\b|never|banned|prohibit/.test(h)) return "bad";
  if (/review|check|depends|case/.test(h)) return "warn";
  return "ok";
}

function card({ heading, items }) {
  const kind = kindOf(heading);
  const div = el("div", "rule-card");
  const head = el("div", "rule-head mono");
  const sq = el("span", `sq sq-${kind}`);
  sq.setAttribute("aria-hidden", "true");
  head.append(sq, heading);
  const ul = el("ul");
  items.forEach((item) => ul.append(el("li", null, item)));
  div.append(head, ul);
  if (NOTES[kind]) div.append(el("p", "rule-note", NOTES[kind]));
  return div;
}

async function loadRules() {
  // If this fails, the cards already in the page stay as they are.
  const { data, error } = await sb.rpc("public_rules");
  if (error || !data?.rules) return;
  const sections = parse(data.rules);
  if (!sections.length) return;
  cards.classList.add("rules-live");
  cards.replaceChildren(...sections.map(card));
}

loadRules();
showReceiptUpdates();
watchSession();
