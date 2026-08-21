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
  counter: $("counter"), result: $("result"), list: $("list"), sort: $("sort"),
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

// Suggestion text is student-supplied, so it is only ever assigned via
// textContent -- never innerHTML.
function card({ id, suggestion, category, summary, votes, created_at }) {
  const el = document.createElement("article");
  el.className = "card suggestion";

  const head = document.createElement("div");
  head.className = "row";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = category || "Uncategorised";
  const when = document.createElement("span");
  when.className = "hint";
  when.textContent = new Date(created_at).toLocaleDateString();
  head.append(tag, when);

  const body = document.createElement("p");
  body.textContent = suggestion;

  const gist = document.createElement("p");
  gist.className = "hint";
  gist.textContent = summary || "";

  const foot = document.createElement("div");
  foot.className = "row";
  const btn = document.createElement("button");
  btn.className = "vote";
  const count = votes ?? 0;

  if (!session) {
    btn.textContent = `▲ ${count}`;
    btn.disabled = true;
    btn.title = "Sign in to vote";
  } else if (myVotes.has(id)) {
    btn.textContent = `▲ ${count} · voted`;
    btn.disabled = true;
    btn.classList.add("voted");
  } else {
    btn.textContent = `▲ ${count}`;
    btn.addEventListener("click", () => vote(id, btn));
  }
  foot.append(btn);

  el.append(head, body);
  if (summary) el.append(gist);
  el.append(foot);
  return el;
}

async function vote(id, btn) {
  btn.disabled = true;
  const { data, error } = await sb.rpc("vote_for_suggestion", { p_id: id });
  if (error) {
    // The database owns these rules, so just surface what it said.
    notice(error.message, "error");
    btn.disabled = false;
    return;
  }
  myVotes.add(id);
  btn.textContent = `▲ ${data} · voted`;
  btn.classList.add("voted");
}

async function refresh() {
  const column = els.sort.value;
  const { data, error } = await sb
    .from("public_suggestions")
    .select("*")
    .order(column, { ascending: false });

  els.list.replaceChildren();

  if (error) {
    const p = document.createElement("p");
    p.className = "notice error";
    p.textContent =
      error.message.includes("public_suggestions")
        ? "The public_suggestions view does not exist yet — run docs/setup.sql."
        : error.message;
    els.list.append(p);
    return;
  }
  if (!data.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No suggestions yet. Be the first.";
    els.list.append(p);
    return;
  }
  data.forEach((row) => els.list.append(card(row)));
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
  notice("Checking your suggestion against the school rules…");

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
        `Someone has already suggested this — #${payload.duplicate_of}: ` +
        `“${payload.existing}”. Vote for that one below instead.`,
        "warn",
      );
      return;
    }

    if (payload.status === "rejected") {
      notice(
        `This doesn’t fit the school suggestion rules, so it wasn’t added. ` +
        (payload.reason ? `Reason: ${payload.reason} ` : "") +
        `If you think that’s wrong, reword it or speak to a teacher.`,
        "warn",
      );
    } else {
      notice(
        `Submitted as #${payload.id} under “${payload.category}”. ` +
        `It will appear below once staff have approved it.`,
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
        ? "Could not reach the moderation service. If you are the site owner, " +
          "check the moderate-suggestion Edge Function is deployed."
        : err.message,
      "error",
    );
  } finally {
    els.send.disabled = false;
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

els.sort.addEventListener("change", refresh);

els.signin.addEventListener("click", () =>
  sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href },
  }),
);

els.signout.addEventListener("click", async () => {
  await sb.auth.signOut();
});

updateCounter();

sb.auth.onAuthStateChange((_event, newSession) => onAuthChange(newSession));
const { data: { session: initial } } = await sb.auth.getSession();
await onAuthChange(initial);
