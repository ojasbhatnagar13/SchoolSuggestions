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
export function watchSession(onChange = () => {}) {
  const who = document.getElementById("who");
  const signin = document.getElementById("signin");
  const signout = document.getElementById("signout");

  signin?.addEventListener("click", signIn);
  signout?.addEventListener("click", signOut);

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
      onChange(session);
    }, 0);
  });
}
