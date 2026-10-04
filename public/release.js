/* ==========================================================================
   Release
   The moment the timesheet is confirmed. Everything else in the app pushes;
   this is the one place it gives something back, so the tap that ends the
   week should feel like letting go of something rather than ticking a box.

   Plays only after the server has recorded the confirm -- celebrating a
   confirm that did not land would be worse than no animation at all.

   Optional: a generated clip played over the dial. Render it on pure black;
   it is composited with `screen`, so black disappears and only light shows.
   ========================================================================== */

(() => {
  // e.g. { webm: '/ambient/release.webm', mp4: '/ambient/release.mp4' }
  const VIDEO = null;

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const $ = (id) => document.getElementById(id);

  let video = null;
  if (VIDEO) {
    video = document.createElement('video');
    video.className = 'release-video';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-hidden', 'true');
    for (const [type, src] of Object.entries(VIDEO)) {
      if (!src) continue;
      const source = document.createElement('source');
      source.src = src;
      source.type = `video/${type}`;
      video.append(source);
    }
  }

  // ------------------------------------------------------------ sparks

  function sparks(dial, color) {
    const box = dial.getBoundingClientRect();
    const pad = box.width * 0.6;
    const dpr = Math.min(devicePixelRatio || 1, 2);

    const canvas = document.createElement('canvas');
    canvas.className = 'release-sparks';
    canvas.setAttribute('aria-hidden', 'true');
    const w = box.width + pad * 2;
    Object.assign(canvas.style, { left: `${-pad}px`, top: `${-pad}px`, width: `${w}px`, height: `${w}px` });
    canvas.width = w * dpr;
    canvas.height = w * dpr;
    dial.append(canvas);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    // Born on the ring itself (r = 92 of the 200-unit viewBox) and thrown
    // outward with a little spin, as if the ring shed them.
    const c = w / 2;
    const ring = box.width * 0.46;
    const parts = Array.from({ length: 56 }, () => {
      const a = Math.random() * Math.PI * 2;
      const v = 90 + Math.random() * 260;
      const spin = (Math.random() - 0.5) * 80;
      return {
        x: c + Math.cos(a) * ring,
        y: c + Math.sin(a) * ring,
        vx: Math.cos(a) * v - Math.sin(a) * spin,
        vy: Math.sin(a) * v + Math.cos(a) * spin,
        life: 0.7 + Math.random() * 0.7,
        size: 0.8 + Math.random() * 1.8,
        white: Math.random() < 0.3,
      };
    });

    let last = performance.now();
    let age = 0;
    (function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      age += dt;
      ctx.clearRect(0, 0, w, w);

      let alive = 0;
      for (const p of parts) {
        const t = age / p.life;
        if (t >= 1) continue;
        alive++;
        const px = p.x;
        const py = p.y;
        const drag = Math.exp(-dt * 2.6);
        p.vx *= drag;
        p.vy *= drag;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.globalAlpha = (1 - t) * (1 - t);
        ctx.strokeStyle = p.white ? '#ffffff' : color;
        ctx.lineWidth = p.size * (1 - t * 0.5);
        ctx.beginPath();
        ctx.moveTo(px - p.vx * 0.03, py - p.vy * 0.03);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }

      if (alive) requestAnimationFrame(frame);
      else canvas.remove();
    })(last);
  }

  // ------------------------------------------------------------- count

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

  // -------------------------------------------------------------- play

  // before: { text, streak } captured from the screen just before the confirm
  // re-rendered it. The countdown being replaced is drawn as a ghost that
  // dissolves while "Done" rises through it.
  function play(before = {}) {
    const focus = document.querySelector('.focus');
    const dial = document.querySelector('.dial');
    if (!focus || !dial) return;

    navigator.vibrate?.([14, 70, 28]);

    if (reducedMotion.matches) return;

    const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#34d399';

    if (before.text) {
      const value = $('countdown');
      const ghost = document.createElement('div');
      ghost.className = 'dial-value dial-ghost';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.textContent = before.text;
      ghost.style.top = `${value.offsetTop}px`;
      value.parentElement.append(ghost);
      ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
    }

    focus.classList.remove('is-releasing');
    void focus.offsetWidth;
    focus.classList.add('is-releasing');
    setTimeout(() => focus.classList.remove('is-releasing'), 2400);

    window.ambience?.release();
    sparks(dial, accent);

    if (video) {
      dial.append(video);
      video.currentTime = 0;
      video.play().catch(() => video.remove());
      video.onended = () => video.remove();
    }

    countUp($('streak'), before.streak, Number($('streak').textContent));
  }

  window.release = { play };
})();
