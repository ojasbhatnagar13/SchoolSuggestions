// The suggestion form on the home page.
import { SUPABASE_ANON_KEY, MODERATE_URL } from "./config.js";
import { watchSession } from "./common.js";

// Must match maxlength in index.html and the limits in the Edge Function.
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
    // Private browsing or blocked storage. The request still works, it just
    // shares the network bucket.
    token = "";
  }
  return token;
}

const $ = (id) => document.getElementById(id);
const els = {
  form: $("submit-form"), text: $("suggestion"), benefit: $("benefit"),
  send: $("send"), sendLabel: document.querySelector("#send .btn-label"),
  counter: $("counter"), result: $("result"),
};

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

  els.send.disabled = true;
  els.sendLabel.textContent = "Checking…";
  notice("Checking your idea against the school guidelines. This usually takes a few seconds.");

  try {
    const res = await fetch(MODERATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ suggestion, benefit, deviceToken: deviceToken() }),
    });
    const payload = await res.json();

    if (res.status === 429) {
      // Rate limited. The database writes this wording, so show it as-is and
      // treat it as a warning rather than an error -- nothing broke.
      notice(payload.error, "warn");
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
    els.send.disabled = false;
    els.sendLabel.textContent = "Send idea";
  }
});

els.text.addEventListener("input", updateCounter);
updateCounter();

// Only for the nav's sign-in state. Submitting never needs an account.
watchSession();
