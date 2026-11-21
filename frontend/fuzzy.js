// Forgiving search: "canten", "libary" and "basktball" still find what the
// student meant. Every word typed has to match a word in the suggestion,
// exactly, as the start of a word, or within a small number of typos.

const SKIP = new Set(["a", "an", "the", "to", "of", "and", "or", "in", "on", "for", "is", "be", "at", "we", "it"]);

const words = (text) => (text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

// Typos allowed grow with the word: none for short words, then one, then two.
const allowed = (n) => (n <= 3 ? 0 : n <= 6 ? 1 : 2);

// Edit distance, counting a swapped pair of letters ("teh") as one typo.
// Gives up early once it is past the limit.
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > limit) return limit + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

// How well one typed word matches one word of the text (0 = not at all).
function wordScore(q, w) {
  if (q === w) return 4;
  if (w.startsWith(q)) return 3; // still typing
  if (q.length >= 3 && w.includes(q)) return 2;
  const limit = allowed(q.length);
  if (!limit) return 0;
  if (distance(q, w, limit) <= limit) return 1.5;
  // A typo in a word that is still being typed: "basktb" for "basketball".
  if (w.length > q.length && distance(q, w.slice(0, q.length), limit) <= limit) return 1;
  return 0;
}

// Splits what the student typed into the words worth looking for.
export function searchTerms(query) {
  const all = words(query);
  const kept = all.filter((q) => !SKIP.has(q));
  return kept.length ? kept : all;
}

// 0 when the texts don't match every term, higher the closer the match.
export function fuzzyScore(terms, texts) {
  if (!terms.length) return 1;
  const pool = [...new Set(texts.flatMap(words))];
  let total = 0;
  for (const q of terms) {
    let best = 0;
    for (const w of pool) {
      best = Math.max(best, wordScore(q, w));
      if (best === 4) break;
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}
