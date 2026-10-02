// The Ideas page: approved suggestions, with one vote each.
import { sb, el, signIn, watchSession } from "./common.js";

const list = document.getElementById("list");
const filterBar = document.getElementById("categories");

// Suggestion ids the signed-in student has already voted for, so the UI can
// disable those buttons instead of waiting for the database to reject a
// duplicate.
let myVotes = new Set();
let ideas = [];
let category = "all";

function card({ id, suggestion, benefit, category, summary, created_at }) {
  const article = el("article", "s-card");

  const meta = el("div", "s-meta");
  meta.append(
    el("span", "s-cat", category || "Uncategorised"),
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
  btn.setAttribute("aria-label", voted ? "Remove your vote" : "Vote for this idea");
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
  ideas.forEach((i) => {
    const c = i.category || "Uncategorised";
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
    chip("all", "All", ideas.length),
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([c, n]) => chip(c, c, n)),
  );
}

function render() {
  renderFilters();
  const shown = category === "all"
    ? ideas
    : ideas.filter((i) => (i.category || "Uncategorised") === category);
  list.replaceChildren(...shown.map(card));
}

function signedOut() {
  filterBar.hidden = true;
  const button = el("button", "btn btn-primary", "Sign in with Google");
  button.type = "button";
  button.addEventListener("click", signIn);
  list.replaceChildren(boardState({
    title: "Sign in to see what everyone's suggested.",
    body: "The board stays inside the school instead of being shared around " +
      "online. The same sign-in lets you send ideas of your own.",
    action: button,
    points: [
      "Ideas approved by staff, newest first",
      "One vote per student per idea",
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
    filterBar.hidden = true;
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

  const [votesRes, listRes] = await Promise.all([
    sb.rpc("my_votes"),
    // Newest first, always. Ordering by popularity is the bandwagon
    // mechanism, and the vote count is not sent to students anyway.
    sb.from("public_suggestions").select("*").order("created_at", { ascending: false }),
  ]);

  myVotes = new Set(votesRes.error ? [] : votesRes.data ?? []);

  if (listRes.error) {
    filterBar.hidden = true;
    list.replaceChildren(boardState({
      title: "The board couldn't load.",
      body: listRes.error.message,
      isError: true,
    }));
    return;
  }

  ideas = listRes.data ?? [];
  if (!ideas.length) {
    filterBar.hidden = true;
    const link = el("a", "btn btn-primary", "Send an idea →");
    link.href = "index.html";
    list.replaceChildren(boardState({
      title: "Nothing approved yet.",
      body: "Ideas appear here once a member of staff has read and approved " +
        "them. Yours could be the first.",
      action: link,
      points: [
        "Sent ideas wait for staff review",
        "Approved ones appear here, newest first",
      ],
    }));
    return;
  }

  render();
}

watchSession(refresh);
