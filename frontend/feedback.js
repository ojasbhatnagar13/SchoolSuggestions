// Feedback about the site itself. Saved through send_feedback(); staff read
// it on the staff page. The sender is never shown (docs/setup-feedback-mine.sql).
import { sb, signIn, watchSession } from "./common.js";

const form = document.getElementById("feedback-form");
const text = document.getElementById("feedback-text");
const send = document.getElementById("feedback-send");
const result = document.getElementById("feedback-result");
let session = null;

function say(message, kind) {
  result.textContent = message;
  result.className = `notice ${kind}`;
  result.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!session) {
    signIn(); // feedback needs a signed-in account, like everything else
    return;
  }
  const kind = form.querySelector('input[name="kind"]:checked')?.value;
  send.disabled = true;
  const { error } = await sb.rpc("send_feedback", {
    p_kind: kind,
    p_message: text.value,
    p_page: document.referrer ? new URL(document.referrer).pathname.slice(0, 100) : null,
  });
  send.disabled = false;
  if (error) return say(error.message, "warn");
  form.reset();
  say("Thank you. Staff will read it.", "ok");
});

watchSession((s) => {
  session = s;
  send.firstChild.textContent = s ? "Send feedback " : "Sign in to send ";
});
