/* AZ DES Threat Map — Animated Arcs (GH Pages build, robust loader + TEST ARC)
   - Dark basemap via window.__THREAT_MAP_STYLE__ (set in index.html)
   - Loads data from ./data/
   - Accepts multiple schemas
   - If timestamps missing/invalid, generates synthetic 90d spread.
*/

const LOOP_SECONDS = 60;
const ARC_TRAVEL_SECONDS = 3.2;
const ARC_FADE_SECONDS = 2.5;
const MAX_CONCURRENT = 120;

const COLOR_LOW = [0, 200, 120];
const COLOR_HIGH = [255, 80, 40];
const GLOW_COLOR = 'rgba(255,220,120,0.65)';
const BACKDROP_COLOR = 'rgba(0,0,0,0.0)';

function $(id){ return document.getElementById(id); }
function setStatus(msg){ const el = $('status'); if (el) el.textContent = msg; }

// Fallback targets if JSON missing
const FALLBACK_TARGETS = {
  "phoenix": [33.4484, -112.0740],
  "tucson":  [32.2226, -110.9747],
  "mesa":    [33.4152, -111.8315]
};

let canvas, ctx, map;
let width = 0, height = 0, dpr = Math.max(1, window.devicePixelRatio || 1);

let events = [];
let targets = {};
let timeDomain = { min: null, max: null };

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpColor(a, b, t) {
  const r = Math.round(lerp(a[0], b[0], t));
  const g = Math.round(lerp(a[1], b[1], t));
  const bch = Math.round(lerp(a[2], b[2], t));
  return `rgb(${r},${g},${bch})`;
}
function parseISO(ts) {
  const t = Date.parse(ts);
  return isNaN(t) ? NaN : t;
}
function normalize(ts) {
  const t0 = timeDomain.min;
  const span = (timeDomain.max - timeDomain.min) || 1;
  const norm = (parseISO(ts) - t0) / span;
  return (norm % 1 + 1) % 1;
}

function greatCirclePoints(src, dst, samples = 100) {
  const interpolate = d3.geoInterpolate([src[1], src[0]], [dst[1], dst[0]]);
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const p = interpolate(i / samples);
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

function coerceEvent(e, idx) {
  let src, dst;
  if (!src && Array.isArray(e.origin_coords) && Array.isArray(e.target_coords)) {
    src = [Number(e.origin_coords[0]), Number(e.origin_coords[1])];
    dst = [Number(e.target_coords[0]), Number(e.target_coords[1])];
  }
  if (!src && e.src_lat != null && e.src_lng != null && e.dst) {
    const key = String(e.dst).toLowerCase();
    const t = targets[key];
    if (t) {
      src = [Number(e.src_lat), Number(e.src_lng)];
      dst = t;
    }
  }
  if (!src && e.source_lat != null && e.source_lng != null &&
      e.destination_lat != null && e.destination_lng != null) {
    src = [Number(e.source_lat), Number(e.source_lng)];
    dst = [Number(e.destination_lat), Number(e.destination_lng)];
  }
  if (!src && e.origin_lat != null && e.origin_lng != null &&
      e.target_lat != null && e.target_lng != null) {
    src = [Number(e.origin_lat), Number(e.origin_lng)];
    dst = [Number(e.target_lat), Number(e.target_lng)];
  }
  if (!src || !dst) return null;

  let intensity = 75;
  if (e.intensity != null && !isNaN(Number(e.intensity))) intensity = Number(e.intensity);

  let ts = e.timestamp;
  let tms = parseISO(ts);
  if (!ts || isNaN(tms)) {
    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 3600 * 1000;
    const jitter = Math.floor((idx % 1000) / 1000 * ninetyDaysMs);
    tms = now - ninetyDaysMs + jitter;
    ts = new Date(tms).toISOString();
  }

  return { src, dst, ts, tms, intensity };
}

async function loadData() {
  let ev = [], tg = [];
  try {
    const evRes = await fetch('data/events_simulated_90d.json', { cache: 'no-cache' });
    if (evRes.ok) ev = await evRes.json();
  } catch (e) { console.error('Failed to load events', e); }
  try {
    const tgRes = await fetch('data/targets_phx_tucson_mesa.json', { cache: 'no-cache' });
    if (tgRes.ok) tg = await tgRes.json();
  } catch (e) { console.error('Failed to load targets', e); }

  targets = { ...FALLBACK_TARGETS };
  (tg || []).forEach(t => {
    const key = String(t.city || '').toLowerCase();
    if (key && !isNaN(Number(t.lat)) && !isNaN(Number(t.lng))) {
      targets[key] = [Number(t.lat), Number(t.lng)];
    }
  });

  const coerced = ev.map(coerceEvent).filter(Boolean);
  if (!coerced.length) {
    events = [];
    return;
  }

  let minTs = Infinity, maxTs = -Infinity;
  for (const c of coerced) {
    minTs = Math.min(minTs, c.tms);
    maxTs = Math.max(maxTs, c.tms);
  }
  timeDomain.min = minTs;
  timeDomain.max = maxTs;

  events = coerced.map((c, idx) => ({
    id: idx,
    src: c.src,
    dst: c.dst,
    ts: c.ts,
    tms: c.tms,
    intensity: c.intensity,
    colorT: Math.min(1, Math.max(0, (c.intensity - 45) / 55)),
    path: greatCirclePoints(c.src, c.dst, 80)
  }));
}

function drawArcPath(path, color, widthPx, alpha=0.8) {
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

let startMs = performance.now();
function frame() {
  requestAnimationFrame(frame);

  // Clear the canvas
  ctx.fillStyle = BACKDROP_COLOR;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // === DEBUG TEST DOT at Phoenix ===
  const [x, y] = project(33.4484, -112.0740);
  ctx.fillStyle = 'rgba(255, 255, 0, 0.9)'; // bright yellow
  ctx.beginPath();
  ctx.arc(x, y, 6 * dpr, 0, Math.PI * 2);
  ctx.fill();
  // === END TEST DOT ===

  // Time progression for looping animation
  const elapsed = (performance.now() - startMs) / 1000;
  const loopT = elapsed % LOOP_SECONDS;
   
  const active = [];
  for (const ev of events) {
    const norm = normalize(ev.ts);
    const evStart = norm * LOOP_SECONDS;
    let t = loopT - evStart;
    if (t < -1) continue;
    if (t < 0) t += LOOP_SECONDS;
    if (t <= ARC_TRAVEL_SECONDS + ARC_FADE_SECONDS) {
      active.push({ ev, t });
    }
  }

  for (const { ev, t } of active) {
    const col = lerpColor(COLOR_LOW, COLOR_HIGH, ev.colorT);
    const widthPx = 0.8 + ev.colorT * 2.2;
    drawArcPath(ev.path, col, Math.max(1, widthPx * 0.6), 0.25);
    if (t <= ARC_TRAVEL_SECONDS) {
      const progress = Math.max(0, Math.min(1, t / ARC_TRAVEL_SECONDS));
      drawPulse(ev.path, progress, col);
    } else {
      const glowT = Math.min(1, (t - ARC_TRAVEL_SECONDS) / ARC_FADE_SECONDS);
      drawGlow(ev.dst[0], ev.dst[1], 6 + 14 * glowT, 0.65 * (1 - glowT));
    }
    drawArcPath(ev.path, col, widthPx, 0.85);
  }
}

async function init() {
  const styleUrl = (window.__THREAT_MAP_STYLE__ && typeof window.__THREAT_MAP_STYLE__ === 'string')
    ? window.__THREAT_MAP_STYLE__
    : 'https://demotiles.maplibre.org/style.json';

  map = new maplibregl.Map({
    container: 'map',
    style: styleUrl,
    center: [-112.0740, 33.4484], // Phoenix
    zoom: 2.2,
    attributionControl: true
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  // Wait for style & transforms to be ready before projecting anything
  map.on('load', async () => {
    canvas = document.getElementById('overlay');
    ctx = canvas.getContext('2d');
    rescale();

    setStatus('Loading data…');
    await loadData();
    precomputePaths();

    if (!events.length) {
      // TEST: inject a single arc so we can see something even if data failed
      setStatus('Test mode: injecting 1 arc');
      const test = {
        src: [52.52, 13.405],         // Berlin
        dst: [33.4484, -112.0740],    // Phoenix
        ts: new Date().toISOString(),
        tms: Date.now(),
        intensity: 85,
        colorT: Math.min(1, Math.max(0, (85 - 45) / 55)),
        path: greatCirclePoints([52.52, 13.405], [33.4484, -112.0740], 80)
      };
      events = [test];
    } else {
      setStatus(`Loaded ${events.length} events`);
    }

    map.on('resize', rescale);
    requestAnimationFrame(frame);
  });

  map.on('error', ev => {
    setStatus(`Map error: ${ev && ev.error ? (ev.error.message || ev.error) : 'unknown'}`);
  });
}

window.addEventListener('load', init);
