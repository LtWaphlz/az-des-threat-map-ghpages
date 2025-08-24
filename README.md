# AZ DES Threat Map — GitHub Pages Build (Phase 1)

This folder is **ready to deploy** to GitHub Pages (or Netlify/Vercel) and will autoplay a simulated animated arcs map.

## Files
- `index.html` — loads MapLibre, D3-Geo, and `app.js`
- `app.js` — draws arcs & pulses on a canvas overlay (no tokens needed)
- `style.css` — minimal styling and HUD
- `data/events_simulated_90d.json` — simulated events (90 days)
- `data/targets_phx_tucson_mesa.json` — target cities
- `.nojekyll` — disables Jekyll processing on GitHub Pages

## Local Preview
From this folder:
```bash
python -m http.server 8000
# then open http://localhost:8000/
```

## Deploy to GitHub Pages
1. Create a new repo named e.g. `az-des-threat-map`.
2. Put these files at the **repo root** and commit.
3. In GitHub → **Settings → Pages** → Deploy from **branch: `main`**, folder: **`/` (root)**.
4. After it builds, your map will be at:
   `https://<your-username>.github.io/az-des-threat-map/`

### Embed in a dashboard
```html
<iframe
  src="https://<your-username>.github.io/az-des-threat-map/"
  width="100%"
  height="620"
  style="border:0; background:#0b0f14"
  allow="fullscreen">
</iframe>
```

## Data Refresh
Replace `data/events_simulated_90d.json` (same filename and schema). No code changes needed.
