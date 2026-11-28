// The Speak Up reports page for staff: what students have told staff about
// something wrong (docs/setup-speak-up.sql). Its own page, apart from the
// suggestion review.
import { sb, el, signIn, watchSession } from "./common.js";

const $ = (id) => document.getElementById(id);

function gate(message, kind = "info") {
  $("gate").textContent = message;
  $("gate").className = `notice ${kind}`;
  $("gate").hidden = false;
  $("reports-section").hidden = true;
}

// ------------------------------------------------------------------ Speak Up reports

const REPORT_STATUS = { new: "New", in_hand: "Being handled", closed: "Closed" };

async function loadReports() {
  const section = $("reports-section");
  const { data, error } = await sb.rpc("staff_reports");
  if (error) {
    gate(
      error.message.includes("Staff access required")
        ? "That account is not on the staff list. Ask an administrator to add you."
        : error.message,
      "warn",
    );
    return;
  }
  $("gate").hidden = true;
  section.hidden = false;
  const open = data.filter((r) => r.status !== "closed");
  const urgent = open.filter((r) => r.urgency === "urgent").length;
  $("reports-count").textContent = data.length
    ? `${open.length} open` + (urgent ? ` · ${urgent} urgent` : "") + ` · ${data.length - open.length} closed`
    : "Nothing yet";

  const list = $("reports-list");
  if (!data.length) {
    list.replaceChildren(el("li", "hint", "No reports yet. Students send them from the Speak Up tab on the home page."));
    return;
  }
  list.replaceChildren(...data.map((r) => {
    const li = el("li", `report-item report-${r.status}` + (r.urgency === "urgent" ? " is-urgent" : ""));
    const head = el("div", "report-head");
    if (r.urgency === "urgent") head.append(el("span", "report-tag tag-urgent", "Urgent"));
    head.append(el("span", "report-tag", r.category || "Not sorted yet"));
    if (!r.checked) head.append(el("span", "report-tag", "AI was busy: not checked"));
    head.append(el("span", "report-when mono", new Date(r.created_at).toLocaleString(undefined, {
      day: "numeric", month: "short", hour: "numeric",
    })));
    li.append(head);
    if (r.summary) li.append(el("p", "report-summary", r.summary));
    li.append(el("p", "report-text", r.report));
    if (r.place) {
      const place = el("p", "report-place");
      place.append(el("span", "mono", "Where and when"), el("span", null, r.place));
      li.append(place);
    }
    li.append(el("p", "report-from" + (r.reporter_email ? " is-named" : ""),
      r.reporter_email ? `From ${r.reporter_email}, who asked to be contacted.` : "Anonymous. Nobody can find out who sent it."));

    const actions = el("div", "report-actions");
    for (const [value, label] of Object.entries(REPORT_STATUS)) {
      const b = el("button", "qbtn" + (r.status === value ? " is-on" : ""), label);
      b.type = "button";
      b.disabled = r.status === value;
      b.addEventListener("click", async () => {
        b.disabled = true;
        const { error: setError } = await sb.rpc("staff_set_report_status", { p_id: r.id, p_status: value });
        if (setError) {
          alert(setError.message);
          b.disabled = false;
          return;
        }
        await loadReports();
      });
      actions.append(b);
    }
    li.append(actions);
    return li;
  }));
}

const heroSignIns = [...document.querySelectorAll("[data-signin]")];
heroSignIns.forEach((b) => b.addEventListener("click", signIn));

$("reports-refresh").addEventListener("click", async (e) => {
  e.target.disabled = true;
  await loadReports();
  e.target.disabled = false;
});

watchSession(async (session) => {
  heroSignIns.forEach((b) => (b.hidden = !!session));
  if (!session) {
    gate("Sign in with your staff Google account to read reports.");
    return;
  }
  await loadReports();
});
