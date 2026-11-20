// "From your head to done" on the home page: a small jet flies past each
// stop, lighting it, with a loop on the way, a constant gentle rock from
// side to side, and a trail that follows exactly where it has been. Drawn
// on a canvas behind the stops, in the site's own ink and orange, so it sits
// inside the design rather than on top of it.
//
// Without this script (or with reduce-motion on) the CSS shows the finished
// picture instead.

const journey = document.querySelector(".journey");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (journey && !reduceMotion) start();

function start() {
  const stops = [...journey.querySelectorAll(".stop")];
  const dots = stops.map((s) => s.querySelector(".stop-dot"));
  const fill = journey.querySelector(".journey-fill");
  const canvas = document.createElement("canvas");
  canvas.className = "journey-sky";
  canvas.setAttribute("aria-hidden", "true");
  journey.prepend(canvas);
  journey.classList.add("is-live");
  const ctx = canvas.getContext("2d");

  const DUR = 12000; // one flight, ms
  // When the jet reaches each stop (fraction of the flight), and when it is
  // gone off the far side.
  const AT = [0.05, 0.22, 0.42, 0.62, 0.8];
  const GONE = 0.92;
  const TRAIL_MS = 1400;

  const css = getComputedStyle(document.documentElement);
  const INK = css.getPropertyValue("--ink").trim() || "#1A1A1A";
  const WING = "#3D3B37";
  const CREAM = css.getPropertyValue("--cream").trim() || "#F5F2ED";
  const ACCENT = css.getPropertyValue("--accent").trim() || "#D96C35";

  let W = 0, H = 0, dpr = 1;
  let points = []; // stop centres in canvas pixels
  let dir = { x: 1, y: 0 }; // direction of travel
  let up = { x: 0, y: -1 }; // the jet's "up" (loops and climbs go this way)
  let loopR = 46;
  let trail = [];
  let visible = true;
  let raf = 0;
  let lastP = 0;

  function measure() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    points = dots.map((d) => {
      const b = d.getBoundingClientRect();
      return { x: b.left + b.width / 2 - r.left, y: b.top + b.height / 2 - r.top };
    });
    const a = points[0], b = points[points.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    // Left-hand normal: up when flying right, to the right when flying down.
    up = { x: dir.y, y: -dir.x };
    loopR = dir.x > 0.5 ? 46 : 21; // on phones, keep clear of the step text
    trail = [];
  }

  const ease = (t) => t * t * (3 - 2 * t);
  const clamp01 = (t) => Math.max(0, Math.min(1, t));

  // Where the jet is at flight fraction p, before any manoeuvre: straight
  // through each stop centre, arriving on time.
  function base(p) {
    const lead = 170;
    const first = { x: points[0].x - dir.x * lead, y: points[0].y - dir.y * lead };
    const last = points[points.length - 1];
    const off = { x: last.x + dir.x * 260, y: last.y + dir.y * 260 };
    const keys = [[0, first], ...AT.map((t, i) => [t, points[i]]), [GONE, off]];
    for (let i = 1; i < keys.length; i++) {
      if (p <= keys[i][0]) {
        const [t0, a] = keys[i - 1];
        const [t1, b] = keys[i];
        const k = (p - t0) / (t1 - t0);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
    }
    return off;
  }

  // The flight path: base position plus the manoeuvres, worked out in the
  // jet's own frame (along = forward, lift = up) so the same flight works
  // across a laptop screen and down a phone.
  function pos(p) {
    const b = base(p);
    let along = 0;
    let lift = 0;
    // Loop-the-loop between "AI checks it" and "Staff decide".
    const L0 = 0.27, L1 = 0.37;
    if (p > L0 && p < L1) {
      const th = 2 * Math.PI * ease((p - L0) / (L1 - L0));
      along += loopR * Math.sin(th);
      lift += loopR * (1 - Math.cos(th));
    }
    // A pull-up and dive before "Students vote".
    if (p > 0.5 && p < 0.6) lift += (dir.x > 0.5 ? 26 : 14) * Math.sin(Math.PI * (p - 0.5) / 0.1);
    // A low, lazy weave the rest of the time.
    lift += 5 * Math.sin(p * Math.PI * 14);
    // Climb out after "Done".
    if (p > AT[4]) lift += 420 * ((p - AT[4]) / (GONE - AT[4])) ** 2;
    return { x: b.x + dir.x * along + up.x * lift, y: b.y + dir.y * along + up.y * lift };
  }

  function drawJet(x, y, angle, roll, burn) {
    const s = dir.x > 0.5 ? 1.3 : 1.05; // a little smaller on phones
    const c = Math.cos(roll), sn = Math.sin(roll);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(s, s);
    // Drawn nose to the right, centred on the fuselage. Rolling shows the
    // wing below (rolled one way) or above (the other), and squashes the
    // fin and canopy as they turn away.

    // Afterburner flame.
    const flame = (9 + Math.random() * 5) * (1 + burn * 1.6);
    const g = ctx.createLinearGradient(-30, 0, -30 - flame, 0);
    g.addColorStop(0, "#FFE7A3");
    g.addColorStop(0.35, ACCENT);
    g.addColorStop(1, "rgba(217,108,53,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-29, -2.2);
    ctx.lineTo(-30 - flame, 0);
    ctx.lineTo(-29, 2.2);
    ctx.fill();

    // A delta wing seen slightly from above: the near wing always shows
    // below the body and grows and shrinks as the jet rocks; rolled the
    // other way, the far wing tips up into view above it.
    const wing = (tip, colour) => {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.moveTo(8, 1);
      ctx.lineTo(-13, 1);
      ctx.lineTo(-19, 1 + tip);
      ctx.lineTo(-12, 1 + tip);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath(); // tailplane
      ctx.moveTo(-20, 1);
      ctx.lineTo(-30, 1);
      ctx.lineTo(-29, 1 + tip * 0.5);
      ctx.lineTo(-25, 1 + tip * 0.5);
      ctx.closePath();
      ctx.fill();
    };
    if (sn < -0.12) wing(14 * sn, WING);

    // Tail fin, leaning as it rolls.
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(-29, -2);
    ctx.lineTo(-26 + 3 * sn, -2 - 12 * c);
    ctx.lineTo(-20 + 3 * sn, -2 - 12 * c);
    ctx.lineTo(-11, -2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = ACCENT; // the stripe on the fin
    ctx.beginPath();
    ctx.moveTo(-25 + 2.2 * sn, -2 - 9 * c);
    ctx.lineTo(-21.5 + 2.2 * sn, -2 - 9 * c);
    ctx.lineTo(-17.5 + 0.8 * sn, -2 - 3 * c);
    ctx.lineTo(-21 + 0.8 * sn, -2 - 3 * c);
    ctx.closePath();
    ctx.fill();

    // Fuselage, nose to the right.
    const h = 3.2 + 0.6 * Math.abs(c);
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(-30, -h);
    ctx.lineTo(12, -h);
    ctx.quadraticCurveTo(26, -h * 0.7, 32, 0);
    ctx.quadraticCurveTo(26, h * 0.7, 12, h);
    ctx.lineTo(-30, h);
    ctx.closePath();
    ctx.fill();

    // Canopy.
    ctx.fillStyle = CREAM;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.ellipse(14, -h + 0.3, 7.5, 3.4 * Math.max(0.4, Math.abs(c)), 0, Math.PI, 0);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Near wing, drawn over the body, in the slightly lighter ink.
    wing(4 + 9 * Math.max(0, sn + 0.1), WING);
    ctx.restore();
  }

  function drawTrail(now) {
    trail = trail.filter((t) => now - t.t < TRAIL_MS);
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      if (b.t - a.t > 120) continue; // a gap (tab was hidden): don't join
      const life = 1 - (now - b.t) / TRAIL_MS;
      ctx.strokeStyle = `rgba(217,108,53,${(0.5 * life).toFixed(3)})`;
      ctx.lineWidth = 0.8 + 2.6 * life;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function frame(now) {
    raf = 0;
    if (!visible) return;
    const p = (now % DUR) / DUR;
    if (p < lastP) trail = []; // a new flight
    lastP = p;

    // The stops light as the jet passes; the line fills behind it.
    stops.forEach((s, i) => s.classList.toggle("on", p >= AT[i] && p < 0.97));
    stops[4].classList.toggle("stamped", p >= AT[4] + 0.01 && p < 0.97);
    let k = 0;
    for (let i = 0; i < 4; i++) k += clamp01((p - AT[i]) / (AT[i + 1] - AT[i]));
    const pct = p < 0.97 ? `${(k / 4) * 80}%` : "0%";
    if (dir.x > 0.5) { fill.style.width = pct; fill.style.height = ""; }
    else { fill.style.height = pct; fill.style.width = ""; }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const here = pos(p);
    const ahead = pos(Math.min(p + 0.002, 0.999));
    const angle = Math.atan2(ahead.y - here.y, ahead.x - here.x);
    // Rock left, right, left, right...: about 30 degrees each way.
    const roll = 0.52 * Math.sin((now / 1700) * Math.PI * 2);
    const burn = clamp01((p - AT[4]) / 0.04);
    // The trail starts at the tail, not the middle of the jet.
    const back = (dir.x > 0.5 ? 1.3 : 1.05) * 30;
    if (p < GONE) {
      trail.push({ x: here.x - Math.cos(angle) * back, y: here.y - Math.sin(angle) * back, t: now });
    }
    drawTrail(now);
    if (p < GONE) {
      ctx.globalAlpha = clamp01(p / 0.02);
      drawJet(here.x, here.y, angle, roll, burn);
      ctx.globalAlpha = 1;
    }
    raf = requestAnimationFrame(frame);
  }

  function run() {
    if (!raf && visible) raf = requestAnimationFrame(frame);
  }

  // Only animate while the section is on screen.
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) { measure(); run(); }
  }).observe(journey);

  let t = 0;
  addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(measure, 150);
  });
  measure();
  run();
}
