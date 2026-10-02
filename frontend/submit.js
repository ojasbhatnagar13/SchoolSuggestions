// The suggestion form on the home page.
import { SUPABASE_ANON_KEY, MODERATE_URL } from "./config.js";
import { sb, signIn, watchSession } from "./common.js";

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
  return session ? "Send idea" : "Sign in to send";
}

function showAccount() {
  if (!busy) els.sendLabel.textContent = idleLabel();
  els.signedAs.textContent = session
    ? `Sending as a signed-in student. Your name is never attached to the idea.`
    : `You'll sign in with Google first. Your name is never attached to the idea.`;
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
  notice("Checking your idea against the school guidelines. This usually takes a few seconds.");

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
      body: JSON.stringify({ suggestion, benefit }),
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

    // Nothing appears on the Ideas page until staff approve it, so say so
    // either way -- otherwise a student submits, sees nothing new, and
    // assumes it failed.
    if (payload.unchecked) {
      // Every AI model was busy. The suggestion was still saved -- it goes
      // straight to a person instead of being screened first.
      notice(
        `Sent as #${payload.id}. The automatic check is busy right now, ` +
        `so a member of staff will read it directly.`,
        "ok",
      );
    } else if (payload.support) {
      // Someone reaching out about bullying, safety or wellbeing. Not an idea,
      // so not "it will appear on the Ideas page".
      notice(
        `Thank you for telling us. ${payload.reason} ` +
        `If you or someone else is in danger right now, tell a teacher or any ` +
        `adult straight away. A member of staff will also read what you wrote ` +
        `and pass it to the pastoral care team, but because this box is ` +
        `anonymous they cannot reply to you. It will not be shown to other students.`,
        "warn",
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
        `It will appear on the Ideas page once staff approve it.`,
        "ok",
      );
    }
    clearForm();
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
});
