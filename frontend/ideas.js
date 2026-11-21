// Two pages share this file (old name kept so cached pages don't break):
//   vote.html  -- only the suggestions open for votes, nothing else
//   index.html -- home: under the suggestion form (submit.js), a reel of
//                 suggestions on the board, then what is going ahead and Done
import { sb, el, signIn, watchSession } from "./common.js";
import { showUpdates } from "./mine.js?v=3";
import { searchTerms, fuzzyScore } from "./fuzzy.js?v=1";

const list = document.getElementById("list"); // vote page only
const reel = document.getElementById("reel"); // home page only
const reelBlock = document.getElementById("reel-block");
const reelLabel = document.getElementById("reel-label");

// Shown in the reel until real suggestions are approved (or when signed
// out), clearly labelled as examples. Remove once the board fills up.
const SAMPLES = [
  ["approved", "More benches near the basketball court for break time", "Sports"],
  ["accepted", "Water coolers on every floor, not just the ground floor", "Facilities"],
  ["approved", "Healthier snack options in the canteen, like fruit and sandwiches", "Food"],
  ["actioned", "Keep the library open during lunch break", "Library"],
  ["approved", "A music room students can book after school", "Clubs"],
  ["approved", "Shade over the bus waiting area for hot afternoons", "Transport"],
  ["accepted", "Lockers for senior students to keep heavy books", "Facilities"],
  ["approved", "A monthly inter-house quiz during assembly", "Events"],
].map(([status, suggestion, category]) => ({ status, suggestion, category, example: true }));
const filterBar = document.getElementById("categories");
const searchWrap = document.getElementById("search-wrap"); // vote page only
const searchBox = document.getElementById("search");
let query = "";
let terms = [];
let entered = false; // cards animate in only on the first render
const entering = (list) => {
  if (entered) return list;
  list.forEach((c, i) => {
    c.classList.add("enter");
    c.style.setProperty("--i", String(Math.min(i, 8)));
    // Once in, drop the animation so hover can lift the card.
    c.addEventListener("animationend", () => c.classList.remove("enter"), { once: true });
  });
  return list;
};
searchBox?.addEventListener("input", () => {
  query = searchBox.value.trim();
  terms = searchTerms(query);
  render();
});
const aheadSection = document.getElementById("ahead-section");
const aheadList = document.getElementById("ahead-list");
const doneSection = document.getElementById("done-section");
const doneList = document.getElementById("done-list");
const doneCount = document.getElementById("done-count");
const newNote = document.getElementById("new-note");

// Statuses in the database, and what students call them:
//   approved -> open for votes
//   accepted -> "Going ahead": staff decided it needs no vote
//   actioned -> "Done"
const isOpen = (s) => s.status === "approved";
const isAhead = (s) => s.status === "accepted";
const isDone = (s) => s.status === "actioned";

// "New since your last visit". The last visit is remembered only in this
// browser -- nothing about visits is sent anywhere. Read once per page load,
// so labels stay put while the student is here; the next visit starts fresh.
const VISIT_KEY = "ideas-last-visit"; // old name kept so past visits still count
const lastVisit = (() => {
  try {
    const saved = localStorage.getItem(VISIT_KEY);
    return saved ? new Date(saved) : null;
  } catch {
    return null;
  }
})();

function rememberVisit() {
  try {
    localStorage.setItem(VISIT_KEY, new Date().toISOString());
  } catch { /* a convenience only */ }
}

// On a first visit nothing is "new" -- everything would be, which says nothing.
const isNew = (s) =>
  lastVisit !== null && !isDone(s) && s.decided_at && new Date(s.decided_at) > lastVisit;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Suggestion ids the signed-in student has already voted for, so the UI can
// show "Voted" without waiting for the database to reject a duplicate.
let myVotes = new Set();
let suggestions = [];
let category = "all";

function card(s) {
  const { id, suggestion, benefit, category, summary, created_at } = s;
  const article = el("article", "s-card");

  const meta = el("div", "s-meta");
  const left = el("span", "s-meta-left");
  if (isDone(s)) {
    left.append(el("span", "done-badge", "Done"));
    article.classList.add("is-done");
  }
  if (isAhead(s)) {
    left.append(el("span", "ahead-badge", "Going ahead"));
    article.classList.add("is-ahead");
  }
  if (isNew(s)) {
    left.append(el("span", "new-badge", "New"));
    article.classList.add("is-new");
  }
  left.append(el("span", "s-cat", category || "Uncategorised"));
  meta.append(
    left,
    el("span", "mono s-date", new Date(created_at).toLocaleDateString(undefined, {
      day: "numeric", month: "short", year: "numeric",
    })),
  );

  article.append(meta, el("p", "s-text", suggestion));

  if (benefit) {
    const why = el("p", "s-why");
    why.append(el("span", "mono", "Why it helps"), el("span", null, benefit));
    article.append(why);
  } else if (summary && summary !== suggestion) {
    article.append(el("p", "s-summary", summary));
  }

  const foot = el("div", "s-foot");

  // Going ahead and Done take no new votes (the database refuses them), but a
  // student who voted before staff decided can still take that vote back.
  if (!isOpen(s)) {
    const voted = myVotes.has(id);
    const line = voted
      ? "You voted for this"
      : isDone(s) ? "The school acted on this" : "No vote needed: the school is going ahead";
    foot.append(el("span", "mono", line));
    if (voted) {
      const btn = el("button", "vote");
      btn.type = "button";
      showVote(btn, true);
      btn.addEventListener("click", async () => {
        await toggleVote(id, btn);
        if (!myVotes.has(id)) btn.remove();
      });
      foot.append(btn);
    }
    article.append(foot);
    return article;
  }

  const btn = el("button", "vote");
  btn.type = "button";

  // No running tally is shown. A visible count makes an already-popular
  // suggestion collect more votes because it looks popular, rather than
  // because more people independently agree. Staff still see the numbers.
  showVote(btn, myVotes.has(id));
  btn.addEventListener("click", () => toggleVote(id, btn));
  foot.append(el("span", "mono", "One vote each"), btn);

  article.append(foot);
  return article;
}

// A full-width panel for the signed-out, empty and error states, so the board
// never collapses to a stray line of text with a hole underneath it.
function boardState({ title, body, points = [], action = null, isError = false }) {
  const panel = el("div", "board-state" + (isError ? " is-error" : ""));

  const left = el("div");
  left.append(el("h3", null, title), el("p", null, body));
  if (action) left.append(action);

  const right = el("ul", "spec");
  points.forEach((point) => right.append(el("li", null, point)));

  panel.append(left);
  if (points.length) panel.append(right);
  return panel;
}

// The button is a toggle: "Vote" adds one, "Voted" takes it back. The label
// switches to "Remove vote" on hover/focus (via CSS) so it's clear a second
// click undoes it.
function showVote(btn, voted) {
  btn.textContent = voted ? "Voted" : "Vote";
  btn.classList.toggle("voted", voted);
  btn.setAttribute("aria-pressed", String(voted));
  btn.setAttribute("aria-label", voted ? "Remove your vote" : "Vote for this suggestion");
}

async function toggleVote(id, btn) {
  const voted = myVotes.has(id);
  const status = btn.parentElement.querySelector(".mono");
  btn.disabled = true;

  const { error } = await sb.rpc(voted ? "unvote_suggestion" : "vote_for_suggestion", { p_id: id });
  btn.disabled = false;

  if (error) {
    // The database owns these rules, so just surface what it said, on the
    // card that was clicked.
    status.textContent = error.message;
    status.classList.add("vote-error");
    return;
  }

  voted ? myVotes.delete(id) : myVotes.add(id);
  status.textContent = voted ? "Vote removed" : "One vote each";
  status.classList.remove("vote-error");
  showVote(btn, !voted);
  burst(btn, !voted);
}

// A pop and a burst of sparks when a vote lands; the sparks fly back in when
// it is taken back. Fixed to the screen, so no card can clip them.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SPARK_COLOURS = ["var(--accent)", "var(--warn)", "var(--text-d)", "var(--accent)"];

function burst(btn, adding) {
  btn.classList.remove("pop", "unpop");
  void btn.offsetWidth; // restart the pop if clicked twice quickly
  btn.classList.add(adding ? "pop" : "unpop");
  if (reduceMotion) return;

  const r = btn.getBoundingClientRect();
  const layer = el("div", "spark-layer");
  layer.style.left = `${r.left + r.width / 2}px`;
  layer.style.top = `${r.top + r.height / 2}px`;
  layer.setAttribute("aria-hidden", "true");
  if (adding) layer.append(el("span", "spark-ring"));
  const n = 14;
  for (let i = 0; i < n; i++) {
    const s = el("span", "spark" + (adding ? "" : " in"));
    s.style.setProperty("--a", `${(360 / n) * i + Math.random() * 14}deg`);
    s.style.setProperty("--d", `${36 + Math.random() * 30}px`);
    s.style.background = SPARK_COLOURS[i % SPARK_COLOURS.length];
    layer.append(s);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 800);
}

function renderFilters() {
  const counts = new Map();
  suggestions.forEach((s) => {
    const c = s.category || "Uncategorised";
    counts.set(c, (counts.get(c) || 0) + 1);
  });

  // One category is not a choice worth offering.
  filterBar.hidden = counts.size < 2;
  if (filterBar.hidden) return;

  const chip = (value, label, n) => {
    const b = el("button", "chip" + (category === value ? " is-on" : ""));
    b.type = "button";
    b.append(label + " ", el("span", "n", String(n)));
    b.addEventListener("click", () => {
      category = value;
      render();
    });
    return b;
  };

  filterBar.replaceChildren(
    chip("all", "All", suggestions.length),
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([c, n]) => chip(c, c, n)),
  );
}

// New ones first, so a returning student sees what they haven't voted on
// yet. Otherwise the order from the database (newest first) is kept.
const byNew = (a, b) => Number(isNew(b)) - Number(isNew(a));

function render() {
  if (list) renderVote();
  else renderHome();
}

function renderVote() {
  renderFilters();
  searchWrap.hidden = suggestions.length < 2;
  // Forgiving of spelling mistakes; the closest matches come first.
  const score = new Map(suggestions.map((s) => [s, fuzzyScore(terms, [s.suggestion, s.benefit, s.summary, s.category])]));
  const shown = (category === "all"
    ? suggestions
    : suggestions.filter((s) => (s.category || "Uncategorised") === category)).filter((s) => score.get(s) > 0);
  const open = shown.filter(isOpen).sort((a, b) => (query ? score.get(b) - score.get(a) : 0) || byNew(a, b));

  const fresh = suggestions.filter(isNew).length;
  newNote.hidden = !fresh;
  newNote.textContent = `${plural(fresh, "new suggestion")} since your last visit`;

  list.replaceChildren(...(open.length ? entering(open.map(card)) : [query ? boardState({
    title: `Nothing matches “${searchBox.value.trim()}”.`,
    body: "Try a different word, or clear the search to see everything.",
  }) : boardState({
    title: category === "all"
      ? "Nothing open for votes right now."
      : `Nothing in ${category} is open for votes right now.`,
    body: "New suggestions appear here once staff approve them. " +
      "Ones going ahead or already done are on the Home page.",
  })]));
}

// The reel on the home page: suggestions on the board drifting past. Newest
// first, never by votes (counts stay private so nothing snowballs).
function reelCard(s) {
  const state = isDone(s) ? "Done" : isAhead(s) ? "Going ahead" : "Open for votes";
  const c = el("article", "reel-card" + (isDone(s) ? " is-done" : isAhead(s) ? " is-ahead" : "") +
    (s.example ? " is-example" : ""));
  c.append(
    el("span", "reel-state mono", s.example ? `Example · ${state}` : state),
    el("p", "reel-text", s.summary || s.suggestion),
  );
  // Vote straight from the reel. Only open ones take votes; examples show a
  // button that does nothing, so the card looks like the real thing.
  const foot = el("div", "reel-foot");
  const status = el("span", "mono reel-cat", s.category || "Uncategorised");
  foot.append(status);
  if (isOpen(s)) {
    const btn = el("button", "vote");
    btn.type = "button";
    if (s.example) {
      btn.textContent = "Vote";
      btn.disabled = true;
      btn.title = "This is only an example";
    } else {
      btn.dataset.id = String(s.id);
      showVote(btn, myVotes.has(s.id));
      btn.addEventListener("click", async () => {
        const before = myVotes.has(s.id);
        await toggleVote(s.id, btn);
        if (myVotes.has(s.id) === before) return; // failed: the error stays on the card
        status.textContent = s.category || "Uncategorised";
        // The reel shows each card twice to loop; keep both copies in step.
        reel.querySelectorAll(`.vote[data-id="${s.id}"]`).forEach((b) => {
          if (b !== btn) showVote(b, myVotes.has(s.id));
        });
      });
    }
    foot.append(btn);
  }
  c.append(foot);
  return c;
}

function renderReel(real = suggestions) {
  let items = [
    ...real.filter(isOpen).slice(0, 10),
    ...real.filter(isAhead).slice(0, 4),
    ...real.filter(isDone).slice(0, 6),
  ];
  // Until the board has enough of its own, examples (marked as such) fill
  // the reel up to eight, so it always has something to roll.
  const hasReal = items.length > 0;
  items = [...items, ...SAMPLES.slice(0, Math.max(0, 8 - items.length))];
  reelLabel.textContent = hasReal ? "On the board" : "Examples of suggestions";
  const cards = items.map(reelCard);
  // Enough for a loop: the set is repeated once, and the copy is hidden from
  // screen readers. Too few to loop just sit still.
  const moving = items.length >= 3 && !reduceMotion;
  if (moving) {
    const copy = items.map(reelCard);
    copy.forEach((c) => c.setAttribute("aria-hidden", "true"));
    cards.push(...copy);
  }
  reel.classList.toggle("is-moving", moving);
  reel.style.setProperty("--reel-time", `${items.length * 4}s`);
  reel.replaceChildren(...cards);
}

function renderHome() {
  renderReel();

  const ahead = suggestions.filter(isAhead).sort(byNew);
  aheadSection.hidden = !ahead.length;
  aheadList.replaceChildren(...ahead.map(card));

  const done = suggestions.filter(isDone);
  doneSection.hidden = !done.length;
  doneList.replaceChildren(...done.map(card));
  doneCount.textContent = plural(done.length, "suggestion");
}

function hideBoard() {
  if (reelBlock) renderReel([]);
  if (filterBar) filterBar.hidden = true;
  if (searchWrap) searchWrap.hidden = true;
  if (newNote) newNote.hidden = true;
  if (aheadSection) aheadSection.hidden = true;
  if (doneSection) doneSection.hidden = true;
}

// Messages go in the list on the vote page. The home page has the form for
// those (submit.js), so there the board's sections simply stay hidden.
function showState(panel) {
  list?.replaceChildren(panel);
}

// Signed out, the sign-in popup (common.js) does the asking. If it was
// closed, the vote page keeps one quiet line with a way back in.
function signedOut() {
  hideBoard();
  if (!list) return;
  const line = el("p", "signed-out-line");
  const button = el("button", "link-btn", "Sign in");
  button.type = "button";
  button.addEventListener("click", signIn);
  line.append(button, " with your school Google account to see and vote on suggestions.");
  list.replaceChildren(line);
}

async function refresh(session) {
  // The list is for signed-in school accounts only, so it cannot be browsed
  // or forwarded by anyone with the link.
  if (!session) return signedOut();

  // Ask the database whether this account may see the board, so a personal
  // account gets told why the board is empty instead of "nothing approved".
  // If the function is not installed yet, carry on to the list.
  const { data: blocked, error: accessError } = await sb.rpc("board_access_error");
  if (!accessError && blocked) {
    hideBoard();
    const button = el("button", "btn btn-ghost", "Sign out");
    button.type = "button";
    button.addEventListener("click", () => sb.auth.signOut());
    showState(boardState({
      title: "This account can't see the board.",
      body: blocked,
      action: button,
    }));
    return;
  }

  // News about the student's own suggestions, whatever the board holds. On
  // the home page the form's script already does this.
  if (list) showUpdates(session);

  const [votesRes, listRes] = await Promise.all([
    sb.rpc("my_votes"),
    // Newest first, always. Ordering by popularity is the bandwagon
    // mechanism, and the vote count is not sent to students anyway.
    sb.from("public_suggestions").select("*").order("created_at", { ascending: false })
      // Times are rounded to the hour, so the id breaks ties within one.
      .order("id", { ascending: false }),
  ]);

  myVotes = new Set(votesRes.error ? [] : votesRes.data ?? []);

  if (listRes.error) {
    hideBoard();
    showState(boardState({
      title: "The board couldn't load.",
      body: listRes.error.message,
      isError: true,
    }));
    return;
  }

  suggestions = listRes.data ?? [];
  if (!list) {
    // Home: only the reel and the lists change. Not counted as a visit, or
    // the vote page would lose its "New" labels.
    render();
    return;
  }
  // The vote page shows only what can be voted on; filters count only those.
  suggestions = suggestions.filter(isOpen);
  if (!suggestions.length) {
    hideBoard();
    const link = el("a", "btn btn-primary", "Send a suggestion →");
    link.href = "suggest.html";
    showState(boardState({
      title: "Nothing approved yet.",
      body: "Suggestions appear here once a member of staff has read and " +
        "approved them. Yours could be the first.",
      action: link,
      points: [
        "Sent suggestions wait for staff review",
        "Approved ones appear here, newest first",
        "Some go ahead straight away, with no vote needed",
        "Ones the school acts on are marked Done",
      ],
    }));
    return;
  }

  render();
  entered = true;
  // Only a visit that actually showed the list counts as a visit.
  rememberVisit();
}

watchSession(refresh, { askToSignIn: true });
