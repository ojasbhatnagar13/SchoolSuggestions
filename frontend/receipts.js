// Private receipts: tell a student what happened to their idea, without the
// idea ever being linked to their account.
//
// When an idea is sent, this browser makes a random code and keeps it here.
// The database stores only a hash of the code next to the idea. On later
// visits the browser asks about the codes it holds and shows a banner when
// something has changed. The codes never leave this browser except to ask
// about their own ideas, so this works on this device only -- clearing site
// data or switching laptops loses them, and that is the price of anonymity.
import { sb, el } from "./common.js";

const KEY = "suggestion-receipts";
const MAX_KEPT = 30;

const MESSAGES = {
  approved: {
    title: "Approved for voting",
    body: "Staff approved your idea. It's on the Ideas page now for everyone to back.",
    link: true,
  },
  done: {
    title: "Done",
    body: "The school has acted on your idea. Thank you for suggesting it.",
    link: true,
  },
  not_taken_forward: {
    title: "Not taken forward",
    body: "Staff read your idea and decided not to take it forward this time.",
    link: false,
  },
};

// Receipts are a convenience: if storage is blocked, there are simply none.
function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function store(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_KEPT)));
  } catch { /* not kept */ }
}

export function newReceipt() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// `status` is what the student was already told when they sent it, so the
// banner only appears for something new: an AI rejection they saw at the
// time is not repeated, but staff later approving it is shown.
export function rememberReceipt(code, id, text, status) {
  const seen = { rejected: "not_taken_forward", spam: "not_taken_forward" }[status] ?? "waiting";
  const list = load().filter((r) => r.code !== code);
  list.push({ code, id, text: text.slice(0, 140), seen });
  store(list);
}

export async function showReceiptUpdates() {
  const list = load();
  if (!list.length) return;

  const { data, error } = await sb.rpc("receipt_statuses", { p_receipts: list.map((r) => r.code) });
  if (error || !data) return;

  const now = new Map(data.map((row) => [row.id, row.status]));
  const updates = list.filter((r) => {
    const status = now.get(r.id);
    return status && status !== "waiting" && status !== r.seen && MESSAGES[status];
  });
  if (!updates.length) return;

  const banner = el("section", "receipts");
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-label", "Updates on your ideas");
  const wrap = el("div", "wrap receipts-inner");

  const items = el("div", "receipt-list");
  for (const r of updates) {
    const status = now.get(r.id);
    const msg = MESSAGES[status];
    const item = el("div", `receipt receipt-${status}`);
    const text = el("div");
    text.append(
      el("span", "receipt-title", msg.title),
      el("p", "receipt-idea", `“${r.text}”`),
      el("p", "receipt-body", msg.body),
    );
    item.append(text);
    if (msg.link && !location.pathname.endsWith("ideas.html")) {
      const a = el("a", "receipt-link", "See it →");
      a.href = "ideas.html";
      item.append(a);
    }
    items.append(item);
  }

  const ok = el("button", "btn btn-ghost btn-sm receipt-dismiss", "Got it");
  ok.type = "button";
  ok.addEventListener("click", () => {
    // Remember what was shown. Finished ones (done, not taken forward) are
    // dropped entirely; approved ones are kept in case they become Done.
    const shown = new Set(updates.map((r) => r.id));
    store(load()
      .map((r) => (shown.has(r.id) ? { ...r, seen: now.get(r.id) } : r))
      .filter((r) => !["done", "not_taken_forward"].includes(r.seen)));
    banner.remove();
  });

  const head = el("div", "receipts-head");
  head.append(el("p", "eyebrow", updates.length === 1 ? "News about your idea" : "News about your ideas"), ok);
  wrap.append(head, items);
  banner.append(wrap);
  document.querySelector(".nav")?.after(banner);
}
