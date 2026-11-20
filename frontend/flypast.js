// First visit only: a big jet streaks across the top of the home page on
// afterburner, leaving a contrail, and is gone in about two and a half
// seconds. It never blocks anything: it lets clicks through, and any click,
// tap or key ends it at once. Add ?flypast to the address to see it again.

const SVG = "http://www.w3.org/2000/svg";
const KEY = "flypast-seen";
const forced = new URLSearchParams(location.search).has("flypast");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function seen() {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
function remember() {
  try { localStorage.setItem(KEY, "1"); } catch { /* a convenience only */ }
}

// Build an SVG element tree from a compact description, without innerHTML.
function svg(tag, attrs = {}, kids = []) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  kids.forEach((k) => node.append(k));
  return node;
}
const stop = (offset, color, opacity = 1) =>
  svg("stop", { offset, "stop-color": color, "stop-opacity": opacity });

// A generic fighter, side on, nose to the right. viewBox 0 0 640 200.
function jetArt() {
  const defs = svg("defs", {}, [
    svg("linearGradient", { id: "fp-body", x1: 0, y1: 0, x2: 0, y2: 1 }, [
      stop("0", "#C9D0D8"), stop("0.35", "#8C96A1"), stop("0.7", "#5E6873"), stop("1", "#3A424B"),
    ]),
    svg("linearGradient", { id: "fp-wing", x1: 0, y1: 0, x2: 0, y2: 1 }, [
      stop("0", "#6F7984"), stop("1", "#3B434C"),
    ]),
    svg("linearGradient", { id: "fp-fin", x1: 0, y1: 0, x2: 1, y2: 1 }, [
      stop("0", "#A7B0BA"), stop("1", "#56606B"),
    ]),
    svg("linearGradient", { id: "fp-canopy", x1: 0, y1: 0, x2: 0, y2: 1 }, [
      stop("0", "#E4F6FF"), stop("0.45", "#6FB3DD"), stop("1", "#173A55"),
    ]),
    svg("linearGradient", { id: "fp-flame", x1: 1, y1: 0, x2: 0, y2: 0 }, [
      stop("0", "#FFFFFF"), stop("0.12", "#FFF1B8"), stop("0.35", "#FFB347"),
      stop("0.7", "#E8622C", 0.8), stop("1", "#E8622C", 0),
    ]),
    svg("radialGradient", { id: "fp-glow", cx: 0.5, cy: 0.5, r: 0.5 }, [
      stop("0", "#FFB347", 0.75), stop("1", "#FFB347", 0),
    ]),
    svg("linearGradient", { id: "fp-shine", x1: 0, y1: 0, x2: 1, y2: 0 }, [
      stop("0", "#FFFFFF", 0), stop("0.5", "#FFFFFF", 0.55), stop("1", "#FFFFFF", 0),
    ]),
  ]);

  const panel = { fill: "none", stroke: "#1E242B", "stroke-opacity": 0.35, "stroke-width": 1.2 };
  return svg("svg", { viewBox: "0 0 640 200", class: "fp-jet", "aria-hidden": "true" }, [
    defs,
    // afterburner glow and flame (behind everything)
    svg("ellipse", { class: "fp-glow", cx: 40, cy: 100, rx: 70, ry: 38, fill: "url(#fp-glow)" }),
    svg("path", { class: "fp-flame", d: "M44 88 C10 90 -60 96 -150 100 C-60 104 10 110 44 112 Z", fill: "url(#fp-flame)" }),
    svg("path", { class: "fp-flame fp-flame-core", d: "M44 93 C20 95 -10 98 -60 100 C-10 102 20 105 44 107 Z", fill: "#FFFDF0" }),
    // far tailplane and wing (darker, behind the body)
    svg("path", { d: "M120 92 L60 70 L40 70 L80 96 Z", fill: "#4A535D" }),
    svg("path", { d: "M330 90 L250 58 L215 58 L260 92 Z", fill: "#4A535D" }),
    // vertical fin
    svg("path", { d: "M70 92 L104 18 L150 18 L205 88 Z", fill: "url(#fp-fin)" }),
    svg("path", { d: "M112 34 L140 34 L176 78 L146 78 Z", fill: "#D96C35" }),
    svg("path", { d: "M104 18 L150 18 L152 24 L106 24 Z", fill: "#1E242B", opacity: 0.5 }),
    // fuselage
    svg("path", {
      d: "M46 90 L160 82 L330 76 Q470 74 548 88 Q590 96 628 100 Q590 104 548 110 Q470 122 330 120 L160 116 L46 110 Z",
      fill: "url(#fp-body)",
    }),
    // spine highlight
    svg("path", { d: "M170 83 L330 78 Q460 76 540 88", fill: "none", stroke: "url(#fp-shine)", "stroke-width": 3 }),
    // intake
    svg("path", { d: "M318 118 L408 116 L398 138 L330 140 Z", fill: "#2C333B" }),
    svg("path", { d: "M398 116 L408 116 L398 138 L392 138 Z", fill: "#11161B" }),
    // canopy and frame
    svg("path", { d: "M420 80 Q470 42 536 84 Q490 86 420 80 Z", fill: "url(#fp-canopy)" }),
    svg("path", { d: "M440 70 Q472 52 505 62", fill: "none", stroke: "#FFFFFF", "stroke-opacity": 0.7, "stroke-width": 3, "stroke-linecap": "round" }),
    svg("path", { d: "M478 54 L470 82", fill: "none", stroke: "#1E242B", "stroke-opacity": 0.6, "stroke-width": 2 }),
    // nose cone tip
    svg("path", { d: "M588 95 Q610 98 628 100 Q610 102 588 105 Z", fill: "#2C333B" }),
    // panel lines
    svg("path", { ...panel, d: "M200 82 L200 116 M262 79 L262 118 M360 76 L360 120 M548 89 L548 109" }),
    svg("path", { ...panel, d: "M170 100 L560 100", "stroke-dasharray": "0" }),
    // near wing and tailplane (over the body)
    svg("path", { d: "M350 112 L190 116 L130 168 L215 168 Z", fill: "url(#fp-wing)" }),
    svg("path", { d: "M350 112 L190 116 L186 120 L344 116 Z", fill: "#FFFFFF", opacity: 0.18 }),
    svg("path", { d: "M128 110 L56 112 L30 146 L84 144 Z", fill: "url(#fp-wing)" }),
    // missile under the wing
    svg("path", { d: "M188 172 L300 172 Q314 175 318 176 Q314 177 300 180 L188 180 Z", fill: "#E9ECEF" }),
    svg("path", { d: "M188 172 L178 166 L176 186 L188 180 Z", fill: "#9AA3AC" }),
    svg("path", { d: "M300 172 L308 172 L308 180 L300 180 Z", fill: "#D96C35" }),
    // nozzle
    svg("rect", { x: 34, y: 89, width: 20, height: 22, rx: 4, fill: "#23282E" }),
    svg("path", { d: "M40 89 L40 111 M47 89 L47 111", stroke: "#4A525B", "stroke-width": 1.5 }),
    // school marking on the fin
    svg("text", { x: 150, y: 70, fill: "#FFFFFF", "font-family": "Inter Tight, Arial, sans-serif", "font-weight": 800, "font-size": 15, "letter-spacing": 1, transform: "rotate(0)" }, ["DPSI"]),
  ]);
}

function fly() {
  remember();
  const layer = document.createElement("div");
  layer.className = "flypast";
  layer.setAttribute("aria-hidden", "true");
  const craft = document.createElement("div");
  craft.className = "fp-craft";
  const trail = document.createElement("div");
  trail.className = "fp-trail";
  const body = document.createElement("div");
  body.className = "fp-body";
  body.append(jetArt());
  craft.append(trail, body);
  layer.append(craft);
  document.body.append(layer);

  const vw = innerWidth, vh = innerHeight;
  const w = Math.min(Math.max(vw * 0.62, 340), 820); // big, but never wider than the screen allows
  craft.style.width = `${w}px`;
  craft.style.height = `${w * (200 / 640)}px`;
  const h = w * (200 / 640);

  // A shallow climbing arc across the top of the page, steady speed.
  const y0 = Math.min(vh * 0.62, 560), y1 = Math.max(vh * 0.04, 20);
  const frames = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = -w * 1.1 + (vw + w * 1.6) * t;
    const y = y0 + (y1 - y0) * (t * t * 0.55 + t * 0.45) - h / 2;
    const slope = (y1 - y0) * (2 * t * 0.55 + 0.45) / (vw + w * 1.6);
    const angle = Math.atan(slope) * (180 / Math.PI);
    frames.push({ transform: `translate(${x}px, ${y}px) rotate(${angle}deg)` });
  }
  const DUR = 2400;
  const motion = craft.animate(frames, { duration: DUR, easing: "linear", fill: "forwards" });
  // A gentle rock while it passes.
  body.animate(
    [{ transform: "rotate(-2deg) scaleY(1)" }, { transform: "rotate(1.5deg) scaleY(0.94)" }, { transform: "rotate(-1.5deg) scaleY(1)" }],
    { duration: 1200, iterations: 2, easing: "ease-in-out", direction: "alternate" },
  );
  layer.animate([{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: DUR + 500, fill: "forwards" });

  const end = () => {
    removeEventListener("pointerdown", end, true);
    removeEventListener("keydown", end, true);
    removeEventListener("wheel", end, true);
    layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" })
      .finished.then(() => layer.remove());
  };
  addEventListener("pointerdown", end, true);
  addEventListener("keydown", end, true);
  addEventListener("wheel", end, true);
  motion.finished.then(() => setTimeout(end, 300));
}

if (!reduceMotion && (forced || !seen())) {
  // Start once the page has painted, so the flypast is seen, not missed.
  requestAnimationFrame(() => setTimeout(fly, 350));
}
