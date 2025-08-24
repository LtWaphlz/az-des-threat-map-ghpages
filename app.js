/* AZ DES Threat Map — Animated Arcs (Phase 1)
   - No build step, pure browser JS
   - Uses MapLibre for basemap + a Canvas overlay for animation
   - Supports two event schemas:
       A) { origin_coords:[lat,lng], target_coords:[lat,lng], intensity, timestamp }
       B) { src_lat, src_lng, dst } + resolve dst via targets.json
*/

const LOOP_SECONDS = 60;          // total loop duration
const ARC_TRAVEL_SECONDS = 3.2;   // time for a pulse to travel along an arc
const ARC_FADE_SECONDS = 2.5;     // linger after arrival
const MAX_CONCURRENT = 120;       // safety cap

// Colors
const COLOR_LOW = [0, 200, 120];
const COLOR_HIGH = [255, 80, 40];
const GLOW_COLOR = 'rgba(255,220,120,0.65)';
const BACKDROP_COLOR = 'rgba(0,0,0,0.0)';

// Canvas / state
let canvas, ctx, map;
let width = 0, height = 0, dpr = Math.max(1, window.devicePixelRatio || 1);

let events = [];
let targets = {};
let timeDomain = { min: null, max: null };

// Utilities
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpColor(a, b, t) {
  const r = Math.round(lerp(a[0], b[0], t));
  const g = Math.round(lerp(a[1], b[1], t));
  const bch = Math.round(lerp(a[2], b[2], t));
  return `rgb(${r},${g},${bch})`;
}

function parseISO(ts) { return new Date(ts).getTime(); }

function normalize(ts) {
  // Map the timestamp across LOOP_SECONDS window so we can loop forever
  const t0 = timeDomain.min;
  const span = (timeDomain.max - timeDomain.min) || 1;
  const norm = (parseISO(ts) - t0) / span; // 0..1
  return (norm % 1 + 1) % 1; // keep in [0,1)
}

function greatCirclePoints(src, dst, samples = 100) {
  const interpolate = d3.geoInterpolate([src[1], src[0]], [dst[1], dst[0]]);
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const p = interpolate(i / samples); // [lng, lat]
    pts.push([p[1], p[0]]);
  }
  return pts;
}

function project(lat, lng) {
  const p = map.project([lng, lat]);
  return [p.x * dpr, p.y * dpr];
}

function rescale() {
  width = map.getContainer().clientWidth;
  height = map.getContainer().clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

async function loadData() {
  const evRes = await fetch('../events_simulated_90d.json').catch(()=>null);
  const tgRes = await fetch('../targets_phx_tucson_mesa.json').catch(()=>null);

  let ev = [];
  if (evRes && evRes.ok) ev = await evRes.json();

  let tg = [];
  if (tgRes && tgRes.ok) tg = await tgRes.json();
  tg.forEach(t => targets[(t.city||'').toLowerCase()] = [t.lat, t.lng]);

  // Normalize schemas; build derived fields
  let minTs = Infinity, maxTs = -Infinity;
  events = ev.map((e, idx) => {
    let src, dst, intens = (e.intensity != null ? e.intensity : 75);
    if (e.origin_coords && e.target_coords) {
      src = [e.origin_coords[0], e.origin_coords[1]];
      dst = [e.target_coords[0], e.target_coords[1]];
    } else if (e.src_lat != null && e.src_lng != null && e.dst && targets[e.dst.toLowerCase()]) {
      src = [e.src_lat, e.src_lng];
      dst = targets[e.dst.toLowerCase()];
    } else {
      return null;
    }
    const ts = e.timestamp || new Date().toISOString();
    const tms = parseISO(ts);
    minTs = Math.min(minTs, tms);
    maxTs = Math.max(maxTs, tms);
    return {
      id: e.id ?? idx,
      src, dst, ts, tms,
      intensity: intens,
      colorT: Math.min(1, Math.max(0, (intens - 45) / 55)), // map 45..100 -> 0..1
      path: null // filled later
    };
  }).filter(Boolean);

  timeDomain.min = minTs;
  timeDomain.max = maxTs;
}

function precomputePaths() {
  events.forEach(ev => {
    ev.path = greatCirclePoints(ev.src, ev.dst, 80);
  });
}

// Draw helpers
function drawArcPath(path, color, widthPx, alpha=0.8) {
  if (!path || path.length < 2) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx * dpr;
  ctx.beginPath();
  const [x0, y0] = project(path[0][0], path[0][1]);
  ctx.moveTo(x0, y0);
  for (let i = 1; i < path.length; i++) {
    const [x, y] = project(path[i][0], path[i][1]);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawPulse(path, t, color) {
  if (!path || path.length < 2) return;
  const idx = Math.min(path.length - 1, Math.floor(t * (path.length - 1)));
  const lat = path[idx][0], lng = path[idx][1];
  const [x, y] = project(lat, lng);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 3.5 * dpr, 0, Math.PI * 2);
  ctx.fill();
}

function drawGlow(dstLat, dstLng, rPx, alpha=0.65) {
  const [x, y] = project(dstLat, dstLng);
  ctx.beginPath();
  ctx.arc(x, y, rPx * dpr, 0, Math.PI * 2);
  ctx.strokeStyle = GLOW_COLOR;
  ctx.lineWidth = 2 * dpr;
  ctx.globalAlpha = alpha;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Animation loop
let startMs = performance.now();
function frame() {
  requestAnimationFrame(frame);

  // Clear
  ctx.fillStyle = BACKDROP_COLOR;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Current loop time 0..LOOP_SECONDS
  const elapsed = (performance.now() - startMs) / 1000;
  const loopT = elapsed % LOOP_SECONDS;

  // For each event, compute its phase within the loop
  const active = [];
  for (const ev of events) {
    const norm = normalize(ev.ts);            // 0..1
    const evStart = norm * LOOP_SECONDS;      // seconds
    const evEnd = evStart + ARC_TRAVEL_SECONDS + ARC_FADE_SECONDS;

    // Handle wrap-around at loop boundary
    let t = loopT - evStart;
    if (t < -1) continue; // early exit
    if (t < 0) t += LOOP_SECONDS; // wrap

    if (t <= ARC_TRAVEL_SECONDS + ARC_FADE_SECONDS) {
      active.push({ ev, t });
      if (active.length > MAX_CONCURRENT) break;
    }
  }

  // Draw active arcs
  for (const { ev, t } of active) {
    const col = lerpColor(COLOR_LOW, COLOR_HIGH, ev.colorT);
    const widthPx = 0.8 + ev.colorT * 2.2;

    // Full arc base (faint)
    drawArcPath(ev.path, col, Math.max(1, widthPx * 0.6), 0.25);

    if (t <= ARC_TRAVEL_SECONDS) {
      // Traveling pulse
      const progress = Math.max(0, Math.min(1, t / ARC_TRAVEL_SECONDS));
      drawPulse(ev.path, progress, col);
    } else {
      // Arrival glow (fade & expand)
      const glowT = Math.min(1, (t - ARC_TRAVEL_SECONDS) / ARC_FADE_SECONDS);
      drawGlow(ev.dst[0], ev.dst[1], 6 + 14 * glowT, 0.65 * (1 - glowT));
    }

    // Highlight top layer arc (brighter)
    drawArcPath(ev.path, col, widthPx, 0.85);
  }
}

// Init map + canvas
async function init() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center: [-112.0740, 33.4484], // Phoenix
    zoom: 2.2,
    attributionControl: true
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  canvas = document.getElementById('overlay');
  ctx = canvas.getContext('2d');
  rescale();

  await loadData();
  precomputePaths();

  map.on('move', () => { /* redraw on next frame */ });
  map.on('resize', rescale);

  // Kick it off
  requestAnimationFrame(frame);
}

window.addEventListener('load', init);
