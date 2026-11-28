// The suggestion form, on the home page and the Suggest page.
import { SUPABASE_ANON_KEY, MODERATE_URL } from "./config.js";
import { sb, el, signIn, watchSession } from "./common.js";
import { showUpdates } from "./mine.js?v=4";
import { HELP, showBox, offerMove } from "./boxes.js?v=1";


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

function notice(message, kind = "info", title = "") {
  // The outcome of a send gets a big headline, so a student sees at a glance
  // what happened before reading the detail underneath.
  if (title) {
    const head = document.createElement("strong");
    head.className = "notice-title";
    head.textContent = title;
    const body = document.createElement("span");
    body.className = "notice-body";
    body.textContent = message;
    els.result.replaceChildren(head, body);
  } else {
    els.result.textContent = message;
  }
  els.result.className = `notice ${kind}${title ? " notice-outcome" : ""}`;
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

// After a successful send: a popup repeating what was sent, with the two
// obvious next steps. Resolves once it is closed.
function sentPopup(text, line) {
  document.querySelector(".sent-dialog")?.remove();
  const dialog = el("dialog", "sent-dialog");
  dialog.setAttribute("aria-labelledby", "sent-title");
  const tick = el("span", "sent-tick");
  tick.setAttribute("aria-hidden", "true");
  const title = el("h2", null, "Sent!");
  title.id = "sent-title";
  const label = el("p", "sent-label mono", "Your suggestion was");
  const quote = el("p", "sent-quote", `“${text}”`);
  const note = el("p", "sent-note", line);
  const vote = el("a", "btn btn-primary", "Vote on other suggestions →");
  vote.href = "vote.html";
  const again = el("button", "btn btn-ghost", "Suggest something else");
  again.type = "button";
  const actions = el("div", "sent-actions");
  actions.append(vote, again);
  dialog.append(tick, title, label, quote, note, actions);
  document.body.append(dialog);

  return new Promise((resolve) => {
    const close = () => {
      dialog.close();
      dialog.remove();
      els.text.focus({ preventScroll: true });
      resolve();
    };
    again.addEventListener("click", close);
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    dialog.showModal();
    vote.focus();
  });
}

// Grade and section: optional, remembered in this browser so it only has to
// be picked once. Both or neither -- half a class can't be counted.
const CLASS_KEY = "my-class";
const gradeBox = $("grade");
const sectionBox = $("section");
const classNote = $("class-note");
const CLASS_NOTE = classNote.textContent;
try {
  const saved = JSON.parse(localStorage.getItem(CLASS_KEY));
  if (saved) { gradeBox.value = saved.grade ?? ""; sectionBox.value = saved.section ?? ""; }
} catch { /* not remembered */ }

function classChoice() {
  const grade = gradeBox.value;
  const section = sectionBox.value;
  return grade && section ? { grade, section } : null;
}
function updateClassNote() {
  const half = Boolean(gradeBox.value) !== Boolean(sectionBox.value);
  classNote.textContent = half ? "Pick both your grade and your section to count it." : CLASS_NOTE;
  classNote.classList.toggle("warn", half);
  try {
    localStorage.setItem(CLASS_KEY, JSON.stringify({ grade: gradeBox.value, section: sectionBox.value }));
  } catch { /* fine */ }
}
gradeBox.addEventListener("change", updateClassNote);
sectionBox.addEventListener("change", updateClassNote);

function clearForm() {
  els.text.value = "";
  els.benefit.value = "";
  updateCounter();
  updatePreview();
}

// ---- Live preview and writing tips ------------------------------------
// The card on the left shows the suggestion as the Vote page will, and three
// gentle ticks light up as it gets clearer. Tips only: nothing is blocked.
const preview = {
  card: $("preview"), text: $("preview-text"), why: $("preview-why"),
  benefit: $("preview-benefit"), date: $("preview-date"),
  copy: document.querySelector(".home-copy"),
  tips: [...document.querySelectorAll("#tips li")],
};
preview.date.textContent = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const PLACE_OR_GROUP = new RegExp("\\b(" + [
  "canteen", "cafeteria", "library", "class(room)?s?", "grade", "floor", "toilets?", "washrooms?",
  "bathrooms?", "field", "court", "ground", "bus(es)?", "corridors?", "labs?", "playground", "gym",
  "pool", "students?", "teachers?", "juniors?", "seniors?", "rooms?", "hall", "gate", "parking",
  "lunch", "break", "recess", "assembly", "timetable", "uniforms?", "exams?", "tests?", "sports?",
  "clubs?", "wi-?fi", "fans?", "ac", "lockers?", "benches", "water", "menu", "block", "wing",
  "auditorium", "music", "art", "science", "maths?", "english", "hindi", "pe", "house", "prefects?",
  "monday|tuesday|wednesday|thursday|friday|saturday", "morning", "afternoon", "after school",
].join("|") + ")\\b", "i");
const HOW = /\b(so (that|we|students|people|everyone)|because|to help|which would|it would|helps?)\b/i;

function updatePreview() {
  const text = els.text.value.trim();
  const benefit = els.benefit.value.trim();
  const typing = text.length > 0;
  preview.card.hidden = !typing;
  preview.copy?.classList.toggle("is-typing", typing);
  preview.text.textContent = text;
  preview.why.hidden = !benefit;
  preview.benefit.textContent = benefit;

  const words = text.split(/\s+/).filter(Boolean).length;
  const checks = {
    what: words >= 4,
    where: PLACE_OR_GROUP.test(text),
    why: benefit.length >= 12 || HOW.test(text),
  };
  for (const li of preview.tips) li.classList.toggle("ok", checks[li.dataset.tip]);
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
  let sent = ""; // set when it was actually sent: shows the popup

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
      body: JSON.stringify({ suggestion, benefit, ...(classChoice() ?? {}) }),
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
      notice("Not sent yet. Please add a little more detail and send it again.", "warn", "Needs a bit more detail");
      askToClarify(payload.question);
      return;
    }

    if (payload.status === "to_speak_up") {
      // Not a suggestion but telling staff about something wrong. Nothing
      // was saved: offer to move it to Speak Up, which is private.
      notice("Not sent yet. This sounds like something to tell staff privately.", "warn", "This belongs in Speak Up");
      offerMove({
        title: "This sounds like something to tell staff privately",
        body: [
          "The suggestion box is for changes everyone can vote on. What you " +
          "wrote sounds like something a teacher should know about, so it " +
          "belongs in Speak Up: it's anonymous unless you add your name, and " +
          "it's never shown to other students.",
          `Nothing has been sent yet. If anyone is in danger right now, tell a ` +
          `teacher straight away, or call ${HELP.phone}.`,
        ],
        button: "Move it to Speak Up",
        onMove: () => {
          const box = document.getElementById("report");
          box.value = [suggestion, benefit].filter(Boolean).join("\n\n");
          box.dispatchEvent(new Event("input"));
          clearForm();
          els.result.hidden = true;
          showBox("speak", { focus: true });
        },
      });
      return;
    }

    if (payload.status === "duplicate") {
      // Nothing was written. Show the existing suggestion so this reads as
      // "already covered" rather than "rejected".
      notice(
        `Someone has already suggested this, so it wasn't filed twice. ` +
        `The original (#${payload.duplicate_of}): “${payload.existing}”`,
        "warn", "Already suggested",
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
        "warn", "Thank you for telling us",
      );
    } else if (payload.queued || payload.unchecked) {
      sent = `It's in the queue and will be checked within a few minutes, then a member of staff reads it.`;
      // Every AI model stayed busy past the wait. It is saved and queued; the
      // once-a-minute run checks it, and My suggestions shows the result.
      notice(
        `Sent as #${payload.id}. Lots of students are sending right now, so ` +
        `yours is in the queue and will be checked within a few minutes. ` +
        `You can follow it on your My suggestions page.`,
        "ok", "Sent, waiting in the queue",
      );
    } else if (payload.status === "spam") {
      notice(
        `This doesn't look like a real suggestion, so it wasn't added. ` +
        (payload.reason ? `${payload.reason} ` : "") +
        `If it was meant seriously, try rewording it.`,
        "warn", "Not added",
      );
    } else if (payload.status === "rejected") {
      notice(
        `This doesn't fit the school guidelines, so it wasn't added. ` +
        (payload.reason ? `Reason: ${payload.reason} ` : "") +
        `If you think that's wrong, reword it or speak to a teacher.`,
        "warn", "Not added: against the guidelines",
      );
    } else {
      sent = `It's waiting for a member of staff to read it. Once approved, it goes on the Vote page.`;
      notice(
        `Sent as #${payload.id} under “${payload.category}”. ` +
        `It will appear on the Vote page once staff approve it.`,
        "ok", "Sent for staff review",
      );
    }
    clearForm();
    if (sent) await sentPopup(suggestion, sent);
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

els.text.addEventListener("input", () => { updateCounter(); updatePreview(); });
els.benefit.addEventListener("input", updatePreview);
restoreDraft();
updatePreview();



watchSession((newSession) => {
  session = newSession;
  showAccount();
  showUpdates(session);
}, { askToSignIn: true });
