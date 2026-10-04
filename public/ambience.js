/* ==========================================================================
   Ambience
   A full-screen WebGL background that tracks the deadline. It replaces the
   static CSS wash with slow, domain-warped smoke whose colour, speed and
   turbulence rise with the pressure level, plus a heartbeat once the siege
   starts. Confirming the timesheet releases it with a single burst.

   Everything here is decoration. If WebGL is missing or the shader fails to
   compile, the page keeps the CSS wash and nothing else changes.

   Placeholder mode is fully procedural. To use generated artwork instead,
   list one image per pressure level (0..5) in FRAMES below; the shader then
   drifts and warps those images rather than drawing smoke. Same composition
   at every level works best, with only colour and intensity changing.
   ========================================================================== */

(() => {
  // e.g. ['/ambient/p0.jpg', '/ambient/p1.jpg', ... '/ambient/p5.jpg']
  const FRAMES = [];

  // Rendered below device resolution: the image is soft by nature, and the
  // fill rate saved is most of what keeps an older phone cool.
  const RENDER_SCALE = 0.5;

  // Deep / mid / highlight per level. Highlights match the CSS accents so the
  // background and the dial always agree on the mood.
  const PALETTES = [
    ['#03140f', '#0d5541', '#34d399'], // 0 clear
    ['#040a1a', '#143a7a', '#4b8bff'], // 1 due today
    ['#130b02', '#6b4a08', '#fbbf24'], // 2 due today, afternoon
    ['#160801', '#7a3410', '#fb923c'], // 3 urgent
    ['#180404', '#7a1a1a', '#f87171'], // 4 siege
    ['#1c0202', '#8f0d0d', '#ef4444'], // 5 overdue
  ].map((p) => p.map(hexToRgb));

  const VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec2 vUv;

    uniform vec2  uRes;
    uniform float uTime;
    uniform float uHeat;     // 0..5, smoothed pressure level
    uniform float uUrgency;  // 0..1, how much of the due day has gone
    uniform float uBurst;    // 1 -> 0 after confirming
    uniform vec3  uDeep;
    uniform vec3  uMid;
    uniform vec3  uHigh;

    uniform bool      uUseImg;
    uniform sampler2D uImgA;
    uniform sampler2D uImgB;
    uniform float     uImgMix;
    uniform float     uImgAspect;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }

    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
      for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = r * p * 2.02;
        a *= 0.5;
      }
      return v;
    }

    vec2 cover(vec2 uv) {
      float screen = uRes.x / uRes.y;
      vec2 s = screen > uImgAspect
        ? vec2(1.0, uImgAspect / screen)
        : vec2(screen / uImgAspect, 1.0);
      return (uv - 0.5) * s + 0.5;
    }

    void main() {
      vec2 uv = vUv;
      vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);

      float heat = uHeat / 5.0;
      float speed = mix(0.025, 0.16, heat * heat) + uUrgency * 0.02;
      float warp = mix(0.6, 2.4, heat);
      float t = uTime * speed;

      // Two layers of domain warping: smoke folding into itself, tighter and
      // faster as the heat rises.
      vec2 q = vec2(fbm(p * 1.6 + vec2(0.0, t)),
                    fbm(p * 1.6 + vec2(5.2, -t * 0.8)));
      vec2 r = vec2(fbm(p * 1.8 + warp * q + vec2(1.7, 9.2) + t * 1.3),
                    fbm(p * 1.8 + warp * q + vec2(8.3, 2.8) - t * 1.1));
      float f = fbm(p * 1.5 + warp * r);

      // Heartbeat from the siege onward: a double thump whose rate climbs.
      float beatOn = smoothstep(3.4, 4.2, uHeat);
      float bpm = mix(52.0, 96.0, smoothstep(4.0, 5.0, uHeat));
      float ph = fract(uTime * bpm / 60.0);
      float beat = exp(-ph * 14.0) + 0.6 * exp(-max(ph - 0.18, 0.0) * 16.0) * step(0.18, ph);
      beat *= beatOn;

      vec3 col;
      if (uUseImg) {
        vec2 iuv = cover(uv) + (r - 0.5) * mix(0.01, 0.05, heat);
        iuv.y = 1.0 - iuv.y;
        col = mix(texture2D(uImgA, iuv).rgb, texture2D(uImgB, iuv).rgb, uImgMix);
        col *= 0.55 + 0.25 * beat;
      } else {
        col = mix(uDeep, uMid, smoothstep(0.2, 0.75, f));
        col = mix(col, uHigh, smoothstep(0.55, 0.95, f * (0.85 + 0.35 * length(q))) * (0.45 + 0.35 * heat));
        col *= 1.35;
        col += uHigh * beat * 0.10 * smoothstep(0.3, 0.9, f);
      }

      // Light pools at the top, where the dial is, and falls away toward the
      // panels so text stays legible however hot it gets.
      float top = smoothstep(1.3, 0.1, length((uv - vec2(0.5, 1.0)) * vec2(1.0, 1.25)));
      float floorFade = smoothstep(0.0, 0.75, uv.y);
      col *= mix(0.4, 1.0, top) * mix(0.55, 1.0, floorFade);

      // Release: one ring of the highlight colour sweeping out from the dial.
      if (uBurst > 0.0) {
        float d = length((uv - vec2(0.5, 0.72)) * vec2(uRes.x / uRes.y, 1.0));
        float radius = (1.0 - uBurst) * 1.6;
        float ring = exp(-pow((d - radius) * 7.0, 2.0)) * uBurst;
        col += uHigh * ring * 0.6 + uHigh * uBurst * uBurst * 0.12;
      }

      // Vignette tightens with the heat.
      float vig = smoothstep(mix(1.25, 0.85, heat), 0.2, length(p * vec2(0.9, 0.75)));
      col *= mix(0.55, 1.0, vig);

      // Grain, so the gradients do not band on 8-bit panels.
      col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.012;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Colour eases straight toward the target palette rather than following
  // the heat through every level in between -- confirming during the siege
  // should go red to green, not red, orange, amber, blue, green.
  function easePalette(from, to, k) {
    return from.map((rgb, i) => rgb.map((c, j) => lerp(c, to[i][j], k)));
  }

  // ------------------------------------------------------------- setup

  const canvas = document.createElement('canvas');
  canvas.className = 'ambience';
  canvas.setAttribute('aria-hidden', 'true');

  const gl = canvas.getContext('webgl', {
    antialias: false,
    alpha: false,
    depth: false,
    powerPreference: 'low-power',
  });
  if (!gl) return;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('ambience: shader failed', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  for (const name of ['uRes', 'uTime', 'uHeat', 'uUrgency', 'uBurst', 'uDeep', 'uMid',
    'uHigh', 'uUseImg', 'uImgA', 'uImgB', 'uImgMix', 'uImgAspect']) {
    U[name] = gl.getUniformLocation(prog, name);
  }
  gl.uniform1i(U.uImgA, 0);
  gl.uniform1i(U.uImgB, 1);

  // --------------------------------------------------------- images

  const textures = [];
  let imagesReady = false;
  let imgAspect = 9 / 16;

  function loadFrames(urls) {
    if (urls.length !== PALETTES.length) return;
    let pending = urls.length;
    urls.forEach((url, i) => {
      const img = new Image();
      img.onload = () => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
        // No mipmaps: frames need not be power-of-two sized.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        textures[i] = tex;
        if (i === 0) imgAspect = img.width / img.height;
        if (--pending === 0) {
          imagesReady = true;
          requestFrame();
        }
      };
      // One missing frame drops back to the procedural smoke rather than
      // leaving a hole at that level.
      img.onerror = () => console.warn('ambience: could not load', url);
      img.src = url;
    });
  }

  // ---------------------------------------------------------- state

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // ?mood=0..5 pins a level and ?mood=cycle walks through all of them, so the
  // whole range can be judged without waiting for a Friday.
  const moodParam = new URLSearchParams(location.search).get('mood');
  const pinned = moodParam !== null && moodParam !== 'cycle'
    ? Math.max(0, Math.min(5, Number(moodParam) || 0))
    : null;
  const cycling = moodParam === 'cycle';

  let target = pinned ?? 1;
  let heat = target;
  let palette = PALETTES[target].map((rgb) => rgb.slice());
  let urgency = 0;
  let burst = 0;
  let resolved = null;
  let start = performance.now();
  let last = start;
  let raf = 0;

  function resize() {
    const w = Math.max(1, Math.round(innerWidth * RENDER_SCALE * Math.min(devicePixelRatio, 2)));
    const h = Math.max(1, Math.round(innerHeight * RENDER_SCALE * Math.min(devicePixelRatio, 2)));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    requestFrame();
  }

  function draw(now) {
    raf = 0;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (cycling) target = Math.floor(((now - start) / 4000) % 6);

    // ~1.2 s to settle on a new level, matching the CSS transition.
    const k = 1 - Math.exp(-dt * 3);
    heat += (target - heat) * k;
    if (Math.abs(target - heat) < 0.001) heat = target;
    palette = heat === target ? PALETTES[target] : easePalette(palette, PALETTES[target], k);
    burst = Math.max(0, burst - dt / 1.8);

    const [deep, mid, high] = palette;
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, reducedMotion.matches ? 40 : (now - start) / 1000);
    gl.uniform1f(U.uHeat, heat);
    gl.uniform1f(U.uUrgency, urgency);
    gl.uniform1f(U.uBurst, reducedMotion.matches ? 0 : burst);
    gl.uniform3fv(U.uDeep, deep);
    gl.uniform3fv(U.uMid, mid);
    gl.uniform3fv(U.uHigh, high);

    gl.uniform1i(U.uUseImg, imagesReady ? 1 : 0);
    if (imagesReady) {
      const i = Math.min(4, Math.floor(heat));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textures[i]);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, textures[i + 1]);
      gl.uniform1f(U.uImgMix, heat - i);
      gl.uniform1f(U.uImgAspect, imgAspect);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // With reduced motion the scene is a still image: draw again only while
    // a level change is easing in.
    const settling = heat !== target || burst > 0;
    if (!reducedMotion.matches || settling) requestFrame();
  }

  function requestFrame() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(draw);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      last = performance.now();
      requestFrame();
    }
  });
  reducedMotion.addEventListener?.('change', requestFrame);
  addEventListener('resize', resize);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    document.documentElement.classList.remove('has-ambience');
  });

  // ------------------------------------------------------------ api

  window.ambience = {
    // level 0..5, urgency 0..1, done = the week is confirmed or skipped.
    update({ level, urgency: u = 0, done = false }) {
      if (pinned === null && !cycling) target = level;
      urgency = u;
      if (resolved === false && done) burst = 1;
      resolved = done;
      requestFrame();
    },
  };

  document.body.prepend(canvas);
  document.documentElement.classList.add('has-ambience');
  if (FRAMES.length) loadFrames(FRAMES);
  resize();
})();
