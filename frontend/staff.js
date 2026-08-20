import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
const els = {
  gate: $("gate"), board: $("board"), list: $("list"), count: $("count"),
  who: $("who"), signin: $("signin"), signout: $("signout"),
};

const STATUSES = ["pending", "approved", "rejected", "actioned"];

let session = null;
let rows = [];
let filter = "all";

function gate(message, kind = "info") {
  els.gate.textContent = message;
  els.gate.className = `notice ${kind}`;
  els.gate.hidden = false;
  els.board.hidden = true;
}

// Suggestion text and the AI's reason are untrusted input -- a student can put
// anything in a suggestion, and the model echoes parts of it back. Both are
// only ever set via textContent.
function card(row) {
  const el = document.createElement("article");
  el.className = "card suggestion";
  if (row.spam === "Yes") el.classList.add("is-flagged");

  const head = document.createElement("div");
  head.className = "row";

  const tags = document.createElement("div");
  tags.className = "tags";

  const cat = document.createElement("span");
  cat.className = "tag";
  cat.textContent = row.category || "Uncategorised";
  tags.append(cat);

  if (row.spam === "Yes") {
    const flag = document.createElement("span");
    flag.className = "tag tag-flag";
    flag.textContent = "Flagged";
    tags.append(flag);
  }

  if (row.feasibility) {
    const feas = document.createElement("span");
    feas.className = "tag";
    feas.textContent = row.feasibility;
    tags.append(feas);
  }

  const meta = document.createElement("span");
  meta.className = "hint";
  meta.textContent = `#${row.id} · ${row.votes ?? 0} votes · ${new Date(row.created_at).toLocaleDateString()}`;
  head.append(tags, meta);

  const body = document.createElement("p");
  body.textContent = row.suggestion;

  const reason = document.createElement("p");
  reason.className = "hint reason";
  reason.textContent = row.reason ? `AI: ${row.reason}` : "";

  const foot = document.createElement("div");
  foot.className = "row";

  const label = document.createElement("label");
  label.className = "hint";
  label.textContent = "Status";
  const select = document.createElement("select");
  select.setAttribute("aria-label", `Status for suggestion ${row.id}`);
  for (const s of STATUSES) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    if (s === row.status) opt.selected = true;
    select.append(opt);
  }
  label.append(" ", select);

  const saved = document.createElement("span");
  saved.className = "hint";

  select.addEventListener("change", async () => {
    const wanted = select.value;
    select.disabled = true;
    saved.textContent = "saving…";
    const { data, error } = await sb.rpc("staff_set_status", {
      p_id: row.id,
      p_status: wanted,
    });
    select.disabled = false;
    if (error) {
      saved.textContent = error.message;
      select.value = row.status; // roll back to what the database still holds
      return;
    }
    row.status = data;
    saved.textContent = "saved";
    setTimeout(() => (saved.textContent = ""), 1500);
    render();
  });

  foot.append(label, saved);

  el.append(head, body);
  if (row.reason) el.append(reason);
  el.append(foot);
  return el;
}

function matches(row) {
  if (filter === "all") return true;
  if (filter === "flagged") return row.spam === "Yes";
  return row.status === filter;
}

function render() {
  const shown = rows.filter(matches);
  els.list.replaceChildren();
  els.count.textContent = `${shown.length} of ${rows.length}`;

  if (!shown.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Nothing here.";
    els.list.append(p);
    return;
  }
  shown.forEach((row) => els.list.append(card(row)));
}

async function load() {
  const { data, error } = await sb.rpc("staff_suggestions");

  if (error) {
    if (error.message.includes("Staff access required")) {
      gate(
        `Signed in as ${session.user.email}, but that account is not on the ` +
        `staff list. Ask an administrator to add you (docs/setup-staff.sql, ` +
        `section 5).`,
        "warn",
      );
    } else if (error.message.includes("staff_suggestions")) {
      gate("Staff functions are not installed yet — run docs/setup-staff.sql.", "error");
    } else {
      gate(error.message, "error");
    }
    return;
  }

  rows = data ?? [];
  els.gate.hidden = true;
  els.board.hidden = false;
  render();
}

async function onAuthChange(newSession) {
  session = newSession;
  const email = session?.user?.email;
  els.who.textContent = email || "";
  els.who.hidden = !email;
  els.signin.hidden = !!session;
  els.signout.hidden = !session;

  if (!session) {
    gate("Sign in with your school account to review suggestions.");
    return;
  }
  await load();
}

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    filter = chip.dataset.filter;
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-on"));
    chip.classList.add("is-on");
    render();
  });
}

els.signin.addEventListener("click", () =>
  sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href },
  }),
);

els.signout.addEventListener("click", async () => {
  await sb.auth.signOut();
});

sb.auth.onAuthStateChange((_event, newSession) => onAuthChange(newSession));
const { data: { session: initial } } = await sb.auth.getSession();
await onAuthChange(initial);
