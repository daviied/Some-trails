# Trail Fetcher (companion for Wanderer)

Trail Fetcher finds trails on the internet, keeps them in a local cache, and imports them into your
[Wanderer](https://github.com/Flomp/wanderer) server. Wanderer stays the original, unchanged app.

## How it works

1. Open the app. Search a place or a trail name, or move the map.
2. If the area is not in the cache, the server downloads the trails from the internet.
3. The server keeps the trails in its local database and imports them into Wanderer (auto-import).
4. The next search or browse of that area reads the local cache.

**Area import:** tap **Area box**, move (✥) and resize (corners) the box, then tap
**Import trails in box**. Use it for a full city or state (for example, Phoenix or Washington).
The job continues on the server when you close the app. A state takes hours for the first download.

## Data sources (priority order)

| Priority | Source | Area | Notes |
|---|---|---|---|
| 1 | USGS National Digital Trails | USA | Public domain. Best for federal and state land. |
| 2 | National Park Service – NPS Public Trails | US national parks | Public domain. |
| 3 | US Forest Service – National Forest System Trails | US national forests | Public domain. Land trails only (no snow or water trails). |
| 4 | OpenStreetMap (Overpass API) | World | ODbL. Fills gaps (for example, city parks). |
| – | GPX upload | Any | Exports from AllTrails, Gaia, Strava, or a GPS. |

If two sources have a trail with the same name in the same place, the app keeps the one from the
higher source and marks the other "Skipped".

AllTrails has no public API, and its terms do not allow scraping. To add AllTrails routes, download
the GPX in AllTrails and drop it on the **Upload** tab.

Wanderer adds elevation and location itself when it receives a trail. It also rejects duplicates.
These show as "Already in Wanderer".

## Install on CasaOS

1. Push this repo to GitHub. The workflow `.github/workflows/docker.yml` builds
   `ghcr.io/<owner>/trail-fetcher:latest` (amd64 + arm64).
2. On GitHub: **Packages → trail-fetcher → Package settings → Change visibility → Public**.
   You can also log in to ghcr.io on the CasaOS host.
3. In Wanderer: **Settings → API → create token**. Copy the `wanderer_key_…` value.
4. In CasaOS: **App Store → Custom Install → Import**. Paste `docker-compose.yml`, then set
   `WANDERER_URL` and `WANDERER_API_KEY`.
5. Open `http://<casaos-ip>:3010`. To install it as an app, use **Install** (desktop Chrome/Edge)
   or **Add to Home Screen** (phone).

Note: browsers allow PWA install only on `https://` or `localhost`. On plain `http://` on a LAN,
the app works but the install option may not show. Use a reverse proxy with HTTPS
(for example, Nginx Proxy Manager or a Cloudflare Tunnel) to get the install option.

## Settings (environment variables)

| Variable | Default | Use |
|---|---|---|
| `WANDERER_URL` | – | Wanderer web URL, for example `http://192.168.1.10:3000` |
| `WANDERER_API_KEY` | – | Wanderer API token (preferred) |
| `WANDERER_USER` / `WANDERER_PASSWORD` | – | Use these if you have no token |
| `AUTO_PUSH` | `true` | Import new trails into Wanderer automatically |
| `SOURCES` | `usgs,nps,usfs,osm` | Sources in priority order |
| `MIN_LENGTH_M` | `400` | Skip shorter trails |
| `CACHE_DAYS` | `90` | Download an area again after this many days |
| `APP_PASSWORD` | – | Login password for this app (any user name) |
| `AUTO_FETCH_MAX_TILES` | `16` | Largest view (in 0.25° tiles) that downloads automatically while you browse |
| `MAX_JOB_TILES` | `6000` | Largest area import |
| `OVERPASS_URLS` | 3 public servers | Comma-separated Overpass servers |
| `PUSH_DELAY_MS` | `200` | Wait time between uploads to Wanderer |

The Settings tab can change most of these values. Values set there override the environment.

## Develop

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Data is kept in `DATA_DIR` (default `./data`, `/data` in Docker) as a SQLite file.
