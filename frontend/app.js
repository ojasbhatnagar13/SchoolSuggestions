import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, MODERATE_URL } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Must match maxlength in index.html and MAX_LENGTH in the Edge Function.
const MAX_LENGTH = 2000;

// A random per-browser id used only for submission rate limiting. It is not
// an identity: it is never tied to a suggestion, the server only ever sees a
// salted hash of it, and clearing site data resets it. That last part means
// it stops casual repeat-spam, not a determined attacker -- the per-network
// limit in the Edge Function is what backstops that.
function deviceToken() {
  const KEY = "suggestion-device-token";
  let token = null;
  try {
    token = localStorage.getItem(KEY);
    if (!token) {
      token = crypto.randomUUID();
      localStorage.setItem(KEY, token);
    }
  } catch {
    // Private browsing or blocked storage. Fall back to a per-session value;
    // the request still works, it just shares the network bucket.
    token = "";
  }
  return token;
}

const $ = (id) => document.getElementById(id);
const els = {
  form: $("submit-form"), text: $("suggestion"), send: $("send"),
  sendLabel: document.querySelector("#send .btn-label"),
  counter: $("counter"), result: $("result"), list: $("list"),
  who: $("who"), signin: $("signin"), signout: $("signout"),
};

// Suggestion ids the signed-in student has already voted for, so the UI can
// disable those buttons instead of waiting for the database to reject a
// duplicate.
let myVotes = new Set();
let session = null;

function notice(message, kind = "info") {
  els.result.textContent = message;
  els.result.className = `notice ${kind}`;
  els.result.hidden = false;
}

// Small DOM helper. Every string goes through textContent, never innerHTML --
// suggestion text is student-supplied and must never be parsed as markup.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function card({ id, suggestion, category, summary, created_at }) {
  const article = el("article", "s-card");

  const meta = el("div", "s-meta");
  meta.append(
    el("span", "s-cat", category || "Uncategorised"),
    el("span", "mono s-date", new Date(created_at).toLocaleDateString(undefined, {
      day: "numeric", month: "short", year: "numeric",
    })),
  );

  const body = el("p", "s-text", suggestion);

  const foot = el("div", "s-foot");
  const btn = el("button", "vote");
  btn.type = "button";

  // No running tally is shown. A visible count makes an already-popular
  // suggestion collect more votes because it looks popular, rather than
  // because more people independently agree. Staff still see the numbers.
  if (myVotes.has(id)) {
    btn.textContent = "Voted";
    btn.disabled = true;
    btn.classList.add("voted");
  } else {
    btn.textContent = "Vote";
    btn.addEventListener("click", () => vote(id, btn));
  }
  foot.append(el("span", "mono", "One vote each"), btn);

  article.append(meta, body);
  if (summary && summary !== suggestion) article.append(el("p", "s-summary", summary));
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

function signIn() {
  return sb.auth.signInWithOAuth({
    provider: "google",
    // No #fragment on the return URL: Supabase can hand the session back in the
    // hash, and an existing fragment would collide with it.
    options: { redirectTo: window.location.href.split("#")[0] },
  });
}

async function vote(id, btn) {
  btn.disabled = true;
  const { error } = await sb.rpc("vote_for_suggestion", { p_id: id });
  if (error) {
    // The database owns these rules, so just surface what it said -- on the
    // card that was clicked, not in the form notice at the top of the page.
    const status = btn.parentElement.querySelector(".mono");
    status.textContent = error.message;
    status.classList.add("vote-error");
    btn.disabled = false;
    return;
  }
  myVotes.add(id);
  btn.textContent = "Voted";
  btn.disabled = true;
  btn.classList.add("voted");
}

async function refresh() {
  // The list is for signed-in school accounts only, so it cannot be browsed
  // or forwarded by anyone with the link. Submitting stays anonymous.
  if (!session) {
    const button = el("button", "btn btn-ghost", "Sign in with Google");
    button.type = "button";
    button.addEventListener("click", signIn);
    els.list.replaceChildren(boardState({
      title: "The board is visible to signed-in students.",
      body: "It keeps the list inside the school instead of being shared " +
        "around online. You don't need an account to submit a suggestion.",
      action: button,
      points: [
        "Ideas approved by staff, newest first",
        "One vote per student per idea",
        "Vote counts stay private, so nothing snowballs",
      ],
    }));
    return;
  }

  // Newest first, always. Ordering by popularity is the bandwagon mechanism,
  // and the vote count is no longer sent to students anyway.
  const { data, error } = await sb
    .from("public_suggestions")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    els.list.replaceChildren(boardState({
      title: "The board couldn't load.",
      body: error.message,
      isError: true,
    }));
    return;
  }
  if (!data.length) {
    const link = el("a", "btn btn-primary", "Make a suggestion →");
    link.href = "#suggest";
    els.list.replaceChildren(boardState({
      title: "Nothing approved yet.",
      body: "Ideas appear here once a member of staff has read and approved " +
        "them. Yours could be the first.",
      action: link,
      points: [
        "Submitted ideas wait for staff review",
        "Approved ones appear here, newest first",
      ],
    }));
    return;
  }
  els.list.replaceChildren(...data.map(card));
}

async function loadMyVotes() {
  myVotes = new Set();
  if (!session) return;
  const { data, error } = await sb.rpc("my_votes");
  if (!error && data) myVotes = new Set(data);
}

async function onAuthChange(newSession) {
  session = newSession;
  const email = session?.user?.email;
  els.who.textContent = email || "";
  els.who.hidden = !email;
  els.signin.hidden = !!session;
  els.signout.hidden = !session;
  await loadMyVotes();
  await refresh();
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const suggestion = els.text.value.trim();
  if (!suggestion) return;

  els.send.disabled = true;
  els.sendLabel.textContent = "Checking…";
  notice("Checking your suggestion against the school guidelines. This usually takes a few seconds.");

  try {
    const res = await fetch(MODERATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ suggestion, deviceToken: deviceToken() }),
    });
    const payload = await res.json();

    if (res.status === 429) {
      // Rate limited. The database writes this wording, so show it as-is and
      // treat it as a warning rather than an error -- nothing broke.
      notice(payload.error, "warn");
      return;
    }
    if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);

    // Nothing appears publicly until staff approve it, so say so either way --
    // otherwise a student submits, sees no new entry in the list, and assumes
    // it failed.
    if (payload.status === "duplicate") {
      // Nothing was written. Show the existing suggestion so this reads as
      // "already covered" rather than "rejected".
      notice(
        `Someone has already suggested this, so it wasn't filed twice. ` +
        `The original (#${payload.duplicate_of}): “${payload.existing}”`,
        "warn",
      );
      return;
    }

    if (payload.unchecked) {
      // Every AI model was busy. The suggestion was still saved -- it goes
      // straight to a person instead of being screened first.
      notice(
        `Submitted as #${payload.id}. The automatic check is busy right now, ` +
        `so a member of staff will review it directly.`,
        "ok",
      );
    } else if (payload.status === "rejected") {
      notice(
        `This doesn’t fit the school suggestion rules, so it wasn’t added. ` +
        (payload.reason ? `Reason: ${payload.reason} ` : "") +
        `If you think that’s wrong, reword it or speak to a teacher.`,
        "warn",
      );
    } else {
      notice(
        `Submitted as #${payload.id} under “${payload.category}”. ` +
        `It will appear on the board once staff have approved it.`,
        "ok",
      );
    }
    els.text.value = "";
    updateCounter();
    await refresh();
  } catch (err) {
    // fetch() rejects with a bare TypeError for DNS failures, CORS blocks and
    // a function that was never deployed -- "Failed to fetch" means nothing to
    // a student, so say something actionable instead.
    notice(
      err instanceof TypeError
        ? "Couldn't reach the suggestion service. Check your internet " +
          "connection and try again. Your text is still in the box."
        : err.message,
      "error",
    );
  } finally {
    els.send.disabled = false;
    els.sendLabel.textContent = "Submit suggestion";
  }
});

// Counts down, so the number people watch is the one that matters: how much
// room is left. Only turns warning-coloured near the limit.
function updateCounter() {
  const left = MAX_LENGTH - els.text.value.length;
  els.counter.textContent =
    left === 1 ? "1 character left" : `${left} characters left`;
  els.counter.classList.toggle("low", left <= 100);
}

els.text.addEventListener("input", updateCounter);

els.signin.addEventListener("click", signIn);

els.signout.addEventListener("click", async () => {
  await sb.auth.signOut();
});

updateCounter();

sb.auth.onAuthStateChange((_event, newSession) => onAuthChange(newSession));
const { data: { session: initial } } = await sb.auth.getSession();
await onAuthChange(initial);
