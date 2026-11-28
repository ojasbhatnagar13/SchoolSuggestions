import { sb, el, signIn, watchSession } from "./common.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// Built here rather than added to config.js: browsers can hold an old cached
// config.js after an update, and a missing export would break the whole page.
const REPHRASE_URL = `${SUPABASE_URL}/functions/v1/rephrase-suggestion`;

const $ = (id) => document.getElementById(id);
const els = {
  gate: $("gate"), board: $("board"), list: $("list"), count: $("count"),
  fStatus: $("f-status"), fCategory: $("f-category"), fSource: $("f-source"),
  refresh: $("refresh"), toast: $("toast"),
};

// Display order, which is also the sort order: pending first, because it is
// the only group that needs someone to act.
const GROUPS = [
  { key: "pending",  label: "Pending" },
  { key: "approved", label: "Open for votes" },
  { key: "accepted", label: "Going ahead" },
  { key: "actioned", label: "Actioned" },
  { key: "rejected", label: "Rejected" },
  { key: "spam",     label: "Spam" },
];
const LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g.label]));
const ORDER = Object.fromEntries(GROUPS.map((g, i) => [g.key, i]));

const SOURCES = [
  { key: "any",   label: "Anyone" },
  { key: "ai",    label: "AI" },
  { key: "staff", label: "Staff" },
];

// Rejected and spam are hidden until asked for, so they don't bury the queue.
const DEFAULT_STATUSES = ["pending", "approved", "accepted", "actioned"];
// v2: "accepted" was added; older saved filters would hide it.
const FILTER_KEY = "staff-filters-v2";

let session = null;
let rows = [];
const filters = loadFilters();

function loadFilters() {
  const fresh = { statuses: new Set(DEFAULT_STATUSES), categories: new Set(), source: "any" };
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY));
    if (saved) {
      return {
        statuses: new Set(saved.statuses ?? DEFAULT_STATUSES),
        categories: new Set(saved.categories ?? []),
        source: saved.source ?? "any",
      };
    }
  } catch { /* storage blocked or corrupt -- use the defaults */ }
  return fresh;
}

function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({
      statuses: [...filters.statuses],
      categories: [...filters.categories],
      source: filters.source,
    }));
  } catch { /* a convenience only */ }
}

// Before docs/setup-review-v2.sql, spam was stored as 'rejected' with
// spam='Yes'. Reading it as spam keeps this page right either way.
function group(row) {
  if (row.status === "rejected" && row.spam === "Yes" && row.decided_by !== "staff") {
    return "spam";
  }
  return row.status;
}

const category = (row) => row.category || "Uncategorised";

// `except` names the filter being counted, so each row of chips shows how
// many you would get by changing that filter alone.
function matches(row, except = null) {
  // Wellbeing concerns live only in the red section, never in the queue.
  if (row.concern) return false;
  if (except !== "status" && !filters.statuses.has(group(row))) return false;
  if (except !== "category" && filters.categories.size && !filters.categories.has(category(row))) return false;
  if (except !== "source" && filters.source !== "any" && row.decided_by !== filters.source) return false;
  return true;
}

function when(iso) {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function aiVerdict(row) {
  if (row.spam === "Yes") return "Spam";
  return row.feasibility || "No verdict";
}

function decisionText(row) {
  const label = LABEL[group(row)] ?? row.status;
  if (row.decided_by === "ai") {
    return `${label} automatically by the AI` + (row.decided_at ? ` · ${when(row.decided_at)}` : "");
  }
  if (row.decided_by === "staff") {
    // Never which member of staff: the database does not send it (decision
    // 2026-11-19, docs/setup-hide-reviewers.sql).
    const who = "staff";
    const what = row.status === "pending" ? "Moved back to Pending" : label;
    return `${what} by ${who}` + (row.decided_at ? ` · ${when(row.decided_at)}` : "");
  }
  return row.status === "pending" ? "Waiting for a staff decision" : "Who decided was not recorded";
}

// ------------------------------------------------------------------ cards

// ------------------------------------------------------------------ wording warnings

// Set by the AI when a suggestion arrives (docs/setup-flags-reword.sql).
// Each has its own colour (style.css, .flag-*) and a plain instruction.
const FLAGS = {
  queued: ["Waiting for AI check", "Queued because the AI was busy. It will be checked within a few minutes, or you can decide now."],
  hidden_concern: ["Hidden concern", "Also reports harm or feeling unsafe. It is in the red section at the top: pass it to pastoral care."],
  rude: ["Rude wording", "A real point, phrased with insults or disrespect. Reword it before students see it."],
  names_person: ["Names someone", "Mentions a specific teacher or student. Reword to take the name out before students see it."],
  sarcastic: ["Sarcastic", "Mocking or sarcastic wording. Reword it into a plain request."],
  no_suggestion: ["No suggestion", "Describes a problem but asks for nothing. Reword it into a request, or reject it."],
  unclear: ["Unclear", "Hard to tell what is being asked for."],
  several_requests: ["Several requests", "Asks for more than one thing. You may want to reword it to one."],
};
// These mean students should not see the wording as it stands.
const NEEDS_REWORD = ["rude", "names_person", "sarcastic"];

function warningBox(flags) {
  const known = (flags ?? []).filter((f) => FLAGS[f]);
  if (!known.length) return null;
  const box = el("ul", "warnings");
  for (const f of Object.keys(FLAGS).filter((k) => known.includes(k))) {
    const li = el("li", `warning flag-${f}`);
    li.append(el("span", "flag", FLAGS[f][0]), el("span", "warning-text", FLAGS[f][1]));
    box.append(li);
  }
  return box;
}

// ------------------------------------------------------------------ rewording

function originalBox(row) {
  const details = el("details", "original");
  const when = row.reworded_at ? ` · ${new Date(row.reworded_at).toLocaleDateString()}` : "";
  details.append(el("summary", null, `Reworded by staff${when}. Show the student's original`));
  details.append(el("p", "original-text", row.original_suggestion));
  if (row.original_benefit) details.append(el("p", "original-text", `How it helps: ${row.original_benefit}`));
  const restore = el("button", "qbtn", "Restore the original");
  restore.type = "button";
  restore.addEventListener("click", async () => {
    if (!confirm("Put the student's original wording back? Students will see it as they wrote it.")) return;
    restore.disabled = true;
    const { error } = await sb.rpc("staff_restore_original", { p_id: row.id });
    if (error) {
      restore.disabled = false;
      return toast(error.message, null, true);
    }
    await load();
    toast(`#${row.id} is back to the student's original wording.`);
  });
  details.append(restore);
  return details;
}

// Swaps the wording on a card for an editor. "Ask AI" drafts a respectful
// version of both boxes; the teacher can edit it, and nothing is saved until
// they press Save.
function openRewordEditor(row, words) {
  if (words.querySelector(".reword")) return;
  const shown = [...words.children];
  shown.forEach((n) => (n.hidden = true));

  const editor = el("div", "reword");
  const textLabel = el("label", "field-label-l", "Suggestion, as students will see it");
  const text = el("textarea");
  text.rows = 3;
  text.maxLength = 2000;
  text.value = row.suggestion;
  const benefitLabel = el("label", "field-label-l", "How it helps");
  const benefit = el("textarea");
  benefit.rows = 2;
  benefit.maxLength = 1000;
  benefit.value = row.benefit ?? "";
  textLabel.append(text);
  benefitLabel.append(benefit);

  const status = el("p", "reword-status mono");
  const ask = el("button", "qbtn q-ai", "Ask AI to rephrase");
  const save = el("button", "qbtn q-approve", "Save wording");
  const cancel = el("button", "qbtn", "Cancel");
  [ask, save, cancel].forEach((b) => (b.type = "button"));

  ask.addEventListener("click", async () => {
    ask.disabled = true;
    status.textContent = "Asking the AI…";
    const { data } = await sb.auth.getSession();
    try {
      const res = await fetch(REPHRASE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${data.session?.access_token}`,
        },
        // Always from the student's own words, so asking twice never drifts.
        body: JSON.stringify({
          suggestion: row.original_suggestion ?? row.suggestion,
          benefit: row.original_suggestion ? row.original_benefit ?? "" : row.benefit ?? "",
        }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
      text.value = out.suggestion;
      benefit.value = out.benefit;
      status.textContent = "Draft ready. Check it says what the student meant, edit if needed, then save.";
    } catch (err) {
      status.textContent = err.message;
    } finally {
      ask.disabled = false;
    }
  });

  save.addEventListener("click", async () => {
    save.disabled = true;
    const { error } = await sb.rpc("staff_reword", {
      p_id: row.id, p_suggestion: text.value, p_benefit: benefit.value,
    });
    if (error) {
      save.disabled = false;
      status.textContent = error.message;
      return;
    }
    await load();
    toast(`#${row.id} reworded. Students will see the new wording.`);
  });

  cancel.addEventListener("click", () => {
    editor.remove();
    shown.forEach((n) => (n.hidden = false));
  });

  const buttons = el("div", "quick");
  buttons.append(ask, save, cancel);
  editor.append(textLabel, benefitLabel, buttons, status);
  words.append(editor);
  text.focus();
}

// Suggestion text, the student's explanation and the AI's reason are all
// untrusted input -- a student can put anything in them, and the model
// echoes parts back. el() only ever uses textContent.
function card(row) {
  const g = group(row);
  const article = el("article", `card suggestion is-${g}`);

  const head = el("div", "row");
  const badges = el("div", "tags");
  badges.append(el("span", `pill pill-${g}`, LABEL[g] ?? row.status));
  if (row.decided_by) {
    badges.append(el("span", `by by-${row.decided_by}`, row.decided_by === "ai" ? "by AI" : "by staff"));
  }
  badges.append(el("span", "tag", category(row)));
  head.append(
    badges,
    el("span", "hint", `#${row.id} · ${row.votes ?? 0} votes · ${new Date(row.created_at).toLocaleDateString()}`),
  );

  article.append(head);
  const warnings = warningBox(row.ai_status === "queued" ? [...(row.flags ?? []), "queued"] : row.flags);
  if (warnings) article.append(warnings);

  // The wording students will see. Swapped for an editor by "Reword".
  const words = el("div", "words");
  words.append(el("p", "body", row.suggestion));
  if (row.benefit) {
    const why = el("p", "why");
    why.append(el("span", "mono", "Why it helps"), el("span", null, row.benefit));
    words.append(why);
  }
  if (row.original_suggestion) words.append(originalBox(row));
  if (row.staff_reason) {
    const said = el("p", "staff-reason");
    said.append(el("span", "mono", "Reason given to the student"), el("span", null, row.staff_reason));
    const edit = el("button", "link-edit", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => askReason(row));
    said.append(edit);
    words.append(said);
  } else if (row.status === "rejected") {
    const add = el("button", "link-edit", "+ Add a reason for the student");
    add.type = "button";
    add.addEventListener("click", () => askReason(row));
    words.append(add);
  }
  article.append(words);

  const ai = el("div", `ai-box ai-${aiVerdict(row).toLowerCase().replace(/\s+/g, "-")}`);
  ai.append(el("span", "mono", `AI verdict · ${aiVerdict(row)}`));
  if (row.reason) ai.append(el("p", null, row.reason));
  article.append(ai);

  article.append(el("p", "decision mono", decisionText(row)));

  const foot = el("div", "row foot");

  const label = el("label", "hint", "Move to");
  const select = el("select");
  select.setAttribute("aria-label", `Status for suggestion ${row.id}`);
  for (const { key, label: text } of GROUPS) {
    const opt = el("option", null, text);
    opt.value = key;
    if (key === row.status) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener("change", () => setStatus(row, select.value, select));
  label.append(" ", select);
  const reword = el("button", "qbtn q-reword", row.original_suggestion ? "Reword again" : "Reword");
  reword.type = "button";
  reword.addEventListener("click", () => openRewordEditor(row, words));
  const left = el("div", "foot-left");
  left.append(label, reword);
  foot.append(left);

  // The decisions a pending suggestion almost always needs, one click
  // each. Everything else goes through the menu.
  if (row.status === "pending") {
    const quick = el("div", "quick");
    for (const [key, text, cls] of [
      ["approved", "Approve for voting", "q-approve"],
      ["accepted", "Go ahead, no vote", "q-ahead"],
      ["rejected", "Reject", "q-reject"],
      ["spam", "Spam", "q-spam"],
    ]) {
      const b = el("button", `qbtn ${cls}`, text);
      b.type = "button";
      b.addEventListener("click", () => setStatus(row, key, b));
      quick.append(b);
    }
    foot.append(quick);
  }

  article.append(foot);
  return article;
}

// ------------------------------------------------------------------ actions

let toastTimer = null;

function toast(message, undo = null, isError = false) {
  clearTimeout(toastTimer);
  els.toast.replaceChildren(el("span", null, message));
  els.toast.classList.toggle("is-error", isError);
  if (undo) {
    const b = el("button", "toast-undo", "Undo");
    b.type = "button";
    b.addEventListener("click", () => {
      els.toast.hidden = true;
      undo();
    });
    els.toast.append(b);
  }
  els.toast.hidden = false;
  toastTimer = setTimeout(() => (els.toast.hidden = true), 7000);
}

async function setStatus(row, wanted, control) {
  if (wanted === row.status) return;

  // Showing a rude, sarcastic or name-calling suggestion to students as the
  // student wrote it is almost always a slip. Ask first.
  const risky = (row.flags ?? []).filter((f) => NEEDS_REWORD.includes(f));
  if (["approved", "accepted", "actioned"].includes(wanted) && risky.length && !row.original_suggestion) {
    const what = risky.map((f) => FLAGS[f][0].toLowerCase()).join(" and ");
    if (!confirm(`This suggestion was flagged for ${what}. Students will see it exactly as written. ` +
        `Press Cancel to reword it first, or OK to show it anyway.`)) {
      render(); // puts the menu back
      return;
    }
  }

  const previous = row.status;
  control.disabled = true;

  const { data, error } = await sb.rpc("staff_set_status", { p_id: row.id, p_status: wanted });
  control.disabled = false;

  if (error) {
    toast(error.message, null, true);
    render(); // puts the menu back to what the database still holds
    return;
  }

  Object.assign(row, {
    status: data,
    decided_by: "staff",
    decided_at: new Date().toISOString(),
    reviewer: null, // never shown: who decided is not displayed
  });
  render();

  const g = group(row);
  const hidden = !filters.statuses.has(g);
  toast(
    `#${row.id} moved to ${LABEL[g]}.` + (hidden ? ` Tick ${LABEL[g]} above to see it.` : ""),
    async () => {
      const { error: undoError } = await sb.rpc("staff_set_status", { p_id: row.id, p_status: previous });
      if (undoError) return toast(undoError.message, null, true);
      await load(); // reload so the card shows what the database now records
      toast(`#${row.id} is back in ${LABEL[previous] ?? previous}.`);
    },
  );

  // "Explain the no's": a turned-down student hears why, if staff say.
  if (data === "rejected") askReason(row);
}

// A small dialog after rejecting: one optional sentence for the student,
// shown on their My suggestions page. Skipping is fine.
function askReason(row) {
  const dialog = el("dialog", "reason-dialog");
  const title = el("h3", null, "Tell the student why? (optional)");
  const help = el("p", "hint",
    "One sentence is enough. The student sees it on their My suggestions page. " +
    "They never see who wrote it.");
  const box = el("textarea");
  box.rows = 3;
  box.maxLength = 500;
  box.placeholder = "e.g. This isn't possible because of fire safety rules in the corridors.";
  box.value = row.staff_reason ?? "";
  const status = el("p", "reword-status mono");
  const save = el("button", "qbtn q-approve", "Save reason");
  const skip = el("button", "qbtn", "Skip");
  [save, skip].forEach((b) => (b.type = "button"));
  const buttons = el("div", "quick");
  buttons.append(save, skip);
  dialog.append(title, help, box, buttons, status);
  document.body.append(dialog);

  const close = () => { dialog.close(); dialog.remove(); };
  skip.addEventListener("click", close);
  dialog.addEventListener("cancel", () => dialog.remove()); // Esc key
  save.addEventListener("click", async () => {
    if (!box.value.trim()) return close();
    save.disabled = true;
    const { error } = await sb.rpc("staff_set_reason", { p_id: row.id, p_reason: box.value });
    if (error) {
      save.disabled = false;
      status.textContent = error.message;
      return;
    }
    row.staff_reason = box.value.trim();
    close();
    render();
    toast(`Reason saved. The student will see it.`);
  });

  dialog.showModal();
  box.focus();
}

// ------------------------------------------------------------------ filters

function chip(text, n, on, onClick) {
  const b = el("button", "chip" + (on ? " is-on" : ""));
  b.type = "button";
  b.setAttribute("aria-pressed", String(on));
  b.append(text);
  if (n !== null) b.append(" ", el("span", "n", String(n)));
  b.addEventListener("click", onClick);
  return b;
}

function renderFilters() {
  const countBy = (except, fn) => {
    const counts = new Map();
    rows.filter((r) => matches(r, except)).forEach((r) => {
      const k = fn(r);
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    return counts;
  };

  // Status: multi-select. Toggle any combination.
  const byStatus = countBy("status", group);
  els.fStatus.replaceChildren(...GROUPS.map(({ key, label }) =>
    chip(label, byStatus.get(key) || 0, filters.statuses.has(key), () => {
      filters.statuses.has(key) ? filters.statuses.delete(key) : filters.statuses.add(key);
      changed();
    }),
  ));

  // Category: multi-select, where nothing selected means every category.
  const byCategory = countBy("category", category);
  const all = rows.filter((r) => matches(r, "category")).length;
  // Only categories with something to show, plus any already ticked so they
  // can always be unticked.
  const names = [...new Set(rows.map(category))]
    .filter((name) => byCategory.get(name) || filters.categories.has(name))
    .sort((a, b) => a.localeCompare(b));
  els.fCategory.replaceChildren(
    chip("All", all, filters.categories.size === 0, () => {
      filters.categories.clear();
      changed();
    }),
    ...names.map((name) =>
      chip(name, byCategory.get(name) || 0, filters.categories.has(name), () => {
        filters.categories.has(name) ? filters.categories.delete(name) : filters.categories.add(name);
        changed();
      }),
    ),
  );

  // Decided by: one at a time.
  const bySource = countBy("source", (r) => r.decided_by || "none");
  els.fSource.replaceChildren(...SOURCES.map(({ key, label }) =>
    chip(label, key === "any" ? null : bySource.get(key) || 0, filters.source === key, () => {
      filters.source = key;
      changed();
    }),
  ));
}

function changed() {
  saveFilters();
  render();
}

// ------------------------------------------------------------------ concerns

const concernsEl = $("concerns");
const PAGE_TITLE = document.title;

function concernCard(row, handled) {
  const article = el("article", "concern-card" + (handled ? " is-handled" : ""));

  const head = el("div", "concern-meta mono");
  head.append(el("span", null, `#${row.id}`), el("span", null, `Sent ${when(row.created_at)}`));
  article.append(head, el("p", "concern-text", row.suggestion));

  if (row.benefit) {
    const more = el("p", "concern-more");
    more.append(el("span", "mono", "They also wrote"), el("span", null, row.benefit));
    article.append(more);
  }

  const foot = el("div", "concern-foot");
  if (handled) {
    foot.append(el("span", "mono", `Handled by staff · ${when(row.concern_handled_at)}`));
    foot.append(concernButton(row, "reopen", "Reopen", "c-ghost"));
  } else {
    foot.append(
      concernButton(row, "handled", "Passed to pastoral care — mark handled", "c-primary"),
      concernButton(row, "not_concern", "Not a concern — move to normal queue", "c-ghost"),
    );
  }
  article.append(foot);
  return article;
}

function concernButton(row, outcome, text, cls) {
  const b = el("button", `cbtn ${cls}`, text);
  b.type = "button";
  b.addEventListener("click", async () => {
    if (outcome === "not_concern" && !confirm(
      "Move this to the normal queue? Only do this if it is clearly a suggestion, " +
      "not a student asking for help.")) return;
    b.disabled = true;
    const { error } = await sb.rpc("staff_resolve_concern", { p_id: row.id, p_outcome: outcome });
    if (error) {
      b.disabled = false;
      toast(error.message, null, true);
      return;
    }
    await load();
    toast({
      handled: `#${row.id} marked handled.`,
      not_concern: `#${row.id} moved to the normal queue.`,
      reopen: `#${row.id} is open again.`,
    }[outcome]);
  });
  return b;
}

function renderConcerns() {
  const open = rows.filter((r) => r.concern && !r.concern_handled_at);
  const handled = rows.filter((r) => r.concern && r.concern_handled_at);

  // The browser tab shows it too, so it is seen even from another tab.
  document.title = open.length
    ? `⚠ ${open.length} wellbeing concern${open.length === 1 ? "" : "s"} — ${PAGE_TITLE}`
    : PAGE_TITLE;

  concernsEl.hidden = !open.length && !handled.length;
  concernsEl.classList.toggle("is-open", open.length > 0);
  if (concernsEl.hidden) return;

  const parts = [];
  if (open.length) {
    concernsEl.setAttribute("role", "alert");
    const head = el("div", "concerns-head");
    head.append(
      el("span", "concerns-icon", "!"),
      el("h2", null, open.length === 1
        ? "1 student may need help"
        : `${open.length} students may need help`),
    );
    const guide = el("ul", "concerns-guide");
    for (const line of [
      "This looks like a report of bullying, self-harm, abuse or feeling unsafe, not a suggestion.",
      "Pass it to the Head of Pastoral Care today. If anyone may be in danger, follow the safeguarding procedure now.",
      "It is anonymous: the student cannot be identified or contacted from here. Act on what is written (year, place, time).",
      "It is never shown to students and cannot be approved.",
    ]) guide.append(el("li", null, line));
    parts.push(head, guide, ...open.map((r) => concernCard(r, false)));
  } else {
    concernsEl.removeAttribute("role");
  }

  if (handled.length) {
    const details = el("details", "concerns-handled");
    details.append(el("summary", null, `Handled concerns (${handled.length})`), ...handled.map((r) => concernCard(r, true)));
    parts.push(details);
  }
  concernsEl.replaceChildren(...parts);
}

// ------------------------------------------------------------------ render

function render() {
  renderConcerns();
  renderFilters();

  const shown = rows
    .filter((r) => matches(r))
    .sort((a, b) =>
      (ORDER[group(a)] ?? 9) - (ORDER[group(b)] ?? 9) ||
      new Date(b.created_at) - new Date(a.created_at) ||
      b.id - a.id); // times are rounded to the hour; id breaks ties

  const hiddenBin = rows.filter((r) => !r.concern &&
    ["rejected", "spam"].includes(group(r)) && !filters.statuses.has(group(r))).length;
  els.count.textContent =
    `Showing ${shown.length} of ${rows.filter((r) => !r.concern).length}` +
    (hiddenBin ? ` · ${hiddenBin} rejected or spam hidden` : "");

  if (shown.length) {
    els.list.replaceChildren(...shown.map(card));
    return;
  }

  const pending = rows.filter((r) => !r.concern && r.status === "pending").length;
  const empty = el("div", "empty-state");
  empty.append(
    el("h3", null, filters.statuses.has("pending") && pending === 0
      ? "Queue clear. Nothing is waiting for a decision."
      : "Nothing matches these filters."),
    el("p", "hint", "Change the filters above, or press Refresh to check for new suggestions."),
  );
  els.list.replaceChildren(empty);
}

// ------------------------------------------------------------------ loading

function gate(message, kind = "info") {
  els.gate.textContent = message;
  els.gate.className = `notice ${kind}`;
  els.gate.hidden = false;
  els.board.hidden = true;
  rulesEls.section.hidden = true;
  $("feedback-section").hidden = true;
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
  if (!rulesDirty) await loadRules();
  await loadFeedback();
}

// ------------------------------------------------------------------ site feedback

const KINDS = { broken: "Something's broken", improve: "Improve the site", other: "Something else" };

async function loadFeedback() {
  const section = $("feedback-section");
  const { data, error } = await sb.rpc("staff_feedback");
  if (error) {
    section.hidden = true; // not installed yet
    return;
  }
  section.hidden = false;
  const open = data.filter((f) => !f.handled).length;
  $("feedback-count").textContent = data.length
    ? `${open} new · ${data.length - open} handled`
    : "Nothing yet";

  const list = $("feedback-list");
  if (!data.length) {
    list.replaceChildren(el("li", "hint", "No feedback yet. Students send it from the Feedback link at the bottom of every page."));
    return;
  }
  list.replaceChildren(...data.map((f) => {
    const li = el("li", "feedback-item" + (f.handled ? " is-handled" : ""));
    const head = el("div", "row");
    head.append(
      el("span", `tag kind-${f.kind}`, KINDS[f.kind] ?? f.kind),
      el("span", "hint", `${new Date(f.created_at).toLocaleDateString()}${f.page ? ` · from ${f.page}` : ""}`),
    );
    const done = el("button", "qbtn", f.handled ? "Mark as new" : "Mark handled");
    done.type = "button";
    done.addEventListener("click", async () => {
      done.disabled = true;
      await sb.rpc("staff_mark_feedback", { p_id: f.id, p_handled: !f.handled });
      await loadFeedback();
    });
    li.append(head, el("p", "feedback-text", f.message), done);
    return li;
  }));
}

// ------------------------------------------------------------------ guidelines

const rulesEls = {
  section: $("rules-editor"), form: $("rules-form"), rules: $("rules-text"),
  context: $("context-text"), status: $("rules-status"), save: $("rules-save"),
};
let rulesDirty = false;

function rulesStatus(text, kind = "") {
  rulesEls.status.textContent = text;
  rulesEls.status.className = `mono ${kind}`;
}

function describeSaved(data) {
  const when = data.updated_at ? new Date(data.updated_at).toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }) : "";
  return `Last changed ${when}`; // when, never who
}

async function loadRules() {
  const { data, error } = await sb.rpc("staff_get_rules");
  if (error) {
    // Not installed yet (docs/setup-rules.sql) -- keep the editor hidden
    // rather than showing an empty box someone might save.
    rulesEls.section.hidden = true;
    return;
  }
  rulesEls.rules.value = data.rules ?? "";
  rulesEls.context.value = data.school_context ?? "";
  rulesDirty = false;
  rulesStatus(describeSaved(data));
  rulesEls.section.hidden = false;
}

for (const box of [rulesEls.rules, rulesEls.context]) {
  box.addEventListener("input", () => {
    rulesDirty = true;
    rulesStatus("Unsaved changes", "dirty");
  });
}

rulesEls.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  rulesEls.save.disabled = true;
  rulesStatus("Saving…");
  const { data, error } = await sb.rpc("staff_set_rules", {
    p_rules: rulesEls.rules.value,
    p_school_context: rulesEls.context.value,
  });
  rulesEls.save.disabled = false;
  if (error) {
    rulesStatus(error.message, "error");
    return;
  }
  rulesDirty = false;
  rulesStatus("Saved. The next suggestion uses these. " + describeSaved(data));
});

// Losing an edit to a stray click is easy with boxes this long.
window.addEventListener("beforeunload", (event) => {
  if (rulesDirty) event.preventDefault();
});

// Extra sign-in buttons in the page body, alongside the nav one.
const heroSignIns = [...document.querySelectorAll("[data-signin]")];
heroSignIns.forEach((b) => b.addEventListener("click", signIn));

els.refresh.addEventListener("click", async () => {
  els.refresh.disabled = true;
  await load();
  els.refresh.disabled = false;
});

watchSession(async (newSession) => {
  session = newSession;
  heroSignIns.forEach((b) => (b.hidden = !!session));
  if (!session) {
    gate("Sign in with your staff Google account to review suggestions.");
    return;
  }
  await load();
});
