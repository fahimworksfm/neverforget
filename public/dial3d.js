/* ==========================================================================
   Dial 3D
   The countdown ring as a lit object instead of a flat stroke: a glowing arc
   that burns down across Friday with a hot bead at its tip, a dark track
   behind it, and embers orbiting the ring that multiply, speed up and start
   to shake as the pressure rises. It leans toward the pointer (or the
   phone's tilt, where the browser gives it without asking) and beats with
   the same heartbeat as the ambience once the siege starts.

   It is drawn in the same place as the SVG ring, which stays in the page
   underneath. If Three.js or WebGL is unavailable the SVG simply remains,
   and the countdown text is ordinary HTML on top either way.
   ========================================================================== */

import * as THREE from '/vendor/three.min.js';

const dial = document.querySelector('.dial');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// The canvas overhangs the dial so the glow and embers are not clipped.
const OVERHANG = 1.5;
// SVG ring radius as a share of the dial width (r = 92 in a 200 viewBox).
const RING = 0.46;
const EMBERS = 180;

const RING_VERT = `
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vPos = position;
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

// Angle round the ring as 0..1, starting at twelve o'clock and running
// clockwise -- the same direction the SVG arc depletes in.
const TURN = `
  float turn(vec2 p) {
    float t = atan(p.x, p.y) / 6.2831853;
    return t < 0.0 ? t + 1.0 : t;
  }
`;

const TRACK_FRAG = `
  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = pow(1.0 - abs(dot(vNormal, vView)), 2.0);
    vec3 col = vec3(0.05, 0.055, 0.07) + uColor * (0.10 + rim * 0.35);
    gl_FragColor = vec4(col, 0.85);
  }
`;

const ARC_FRAG = `
  uniform vec3  uColor;
  uniform float uFraction;
  uniform float uGlow;
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vView;
  ${TURN}
  void main() {
    if (uFraction < 0.999 && turn(vPos.xy) > uFraction) discard;
    float facing = abs(dot(vNormal, vView));
    float rim = pow(1.0 - facing, 2.5);
    // White-hot along the crest, saturated toward the edges.
    vec3 col = uColor * (0.75 + rim * 0.9) + vec3(1.0) * pow(facing, 6.0) * 0.55;
    gl_FragColor = vec4(col * uGlow, 1.0);
  }
`;

// Glow is a flat quad in the ring's own plane rather than a post-process
// bloom: one extra draw call instead of several full-screen passes, and it
// tilts with the ring for free.
const GLOW_FRAG = `
  uniform vec3  uColor;
  uniform float uFraction;
  uniform float uGlow;
  uniform float uTip;
  varying vec3 vPos;
  ${TURN}
  void main() {
    vec2 p = vPos.xy;
    float d = abs(length(p) - 1.0);
    float t = turn(p);
    float lit = uFraction >= 0.999 ? 1.0 : smoothstep(uFraction + 0.006, uFraction - 0.006, t);

    float halo = lit * (exp(-d * 22.0) * 0.55 + exp(-d * 6.0) * 0.16);
    float track = exp(-d * 40.0) * 0.05;

    float a = uFraction * 6.2831853;
    float k = length(p - vec2(sin(a), cos(a)));
    float tip = uTip * (exp(-k * 10.0) * 0.8 + exp(-k * 38.0) * 1.6);

    vec3 col = uColor * (halo + track) * uGlow + mix(uColor, vec3(1.0), 0.6) * tip;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const EMBER_VERT = `
  attribute vec4 aSeed;   // angle, ring offset, depth, speed
  attribute float aRand;
  uniform float uTime;
  uniform float uHeat;
  uniform float uBurst;
  uniform float uScale;
  varying float vAlpha;
  void main() {
    float heat = uHeat / 5.0;
    float shake = smoothstep(3.5, 5.0, uHeat);
    float angle = aSeed.x + uTime * aSeed.w * (0.04 + heat * 0.22);
    float r = 1.0 + aSeed.y * (0.10 + 0.22 * heat);
    r += sin(uTime * (8.0 + aSeed.w * 14.0) + aSeed.x * 31.0) * 0.025 * shake;

    // Released: thrown outward on an ease-out curve.
    float b = 1.0 - uBurst;
    float fling = uBurst > 0.0 ? (1.0 - (1.0 - b) * (1.0 - b)) : 0.0;
    r += fling * (0.6 + aRand * 1.4);

    vec3 pos = vec3(sin(angle) * r, cos(angle) * r, aSeed.z * 0.35);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (1.5 + aRand * 3.0) * uScale / -mv.z;

    float shown = step(aRand, 0.18 + 0.82 * heat);
    float flicker = 0.65 + 0.35 * sin(uTime * (3.0 + aRand * 9.0) + aSeed.x * 17.0);
    float release = uBurst > 0.0 ? uBurst : 1.0;
    vAlpha = mix(shown, 1.0, uBurst) * flicker * release;
  }
`;

const EMBER_FRAG = `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.35) * a, 1.0);
  }
`;

// Adds light without touching the canvas alpha, so glow composites over the
// page as light instead of turning the whole canvas into an opaque square.
const LIGHT = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
  transparent: true,
  depthWrite: false,
};

function parseColor(css, fallback) {
  try {
    return new THREE.Color(css.trim() || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

function build() {
  const canvas = document.createElement('canvas');
  canvas.className = 'dial3d';
  canvas.setAttribute('aria-hidden', 'true');

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'low-power',
  });
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const fov = 32;
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 50);
  // Distance at which a unit ring fills exactly the SVG ring's footprint.
  const visible = OVERHANG / RING;
  camera.position.z = visible / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2));

  const group = new THREE.Group();
  scene.add(group);

  const color = new THREE.Color('#4b8bff');
  const U = {
    uColor: { value: color },
    uFraction: { value: 1 },
    uGlow: { value: 1 },
    uTip: { value: 1 },
    uTime: { value: 0 },
    uHeat: { value: 1 },
    uBurst: { value: 0 },
    uScale: { value: 1 },
  };

  const track = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.016, 12, 200),
    new THREE.ShaderMaterial({
      uniforms: { uColor: U.uColor },
      vertexShader: RING_VERT,
      fragmentShader: TRACK_FRAG,
      transparent: true,
    })
  );

  const arc = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.03, 20, 360),
    new THREE.ShaderMaterial({
      uniforms: { uColor: U.uColor, uFraction: U.uFraction, uGlow: U.uGlow },
      vertexShader: RING_VERT,
      fragmentShader: ARC_FRAG,
    })
  );

  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 3.4),
    new THREE.ShaderMaterial({
      uniforms: { uColor: U.uColor, uFraction: U.uFraction, uGlow: U.uGlow, uTip: U.uTip },
      vertexShader: RING_VERT,
      fragmentShader: GLOW_FRAG,
      ...LIGHT,
    })
  );
  glow.renderOrder = 2;

  const seeds = new Float32Array(EMBERS * 4);
  const rands = new Float32Array(EMBERS);
  for (let i = 0; i < EMBERS; i++) {
    seeds[i * 4] = Math.random() * Math.PI * 2;
    seeds[i * 4 + 1] = (Math.random() - 0.5) * 2;
    seeds[i * 4 + 2] = (Math.random() - 0.5) * 2;
    seeds[i * 4 + 3] = 0.4 + Math.random() * 1.2;
    rands[i] = Math.random();
  }
  const emberGeo = new THREE.BufferGeometry();
  // Positions are computed in the shader; this only sets the vertex count.
  emberGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(EMBERS * 3), 3));
  emberGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  emberGeo.setAttribute('aRand', new THREE.BufferAttribute(rands, 1));
  const embers = new THREE.Points(
    emberGeo,
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: U.uColor, uTime: U.uTime, uHeat: U.uHeat, uBurst: U.uBurst, uScale: U.uScale,
      },
      vertexShader: EMBER_VERT,
      fragmentShader: EMBER_FRAG,
      ...LIGHT,
    })
  );
  embers.frustumCulled = false;
  embers.renderOrder = 3;

  group.add(track, arc, glow, embers);

  // ------------------------------------------------------------ state

  const target = { fraction: 1, heat: 1, color: color.clone(), done: false };
  let fraction = 1;
  let heat = 1;
  let tip = 1;
  let burst = 0;
  const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
  let last = performance.now();
  let raf = 0;
  let onScreen = true;

  function resize() {
    const size = dial.clientWidth * OVERHANG;
    if (!size) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(size, size, false);
    // Point sizes are authored in CSS pixels for a ~400px canvas.
    U.uScale.value = dpr * camera.position.z * (size / 400);
    request();
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const still = reducedMotion.matches;
    const k = still ? 1 : 1 - Math.exp(-dt * 4);

    fraction += (target.fraction - fraction) * k;
    heat += (target.heat - heat) * (still ? 1 : 1 - Math.exp(-dt * 3));
    tip += ((target.done ? 0 : 1) - tip) * k;
    color.lerp(target.color, still ? 1 : 1 - Math.exp(-dt * 3));
    burst = Math.max(0, burst - dt / 1.6);

    const t = now / 1000;
    // Same heartbeat as the ambience, so the ring and the room thump together.
    const beatOn = THREE.MathUtils.smoothstep(heat, 3.4, 4.2);
    const bpm = 52 + 44 * THREE.MathUtils.smoothstep(heat, 4, 5);
    const ph = (t * bpm / 60) % 1;
    const beat = still ? 0 : beatOn * (Math.exp(-ph * 14) + (ph > 0.18 ? 0.6 * Math.exp(-(ph - 0.18) * 16) : 0));

    const pop = burst > 0 ? Math.sin(Math.PI * Math.min(1, (1 - burst) * 2.2)) * 0.07 : 0;
    group.scale.setScalar(1 + beat * 0.018 + pop);

    // Idle sway, plus a lean toward the pointer or the phone's tilt.
    tilt.x += (tilt.tx - tilt.x) * (1 - Math.exp(-dt * 5));
    tilt.y += (tilt.ty - tilt.y) * (1 - Math.exp(-dt * 5));
    const sway = still ? 0 : 1;
    group.rotation.x = tilt.x + Math.sin(t * 0.35) * 0.09 * sway;
    group.rotation.y = tilt.y + Math.cos(t * 0.27) * 0.11 * sway;

    U.uFraction.value = Math.min(1, Math.max(0, fraction));
    U.uTip.value = tip * (fraction < 0.999 ? 1 : 0);
    U.uHeat.value = heat;
    U.uTime.value = still ? 12 : t;
    U.uBurst.value = still ? 0 : burst;
    U.uGlow.value = 1 + beat * 0.5 + burst * 1.6;

    renderer.render(scene, camera);

    const settling =
      Math.abs(target.fraction - fraction) > 0.0005 ||
      Math.abs(target.heat - heat) > 0.001 ||
      burst > 0;
    if (!still || settling) request();
  }

  function request() {
    if (!raf && onScreen && !document.hidden) raf = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------- input

  const MAX_TILT = 0.32;
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const r = dial.getBoundingClientRect();
    const nx = (e.clientX - (r.left + r.width / 2)) / innerWidth;
    const ny = (e.clientY - (r.top + r.height / 2)) / innerHeight;
    tilt.ty = Math.max(-1, Math.min(1, nx * 2)) * MAX_TILT;
    tilt.tx = Math.max(-1, Math.min(1, ny * 2)) * MAX_TILT;
  }, { passive: true });

  // Phone tilt where it is offered without a permission prompt (Android).
  // iOS asks first; a permission dialog is not worth a decorative lean.
  let base = null;
  addEventListener('deviceorientation', (e) => {
    if (e.beta == null || e.gamma == null) return;
    base ??= { beta: e.beta, gamma: e.gamma };
    tilt.tx = Math.max(-1, Math.min(1, (e.beta - base.beta) / 25)) * MAX_TILT;
    tilt.ty = Math.max(-1, Math.min(1, (e.gamma - base.gamma) / 25)) * MAX_TILT;
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      last = performance.now();
      request();
    }
  });
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    if (onScreen) {
      last = performance.now();
      request();
    }
  }).observe(dial);
  new ResizeObserver(resize).observe(dial);
  reducedMotion.addEventListener?.('change', request);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    dial.classList.remove('is-3d');
  });
  canvas.addEventListener('webglcontextrestored', () => dial.classList.add('is-3d'));

  // ------------------------------------------------------------ api

  let first = true;
  const api = {
    // fraction 0..1 of Friday left, level 0..5, done = confirmed or skipped.
    update({ fraction: f, level, done }) {
      target.fraction = f;
      target.heat = level;
      target.done = done;
      target.color = parseColor(getComputedStyle(document.body).getPropertyValue('--accent'), '#4b8bff');
      // The first reading snaps instead of easing in from defaults.
      if (first) {
        first = false;
        fraction = f;
        heat = level;
        tip = done ? 0 : 1;
        color.copy(target.color);
      }
      request();
    },

    release() {
      burst = 1;
      request();
    },
  };

  dial.prepend(canvas);
  resize();
  dial.classList.add('is-3d');
  return api;
}

if (dial) {
  try {
    window.dial3d = build();
    // The page may have rendered before this module finished loading.
    document.dispatchEvent(new Event('dial3d:ready'));
  } catch (err) {
    console.warn('dial3d: unavailable, keeping the flat ring', err);
  }
}
