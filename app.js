/* AZ DES Threat Map — Animated Arcs (GH Pages build, robust loader)
   - Dark basemap via window.__THREAT_MAP_STYLE__ (set in index.html)
   - Loads data from ./data/
   - Accepts multiple schemas:
       A) origin_coords,target_coords
       B) src_lat,src_lng,dst   (resolved via targets.json)
       C) source_lat,source_lng,destination_lat,destination_lng
       D) origin_lat,origin_lng,target_lat,target_lng
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

let canvas, ctx, map;
let width = 0, height = 0, dpr = Math.max(1, window.devicePixelRatio || 1);

let events = [];
let targets = {};
let timeDomain = { min: null, max: null };

const $status = () => document.getElementById('status');

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
  const norm = (parseISO(ts) - t0) / span; // 0..1
  // If parse fails, it becomes NaN, which will break drawing; guard upstream.
  return (norm % 1 + 1) % 1;
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

function coerceEvent(e, idx) {
  // returns {src:[lat,lng], dst:[lat,lng], ts, intensity} or null
  let src, dst;

  // A) origin_coords/target_coords
  if (Array.isArray(e.origin_coords) && Array.isArray(e.target_coords)) {
    src = [Number(e.origin_coords[0]), Number(e.origin_coords[1])];
    dst = [Number(e.target_coords[0]), Number(e.target_coords[1])];
  }

  // B) src_lat/src_lng/dst (lookup target city)
  if (!src && e.src_lat != null && e.src_lng != null && e.dst) {
    const t = targets[String(e.dst).toLowerCase()];
    if (t) {
      src = [Number(e.src_lat), Number(e.src_lng)];
      dst = t;
    }
  }

  // C) source_lat/source_lng/destination_lat/destination_lng
  if (!src && e.source_lat != null && e.source_lng != null && e.destination_lat != null && e.destination_lng != null) {
    src = [Number(e.source_lat), Number(e.source_lng)];
    dst = [Number(e.destination_lat), Number(e.destination_lng)];
  }

  // D) origin_lat/origin_lng/target_lat/target_lng
  if (!src && e.origin_lat != null && e.origin_lng != null && e.target_lat != null && e.target_lng != null) {
    src = [Number(e.origin_lat), Number(e.origin_lng)];
    dst = [Number(e.target_lat), Number(e.target_lng)];
  }

  if (!src || !dst || isNaN(src[0]) || isNaN(src[1]) || isNaN(dst[0]) || isNaN(dst[1])) return null;

  // intensity
  let intens = 75;
  if (e.intensity != null && !isNaN(Number(e.intensity))) intens = Number(e.intensity);

  // timestamp
  let ts = e.timestamp;
  let tms = parseISO(ts);
  if (!ts || isNaN(tms)) {
    // synthesize a timestamp across ~90 days if missing
    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 3600 * 1000;
    const jitter = Math.floor((idx % 1000) / 1000 * ninetyDaysMs);
    tms = now - ninetyDaysMs + jitter;
    ts = new Date(tms).toISOString();
  }

  return { src, dst, ts, tms, intensity: intens };
}

async function loadData() {
  $status() && ($status().textContent = 'Loading data…');

  let ev = [], tg = [];
  try {
    const evRes = await fetch('data/events_simulated_90d.json', { cache: 'no-cache' });
    if (evRes.ok) ev = await evRes.json();
  } catch (e) { console.error('Failed to load events', e); }

  try {
    const tgRes = await fetch('data/targets_phx_tucson_mesa.json', { cache: 'no-cache' });
    if (tgRes.ok) tg = await tgRes.json();
  } catch (e) { console.error('Failed to load targets', e); }

  tg.forEach(t => targets[(t.city||'').toLowerCase()] = [Number(t.lat), Number(t.lng)]);

  // Coerce every event
  const coerced = ev.map(coerceEvent).filter(Boolean);

  // Compute domain; if empty, warn visibly
  if (!coerced.length) {
    console.warn('No events parsed. Check JSON schema/fields.');
    $status() && ($status().textContent = 'No events parsed — check data/ JSON field names.');
    events = [];
    return;
  }

  let minTs = Infinity, maxTs = -Infinity;
  coer
