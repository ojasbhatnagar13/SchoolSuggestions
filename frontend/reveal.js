// Sections ease up into place as they scroll into view, a few at a time.
// Only when the script runs and the device allows motion, so nothing is ever
// left hidden without it. The journey (jet) section is left alone: its
// canvas measures the stops and must not see them mid-slide.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!reduceMotion && "IntersectionObserver" in window) {
  const SKIP = ".journey, .journey-band, .board, #list, #home-state, .filters, .search, .new-note, [role=dialog]";
  const targets = [
    ...document.querySelectorAll("main .wrap > :not(.choice-grid):not(.tiles):not(.steps)"),
    ...document.querySelectorAll(".choice-grid > *, .tiles > *, .steps > *"),
  ].filter((e) => !e.matches(SKIP) && !e.closest(".journey-band"));

  document.documentElement.classList.add("reveal-on");
  for (const e of targets) {
    e.classList.add("reveal");
    // Neighbours follow one another by a beat, at most five beats.
    const row = [...e.parentElement.children].filter((c) => targets.includes(c));
    e.style.setProperty("--d", `${Math.min(row.indexOf(e), 5) * 80}ms`);
  }

  const seen = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = en.target;
      el.classList.add("in");
      // Once settled, step aside so hover effects can move it again.
      el.addEventListener("transitionend", () => el.classList.remove("reveal", "in"), { once: true });
      seen.unobserve(en.target);
    }
  }, { rootMargin: "0px 0px -6% 0px" });
  targets.forEach((e) => seen.observe(e));
}
