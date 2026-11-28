// "Speak Up": the second box on the home page, for telling teachers about
// something wrong. Anonymous unless the student switches on "Include my
// name" (see docs/setup-speak-up.sql for what is stored).
import { SUPABASE_ANON_KEY, MODERATE_URL } from "./config.js";
import { sb, el, signIn, watchSession } from "./common.js";
import { HELP, showBox, offerMove } from "./boxes.js?v=1";

const MAX_LENGTH = 2000; // must match REPORT_MAX_LENGTH in the Edge Function

// Kept across the trip to Google sign-in, in this tab only: a report is too
// sensitive to leave lying in the browser for the next person.
const DRAFT_KEY = "report-draft";

const $ = (id) => document.getElementById(id);
const els = {
  form: $("report-form"), text: $("report"), place: $("place"), named: $("named"),
  send: $("report-send"), label: document.querySelector("#report-send .btn-label"),
  counter: $("report-counter"), result: $("report-result"),
  namedOff: $("named-off"), namedOn: $("named-on"),
};

let session = null;
let busy = false;

function notice(message, kind = "info", title = "") {
  if (title) {
    els.result.replaceChildren(el("strong", "notice-title", title), el("span", "notice-body", message));
  } else {
    els.result.textContent = message;
  }
  els.result.className = `notice speak-only ${kind}${title ? " notice-outcome" : ""}`;
  els.result.hidden = false;
}

const idleLabel = () => (session ? "Send to staff" : "Sign in to send");

function updateCounter() {
  const left = MAX_LENGTH - els.text.value.length;
  els.counter.textContent = left === 1 ? "1 character left" : `${left} characters left`;
  els.counter.classList.toggle("low", left <= 100);
}

function showNamed() {
  els.namedOff.hidden = els.named.checked;
  els.namedOn.hidden = !els.named.checked;
  els.named.closest(".anon-choice").classList.toggle("is-on", els.named.checked);
}

function clearForm() {
  els.text.value = "";
  els.place.value = "";
  els.named.checked = false;
  showNamed();
  updateCounter();
}

function saveDraft() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      report: els.text.value, place: els.place.value, named: els.named.checked,
    }));
  } catch { /* not kept */ }
}

function restoreDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
    sessionStorage.removeItem(DRAFT_KEY);
    if (draft && !els.text.value) {
      els.text.value = draft.report ?? "";
      els.place.value = draft.place ?? "";
      els.named.checked = draft.named === true;
      showBox("speak");
    }
  } catch { /* nothing to restore */ }
  showNamed();
  updateCounter();
}

// What the student sees once it has gone.
function sentPopup(text, named, urgent) {
  document.querySelector(".sent-dialog")?.remove();
  const dialog = el("dialog", "sent-dialog");
  dialog.setAttribute("aria-labelledby", "report-sent-title");
  const title = el("h2", null, "Sent to staff");
  title.id = "report-sent-title";
  const lines = [
    named
      ? "A member of staff will read it and may talk to you about it."
      : "A member of staff will read it. It isn't linked to you, so nobody can " +
        "find out it was you, and they can't reply.",
  ];
  if (urgent) {
    lines.push(`If anyone is in danger right now, tell a teacher straight away. ` +
      `You can also call ${HELP.phone} or email ${HELP.email}.`);
  }
  const ok = el("button", "btn btn-primary", "Done");
  ok.type = "button";
  const actions = el("div", "sent-actions");
  actions.append(ok);
  dialog.append(
    el("span", "sent-tick"), title, el("p", "sent-label mono", "You told staff"),
    el("p", "sent-quote", `“${text}”`), ...lines.map((t) => el("p", "sent-note", t)), actions,
  );
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  ok.addEventListener("click", close);
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dialog.showModal();
  ok.focus();
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const report = els.text.value.trim();
  const place = els.place.value.trim();
  const named = els.named.checked;
  if (!report || busy) return;

  if (!session) {
    saveDraft();
    signIn();
    return;
  }

  busy = true;
  els.send.disabled = true;
  els.label.textContent = "Sending…";
  notice("Sending it to staff…");

  try {
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
      body: JSON.stringify({ box: "report", report, place, named }),
    });
    const payload = await res.json();

    if (res.status === 429 || res.status === 403) {
      notice(payload.error, "warn");
      return;
    }
    if (res.status === 401) {
      saveDraft();
      notice("Please sign in again to send this. Your text will be kept.", "warn");
      return;
    }
    if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);

    if (payload.status === "to_suggestions") {
      notice("Not sent yet. This looks like a suggestion rather than something to report.", "warn", "This sounds like a suggestion");
      offerMove({
        title: "This sounds like a suggestion",
        body: [
          "Speak Up is for telling staff about something wrong. What you wrote " +
          "sounds like a change you'd like the school to make, so it belongs in " +
          "the suggestion box, where other students can vote for it.",
          "Nothing has been sent yet.",
        ],
        button: "Move it to the suggestion box",
        onMove: () => {
          const box = $("suggestion");
          box.value = [report, place].filter(Boolean).join(" ");
          box.dispatchEvent(new Event("input"));
          clearForm();
          els.result.hidden = true;
          showBox("suggest", { focus: true });
        },
      });
      return;
    }
    if (payload.status === "spam") {
      notice("This doesn't look like a real report, so it wasn't sent. If something " +
        "is wrong, say what happened and it will reach a member of staff.", "warn", "Not sent");
      return;
    }

    clearForm();
    els.result.hidden = true;
    sentPopup(report, payload.named === true, payload.urgent === true);
  } catch (err) {
    notice(
      err instanceof TypeError
        ? "Couldn't reach the site. Check your internet connection and try again. " +
          "Your text is still in the box."
        : err.message,
      "error",
    );
  } finally {
    busy = false;
    els.send.disabled = false;
    els.label.textContent = idleLabel();
  }
});

els.text.addEventListener("input", updateCounter);
els.named.addEventListener("change", showNamed);
restoreDraft();

watchSession((s) => {
  session = s;
  if (!busy) els.label.textContent = idleLabel();
});
