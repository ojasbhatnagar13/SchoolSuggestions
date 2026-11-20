// The suggestion form on the home page.
import { SUPABASE_ANON_KEY, MODERATE_URL } from "./config.js";
import { sb, signIn, watchSession } from "./common.js";
import { showUpdates } from "./mine.js";

// PLACEHOLDERS -- the school must replace these with its real wellbeing
// contacts before launch. Also in the "Not for personal problems" note in
// index.html; tests/test_static.py checks the two match.
const HELP = { phone: "+91 XXXXX XXXXX", email: "help@dpsiedge.edu.in" };

// Must match maxlength in index.html and the limits in the Edge Function.
const MAX_LENGTH = 2000;

// Signing in leaves the page for Google and comes back, which would wipe what
// the student typed. Keep it in this browser until they're back. Only a
// convenience: if storage is blocked, the draft is simply not kept.
const DRAFT_KEY = "suggestion-draft";

const $ = (id) => document.getElementById(id);
const els = {
  form: $("submit-form"), text: $("suggestion"), benefit: $("benefit"),
  send: $("send"), sendLabel: document.querySelector("#send .btn-label"),
  counter: $("counter"), result: $("result"), signedAs: $("signed-as"),
};

let session = null;
let busy = false;

function notice(message, kind = "info") {
  els.result.textContent = message;
  els.result.className = `notice ${kind}`;
  els.result.hidden = false;
  // It sits above the form, so if the student has scrolled down to the
  // button, bring it back into view (below the sticky nav).
  const top = els.result.getBoundingClientRect().top;
  const navBottom = document.querySelector(".nav")?.getBoundingClientRect().bottom ?? 0;
  if (top < navBottom || top > window.innerHeight * 0.6) {
    window.scrollTo({ top: window.scrollY + top - navBottom - 16, behavior: "smooth" });
  }
}

// What the student watches while the AI checks: an animated ring, the step
// it is on, and a bar that fills over the ~15 seconds the server will wait
// before queueing. Purely for show -- the steps advance on a timer, not on
// real progress -- but it tells the truth about what is happening, and
// explains a longer wait instead of leaving a frozen screen.
const LOADER_STEPS = [
  "Reading your suggestion",
  "Checking it against the school guidelines",
  "Looking for anyone who suggested the same thing",
  "Getting it ready for staff",
];

function startLoader() {
  const box = els.result;
  box.className = "notice loader";
  box.hidden = false;

  const orbit = document.createElement("div");
  orbit.className = "loader-orbit";
  orbit.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) orbit.append(document.createElement("span"));

  const body = document.createElement("div");
  body.className = "loader-body";
  const step = document.createElement("p");
  step.className = "loader-step";
  const bar = document.createElement("div");
  bar.className = "loader-bar";
  const fill = document.createElement("i");
  bar.append(fill);
  const hint = document.createElement("p");
  hint.className = "loader-hint mono";
  body.append(step, bar, hint);
  box.replaceChildren(orbit, body);

  let i = 0;
  const show = () => {
    step.textContent = LOADER_STEPS[Math.min(i, LOADER_STEPS.length - 1)] + "…";
    step.classList.remove("in");
    void step.offsetWidth; // restart the fade-in
    step.classList.add("in");
  };
  show();
  requestAnimationFrame(() => fill.classList.add("go"));

  const timers = [
    setInterval(() => { i += 1; if (i < LOADER_STEPS.length) show(); }, 2200),
    setTimeout(() => {
      hint.textContent = "Lots of students are sending right now. Hang tight, you're in line.";
    }, 8000),
    setTimeout(() => {
      hint.textContent = "Nearly there. If it's still busy, we'll queue it so you don't have to wait.";
    }, 13000),
  ];
  return () => timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
}

// Counts down, so the number people watch is the one that matters: how much
// room is left. Only turns warning-coloured near the limit.
function updateCounter() {
  const left = MAX_LENGTH - els.text.value.length;
  els.counter.textContent =
    left === 1 ? "1 character left" : `${left} characters left`;
  els.counter.classList.toggle("low", left <= 100);
}

function idleLabel() {
  return session ? "Send suggestion" : "Sign in to send";
}

function showAccount() {
  if (!busy) els.sendLabel.textContent = idleLabel();
  els.signedAs.textContent = session
    ? `Sending as a signed-in student. Staff never see who sent it.`
    : `You'll sign in with Google first. Staff never see who sent it.`;
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      suggestion: els.text.value, benefit: els.benefit.value,
    }));
  } catch { /* not kept */ }
}

function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY));
    localStorage.removeItem(DRAFT_KEY);
    if (draft && !els.text.value) {
      els.text.value = draft.suggestion ?? "";
      els.benefit.value = draft.benefit ?? "";
    }
  } catch { /* nothing to restore */ }
  updateCounter();
}

// A friendly popup for a suggestion the AI couldn't make sense of. The AI
// writes the question (e.g. "Which part of the school would you like to
// change, and how?"); the button puts the student straight back in the box.
function askToClarify(question) {
  document.querySelector(".clarify-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.className = "clarify-dialog";

  const title = document.createElement("h3");
  title.textContent = "We're not quite sure what you mean";
  const ask = document.createElement("p");
  ask.className = "clarify-question";
  ask.textContent = question;
  const note = document.createElement("p");
  note.className = "clarify-note";
  note.textContent = "Nothing has been sent yet. Your suggestion is still in the box, " +
    "so just add a little more detail and send it again.";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn btn-primary";
  ok.textContent = "Edit my suggestion";

  const back = () => {
    dialog.close();
    dialog.remove();
    els.text.focus();
    els.text.setSelectionRange(els.text.value.length, els.text.value.length);
  };
  ok.addEventListener("click", back);
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); back(); });

  dialog.append(title, ask, note, ok);
  document.body.append(dialog);
  dialog.showModal();
  ok.focus();
}

// "Complete anonymity": swaps the reassurance for a bold warning, so nobody
// ticks it without seeing that it means no updates. Deliberately not reset
// after sending -- it is the student's standing choice for this visit.
const anonBox = document.getElementById("full-anon");
const anonDefault = document.getElementById("anon-default");
const anonWarning = document.getElementById("anon-warning");
anonBox.addEventListener("change", () => {
  anonDefault.hidden = anonBox.checked;
  anonWarning.hidden = !anonBox.checked;
  anonBox.closest(".anon-choice").classList.toggle("is-on", anonBox.checked);
});

function clearForm() {
  els.text.value = "";
  els.benefit.value = "";
  updateCounter();
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const suggestion = els.text.value.trim();
  const benefit = els.benefit.value.trim();
  if (!suggestion) return;

  // Signed out: keep what they wrote and go to Google. They send it when they
  // come back.
  if (!session) {
    saveDraft();
    signIn();
    return;
  }

  busy = true;
  els.send.disabled = true;
  els.sendLabel.textContent = "Checking…";
  const stopLoader = startLoader();
  // Read now: the student could untick it while the check is running.
  const fullyAnonymous = anonBox.checked;

  try {
    // getSession() refreshes an expired token, so this is always current.
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      saveDraft();
      notice("Your sign-in has expired. Please sign in again to send this.", "warn");
      return;
    }

    const res = await fetch(MODERATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ suggestion, benefit, fullyAnonymous }),
    });
    const payload = await res.json();

    if (res.status === 429 || res.status === 403) {
      // Rate limit, or an account that isn't allowed (e.g. not a school
      // address). The database writes this wording, so show it as-is.
      notice(payload.error, "warn");
      return;
    }
    if (res.status === 401) {
      saveDraft();
      notice("Please sign in again to send this. Your text will be kept.", "warn");
      return;
    }
    if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);

    if (payload.status === "clarify") {
      // Too vague to act on. Nothing was saved, accepted or rejected: the
      // text stays in the box and the student is asked to say more.
      notice("Not sent yet. Please add a little more detail and send it again.", "warn");
      askToClarify(payload.question);
      return;
    }

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

    // Nothing appears on the home page until staff approve it, so say so
    // either way -- otherwise a student submits, sees nothing new, and
    // assumes it failed. Checked first: a student asking for help must get
    // the help message even when the AI is down.
    if (payload.support) {
      // Someone reaching out about bullying, safety or wellbeing. Not a suggestion,
      // so not "it will appear on the home page".
      notice(
        `Thank you for telling us. ${payload.reason ?? ""} ` +
        `If you or someone else is in danger right now, tell a teacher or any ` +
        `adult straight away. You can also call ${HELP.phone} or email ` +
        `${HELP.email}. A member of staff will read what you wrote and pass it ` +
        `to the pastoral care team, but because this box is anonymous they ` +
        `cannot reply to you. It will not be shown to other students.`,
        "warn",
      );
    } else if (payload.queued || payload.unchecked) {
      // Every AI model stayed busy past the wait. It is saved and queued; the
      // once-a-minute run checks it, and My suggestions shows the result.
      notice(
        `Sent as #${payload.id}. Lots of students are sending right now, so ` +
        `yours is in the queue and will be checked within a few minutes. ` +
        (fullyAnonymous
          ? `It was sent with complete anonymity, so check the home page later to see if it's approved.`
          : `You can follow it on your My suggestions page.`),
        "ok",
      );
    } else if (payload.status === "spam") {
      notice(
        `This doesn't look like a real suggestion, so it wasn't added. ` +
        (payload.reason ? `${payload.reason} ` : "") +
        `If it was meant seriously, try rewording it.`,
        "warn",
      );
    } else if (payload.status === "rejected") {
      notice(
        `This doesn't fit the school guidelines, so it wasn't added. ` +
        (payload.reason ? `Reason: ${payload.reason} ` : "") +
        `If you think that's wrong, reword it or speak to a teacher.`,
        "warn",
      );
    } else {
      notice(
        `Sent as #${payload.id} under “${payload.category}”. ` +
        (fullyAnonymous
          ? `It was sent with complete anonymity, so you won't get updates: check the home page to see if it's approved.`
          : `It will appear on the home page once staff approve it.`),
        "ok",
      );
    }
    clearForm();
    showUpdates(session); // news about earlier suggestions, if any
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
    stopLoader();
    busy = false;
    els.send.disabled = false;
    els.sendLabel.textContent = idleLabel();
  }
});

els.text.addEventListener("input", updateCounter);
restoreDraft();



watchSession((newSession) => {
  session = newSession;
  showAccount();
  showUpdates(session);
});
