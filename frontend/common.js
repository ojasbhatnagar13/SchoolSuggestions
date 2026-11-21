// Shared by every page: the Supabase client, a safe DOM helper, and the
// sign-in controls in the nav.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Small DOM helper. Every string goes through textContent, never innerHTML --
// suggestion text is student-supplied and must never be parsed as markup.
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function signIn() {
  return sb.auth.signInWithOAuth({
    provider: "google",
    // No #fragment on the return URL: Supabase can hand the session back in the
    // hash, and an existing fragment would collide with it.
    options: { redirectTo: window.location.href.split("#")[0] },
  });
}

export function signOut() {
  return sb.auth.signOut();
}

// Keeps the nav's account controls in step with the session and calls
// onChange(session) once on load and again whenever someone signs in or out.
//
// The work is deferred with setTimeout because supabase-js runs this callback
// while holding its auth lock, and calling back into Supabase from inside it
// (as onChange usually does) can deadlock.
// A popup asking a signed-out student to sign in, once per visit: closing it
// ("Not now") keeps it away until the browser tab is closed.
const ASKED_KEY = "signin-asked";

function askToSignIn() {
  if (document.querySelector(".signin-dialog")) return;
  try {
    if (sessionStorage.getItem(ASKED_KEY)) return;
  } catch { /* ask anyway */ }

  const dialog = el("dialog", "signin-dialog");
  dialog.setAttribute("aria-labelledby", "signin-title");
  const logo = el("img", "signin-logo");
  logo.src = "logo.png";
  logo.alt = "";
  const title = el("h2", null, "Sign in to make DPSI better");
  title.id = "signin-title";
  const body = el("p", "signin-body",
    "Use your school Google account to suggest changes and vote on what other " +
    "students have suggested. Staff never see who sent a suggestion.");
  const go = el("button", "btn btn-primary", "Sign in with Google");
  go.type = "button";
  go.addEventListener("click", signIn);
  const later = el("button", "link-btn signin-later", "Not now");
  later.type = "button";
  const close = () => {
    try { sessionStorage.setItem(ASKED_KEY, "1"); } catch { /* fine */ }
    dialog.close();
    dialog.remove();
  };
  later.addEventListener("click", close);
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(); });

  dialog.append(logo, title, body, go, later);
  document.body.append(dialog);
  dialog.showModal();
  go.focus();
}

// Student pages pass { askToSignIn: true } to get the popup when signed out.
export function watchSession(onChange = () => {}, { askToSignIn: ask = false } = {}) {
  const who = document.getElementById("who");
  const signin = document.getElementById("signin");
  const signout = document.getElementById("signout");

  // Two scripts on one page both call this; wire the buttons only once.
  if (signin && !signin.dataset.wired) {
    signin.dataset.wired = "1";
    signin.addEventListener("click", signIn);
    signout?.addEventListener("click", signOut);
  }

  sb.auth.onAuthStateChange((event, session) => {
    // An hourly token refresh changes nothing the page shows.
    if (event === "TOKEN_REFRESHED") return;

    setTimeout(() => {
      const email = session?.user?.email;
      if (who) {
        who.textContent = email || "";
        who.hidden = !email;
      }
      if (signin) signin.hidden = !!session;
      if (signout) signout.hidden = !session;
      if (session) document.querySelector(".signin-dialog")?.remove();
      else if (ask) askToSignIn();
      onChange(session);
    }, 0);
  });
}
