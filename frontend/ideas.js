// The home page: approved suggestions open for votes, then the ones going
// ahead without a vote, then the ones the school has acted on (Done).
// (The file keeps its old name, ideas.js, so cached pages don't break.)
import { sb, el, signIn, watchSession } from "./common.js";
import { showUpdates } from "./mine.js?v=2";

const list = document.getElementById("list");
const filterBar = document.getElementById("categories");
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

function render() {
  renderFilters();
  const shown = category === "all"
    ? suggestions
    : suggestions.filter((s) => (s.category || "Uncategorised") === category);

  // New ones first, so a returning student sees what they haven't voted on
  // yet. Otherwise the order from the database (newest first) is kept.
  const byNew = (a, b) => Number(isNew(b)) - Number(isNew(a));
  const open = shown.filter(isOpen).sort(byNew);
  const ahead = shown.filter(isAhead).sort(byNew);
  const done = shown.filter(isDone);

  const fresh = suggestions.filter(isNew).length;
  newNote.hidden = !fresh;
  newNote.textContent = `${plural(fresh, "new suggestion")} since your last visit`;

  list.replaceChildren(...(open.length ? open.map(card) : [boardState({
    title: category === "all"
      ? "Nothing open for votes right now."
      : `Nothing in ${category} is open for votes right now.`,
    body: "New suggestions appear here once staff approve them. " +
      "Anything already going ahead or done is listed below.",
  })]));

  aheadSection.hidden = !ahead.length;
  aheadList.replaceChildren(...ahead.map(card));

  doneSection.hidden = !done.length;
  doneList.replaceChildren(...done.map(card));
  doneCount.textContent = plural(done.length, "suggestion");
}

function hideBoard() {
  filterBar.hidden = true;
  aheadSection.hidden = true;
  doneSection.hidden = true;
  newNote.hidden = true;
}

function signedOut() {
  hideBoard();
  const button = el("button", "btn btn-primary", "Sign in with Google");
  button.type = "button";
  button.addEventListener("click", signIn);
  list.replaceChildren(boardState({
    title: "Sign in to see what everyone's suggested.",
    body: "The board stays inside the school instead of being shared around " +
      "online. The same sign-in lets you send suggestions of your own.",
    action: button,
    points: [
      "Suggestions approved by staff, newest first",
      "One vote per student per suggestion",
      "Vote counts stay private, so nothing snowballs",
    ],
  }));
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
    list.replaceChildren(boardState({
      title: "This account can't see the board.",
      body: blocked,
      action: button,
    }));
    return;
  }

  // News about the student's own suggestions, whatever the board holds.
  showUpdates(session);

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
    list.replaceChildren(boardState({
      title: "The board couldn't load.",
      body: listRes.error.message,
      isError: true,
    }));
    return;
  }

  suggestions = listRes.data ?? [];
  if (!suggestions.length) {
    hideBoard();
    const link = el("a", "btn btn-primary", "Send a suggestion →");
    link.href = "suggest.html";
    list.replaceChildren(boardState({
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
  // Only a visit that actually showed the list counts as a visit.
  rememberVisit();
}

watchSession(refresh);
