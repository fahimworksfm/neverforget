/* ==========================================================================
   Release
   The moment the timesheet is confirmed. Everything else in the app pushes;
   this is the one place it gives something back: the screen turns from
   whatever colour the pressure had reached to mint, "Done." lands like a
   stamp, and the streak ticks up.

   Plays only after the server has recorded the confirm -- celebrating a
   confirm that did not land would be worse than no animation at all.
   ========================================================================== */

(() => {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const $ = (id) => document.getElementById(id);

  function countUp(el, from, to) {
    if (!(to > from)) return;
    el.textContent = String(from);
    const start = performance.now() + 550;
    const dur = 500;
    (function tick(now) {
      const t = Math.max(0, Math.min(1, (now - start) / dur));
      el.textContent = String(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
      if (t < 1) requestAnimationFrame(tick);
    })(performance.now());
    el.classList.remove('is-pop');
    void el.offsetWidth;
    el.classList.add('is-pop');
  }

  // before: { streak } captured from the screen just before the confirm
  // re-rendered it.
  function play(before = {}) {
    const hero = document.querySelector('.hero');
    if (!hero) return;

    navigator.vibrate?.([14, 70, 28]);
    if (reducedMotion.matches) return;

    hero.classList.remove('is-releasing');
    void hero.offsetWidth;
    hero.classList.add('is-releasing');
    setTimeout(() => hero.classList.remove('is-releasing'), 900);

    countUp($('streak'), before.streak, Number($('streak').textContent));
  }

  window.release = { play };
})();
