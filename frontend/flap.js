// The split-flap board on the home page: letters clatter into place like an
// old station departures board, cycling through real suggestions (Done ones
// first). Only real data -- when there is none to show, it explains the box.
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ROWS = 4; // one status row, three rows of text
const HOLD_MS = 6000; // how long each message stays up
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const SPACE = " ";

// Break text into at most `rows` lines of `cols` characters, on word breaks
// where possible, with "..." if it doesn't all fit.
function wrap(text, cols, rows) {
  const words = text.toUpperCase().replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (let word of words) {
    while ([...word].length > cols) { // a very long word: hard split
      if (line) { lines.push(line); line = ""; }
      lines.push([...word].slice(0, cols).join(""));
      word = [...word].slice(cols).join("");
    }
    const next = line ? `${line} ${word}` : word;
    if ([...next].length <= cols) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > rows) {
    lines.length = rows;
    const last = [...lines[rows - 1]];
    lines[rows - 1] = (last.length > cols - 3 ? last.slice(0, cols - 3).join("") : last.join("")) + "...";
  }
  return lines;
}

export function createBoard(frame, board) {
  let cols = 0;
  let cells = [];
  let messages = [];
  let index = 0;
  let timer = 0;
  let raf = 0;

  function layout() {
    const style = getComputedStyle(board);
    const size = parseFloat(style.getPropertyValue("--cell")) || 26;
    const gap = parseFloat(style.getPropertyValue("--gap")) || 4;
    const pad = parseFloat(getComputedStyle(frame).paddingLeft) * 2;
    const n = Math.max(10, Math.min(22, Math.floor((frame.clientWidth - pad + gap) / (size + gap))));
    if (n === cols) return false;
    cols = n;
    board.style.setProperty("--cols", String(cols));
    cells = Array.from({ length: ROWS * cols }, (_, i) => {
      const c = document.createElement("span");
      c.className = "flap" + (i < cols ? " flap-head" : "");
      c.textContent = SPACE;
      c.ch = " ";
      return c;
    });
    board.replaceChildren(...cells);
    return true;
  }

  function targetFor([status, text]) {
    const rows = [status.toUpperCase(), ...wrap(text, cols, ROWS - 1)];
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      const chars = [...(rows[r] ?? "")];
      for (let c = 0; c < cols; c++) out.push(chars[c] ?? " ");
    }
    return out;
  }

  function tick(now) {
    let busy = false;
    for (const c of cells) {
      if (!c.queue) continue;
      busy = true;
      if (now < c.at) continue;
      const ch = c.queue.shift();
      c.ch = ch;
      c.textContent = ch === " " ? SPACE : ch;
      // Two identical animations under different names, so swapping between
      // them restarts the flip without forcing a layout.
      c.dataset.f = c.dataset.f === "a" ? "b" : "a";
      c.at = now + 65;
      if (!c.queue.length) c.queue = null;
    }
    raf = busy ? requestAnimationFrame(tick) : 0;
  }

  function show(message) {
    board.dataset.kind = message[2] || "info";
    board.setAttribute("aria-label", `${message[0]}: ${message[1]}`);
    const target = targetFor(message);
    const start = performance.now();
    cells.forEach((c, i) => {
      const want = target[i];
      if (c.ch === want) { c.queue = null; return; }
      if (reduceMotion) {
        c.ch = want;
        c.textContent = want === " " ? SPACE : want;
        return;
      }
      const spins = 2 + Math.floor(Math.random() * 5);
      c.queue = Array.from({ length: spins }, () => CHARS[Math.floor(Math.random() * CHARS.length)]);
      c.queue.push(want);
      // A wave from left to right, row by row.
      c.at = start + (i % cols) * 26 + Math.floor(i / cols) * 80;
    });
    if (!reduceMotion && !raf) raf = requestAnimationFrame(tick);
  }

  function next() {
    clearTimeout(timer);
    if (!messages.length) return;
    if (!document.hidden) {
      show(messages[index % messages.length]);
      index++;
    }
    if (messages.length > 1) timer = setTimeout(next, HOLD_MS);
  }

  let resizeTimer = 0;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (layout() && messages.length) show(messages[(index - 1 + messages.length) % messages.length]);
    }, 200);
  });

  layout();

  // messages: [status, text, kind] where kind colours the status row.
  return function setMessages(list) {
    const same = JSON.stringify(list) === JSON.stringify(messages);
    if (same) return;
    messages = list;
    index = 0;
    next();
  };
}
