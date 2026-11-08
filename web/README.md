# Beacon responder dashboard

React 19 + TypeScript (strict) + Vite single-page app for responders and admins. It is built into `../server/public` and served by the Express server at `/` (same origin, relative `/v1` URLs, `wss://<host>/v1/ws`), so no CORS setup is needed in production.

Design reference: `../server/lifeline-dashboard-mock.html` (a static mock, not shipped). The app reproduces its look (navy sidebar, orange accent, stat tiles, ranked queue cards, map card with layers/legend/popup, mesh health) and wires every panel to the real API in `../openapi.yaml`. Every number on screen comes from the API; where the API has no data for a mock element (flood-risk layer, "phones relaying", AI assistant chip) the element is dropped or replaced by something real (for example "Latest escalation" is the most recent silent case or unclaimed critical case).

## Run

```bash
# 1. backend (see ../server/README.md); DEMO_MODE=true enables the demo tools and the seed endpoints
cd ../server && docker compose up -d db && DEMO_MODE=true npm run dev     # http://localhost:3000

# 2. dashboard dev server with HMR, proxies /v1 (including the websocket) to localhost:3000
cd ../web && npm install && npm run dev                                    # http://localhost:5173
```

Sign in with a seeded responder (`admin`, `alice`, `bob`, `carol`; password is the server's `SEED_PASSWORD`, default `beacon-demo`). Use another backend with `BEACON_API=http://host:3000 npm run dev`. With `DEMO_MODE=true`: Events & Settings -> "Seed synthetic data" fills the queue and map.

| Script | What |
|---|---|
| `npm run dev` | Vite dev server (port 5173) |
| `npm run build` | typecheck, then build to `../server/public` (hashed assets, `emptyOutDir`) |
| `npm run typecheck` / `npm run lint` / `npm test` | tsc, ESLint 10, Vitest + Testing Library |
| `npm run typegen` | regenerate `src/api/types.ts` from `../openapi.yaml` (openapi-typescript; CI fails when the committed file is stale) |

`server/public` is gitignored except `.gitkeep` (copied from `web/public`, so a clean build keeps it). `server/Dockerfile` has a `web` stage that runs `npm run build`, so `docker compose build` in `server/` produces an image that serves the dashboard.

## Structure

```
src/api        client.ts (fetch wrapper: bearer, single-flight refresh + retry, ApiError), endpoints.ts (one function per endpoint), types.ts (generated), models.ts
src/lib        pure helpers with unit tests: tier colours, hop formatting, ages, query building, privacy, ws reducers + feed sentences, stats, escalation, socket backoff
src/state      zustand: auth (in-memory access token, refresh token in sessionStorage), ui (selection, connection, feed, toasts, layers)
src/hooks      react-query hooks (data.ts), websocket wiring + cache patching (live.ts)
src/components Shell (sidebar/header), CaseCard, CasePanel (detail), MapView (Leaflet), cards, ui primitives (modal, confirm, toasts, tabs)
src/views      Login, Overview, MapPage, Queue, Checkins, Mesh, Responders, Settings
src/styles     mock.css (the mock's CSS, verbatim) + extras.css (a11y, states, responsive)
```

Libraries: TanStack Query (cache, retries, invalidation), zustand (tiny state), react-router (deep-linkable views), Leaflet with OpenStreetMap raster tiles (light, no API key; the map renders on a blank background when tiles are unreachable). No UI kit.

## Views and endpoints

| View | Shows | Endpoints |
|---|---|---|
| Overview | stat tiles, map, ranked queue with tabs, live feed, mesh health | `GET /sos` (sort=priority, all pages), `/responders`, `/heartbeats/silent`, `/mesh/stats`, `/server-info`, `/map/deadzones`, `/map/heat`, `/health`, `POST /assignments`, `POST /heartbeats/silent/{id}/promote` |
| Incident Map | map in view, cases in view, dead zones with "being checked"/dismiss | same plus `PATCH /map/deadzones/{id}` |
| Triage Queue | filterable table (tabs, server-side search `q`, include resolved) and case panel: score reasons, extracted entities, relay path, check-ins, history, notes, merged reports, voice note | `GET /sos`, `GET /sos/{id}`, `/sos/{id}/events`, `PATCH /sos/{id}` (notes, score override), `POST /sos/{id}/retriage`, `/merge`, `/unmerge`, `/checkins`, `GET /sos/{id}/voice-note`, `POST/PATCH/DELETE /assignments`, `DELETE /sos/{id}` (admin) |
| Check-ins | sent/answered/missed per open case, who is overdue ("Check in now"), silent phones (acknowledge, make case), timing rules from `/server-info` | `GET /sos/{id}/checkins`, `POST /sos/{id}/checkins`, `/heartbeats/silent` (+ PATCH, promote) |
| Mesh Network | stats, longest relay chain diagram, hop limits, hop histogram, rejections, busiest gateways | `/mesh/stats`, `/server-info`, `/sos` |
| Responders | table, active case timeline and quick actions, admin add/edit/delete | `/responders` (CRUD, admin), `/assignments` |
| Events & Settings | events (create with a drawn geofence, edit area, close, purge, delete with confirmations, admin), area thumbnails, demo tools, server info | `/events` (POST, PATCH), `/events/{id}/close`, `/purge`, `/mesh/seed`, `/mesh/simulate` |

Role awareness: admin-only controls (responder CRUD, events, delete case) are hidden for other roles; volunteers get a read-only queue (no claim/advance). The server remains the authority and answers 403/409 which are shown as toasts.

## Event geofence

Creating an event opens a full dialog: name, retention, heartbeat interval and silence threshold (with help text) and a map on which the admin draws exactly one geofence. The same dialog edits the geofence of an active event (`PATCH /events/{id}`); closed and purged events open it read-only.

- **Tools**: polygon (click vertices, close by clicking the green first vertex, Enter or "Finish shape"), rectangle (two clicks or press-and-drag), circle (centre, then radius). Afterwards drag the square handles to reshape (rectangle corners resize, circle has a centre and a radius handle), click a round midpoint to add a vertex, select a vertex and press Delete (or double-click it) to remove it, drag the body to move the shape, Undo/Redo (Ctrl+Z, Ctrl+Shift+Z, a drag is one step) and Clear. Drawing a new shape replaces the old one on completion; Escape cancels an unfinished drawing before it closes the dialog.
- **Helpers**: place search (OpenStreetMap Nominatim: debounced 700 ms, at least 1.1 s between requests, cached per query, aborted when superseded, says so when offline), "Use current view" (visible bounds become a rectangle), "Locate me" (browser geolocation), and "Type the numbers instead" (rectangle bounds, circle centre + radius) as the keyboard path. "Add vertex at centre" lets keyboard users build a polygon by panning with the arrow keys.
- **Feedback**: live area (km2), rough perimeter, vertex count, warnings under 0.05 km2 or over 25,000 km2, and blocking errors (fewer than 3 vertices, self-intersection, out-of-range coordinates, more than 500 vertices). Save stays disabled with the reasons listed. The editor works on a blank background when tiles cannot load.
- **Data**: `region` keeps the legacy box (`min_lat..max_lng`, always computed by the client from the polygon, recomputed by the server) and adds `geofence` (GeoJSON Polygon) plus an optional `circle` hint (circles are saved as 64-segment polygons). A legacy box-only region is shown as a rectangle and can be edited.
- **Display**: the Overview and Incident Map draw the outline with a subtle fill, fit to it on load, and have an "Event geofence" layer toggle; the event list shows a tile-free SVG outline, the area and the bounds.

Why our own editor instead of `@geoman-io/leaflet-geoman-free`: Geoman is good, but it brings a toolbar we would have to restyle and hide, its own text/undo model, and about 200 kB for three shape types. We needed rectangle/circle/polygon with typed fallbacks, one-shape-only semantics, a shared undo stack with the numeric form, vertex deletion rules and keyboard affordances, all of which sit on top of Geoman rather than inside it. The editor is about 450 lines on plain Leaflet (`components/GeofenceEditor.tsx`), the geometry is a pure module (`lib/geofence.ts`, byte-identical to `server/src/domain/geofence.ts` and tested with the same cases on both sides) and shape logic is unit tested (`lib/geofenceShape.ts`, `lib/shapeHistory.ts`).

## Behaviour worth knowing

- **Auth**: access token lives in memory only. The refresh token is kept in `sessionStorage` so a reload keeps the session; any 401 triggers one shared `POST /auth/refresh` and a retry, and a failed refresh returns to the login screen.
- **Live updates**: `WS /v1/ws?token=` with exponential backoff (1 s up to 30 s, jittered), a fresh token per attempt, 25 s ping and an indicator in the header. Events patch the query caches (`sos.*`, `heartbeat.*`, `deadzones.updated`, `mesh.stats`) or invalidate them (`checkin.*`, `assignment.*`). After a reconnect the app refetches `GET /sos?updated_since=` and invalidates the rest, because events are not replayed.
- **Privacy**: exact coordinates are shown only when the API returns `location` (assignee or admin). Otherwise the case is drawn as its approximate circle (`radius_m`) and described as "Within 1 km of 32.78, -96.80"; popups and the panel say which precision is on screen.
- **Conflicts**: claiming an already claimed case (409) shows who has it and refreshes the queue; invalid status transitions and resolve-without-outcome are explained, not swallowed.
- **Demo tools** (seed / simulate relay / clear) live under Events & Settings. The endpoints answer 404 outside `DEMO_MODE`; the page probes with a zero-case seed when an event is active (no side effects) and otherwise learns from the first 404 and then hides the tools.
- **Heat layer**: a smooth density surface, not one circle per cell. `src/components/HeatLayer.ts` is a small custom Leaflet canvas layer (`leaflet.heat` was rejected: its radius is in pixels instead of metres, it blends with source-over instead of summing, it is unmaintained since 2019 and untyped). Each point splats a Gaussian into a coarse float grid (4 px, separable kernel, anchored to map space so panning does not shimmer); contributions add, `normalise()` soft-saturates them (`1 - exp(-v/2)`, absolute, so a lone case is dim and about five overlapping critical cases saturate), a 256-entry colour LUT maps teal/blue -> amber -> orange -> red with a rising alpha (base map stays readable), and the small image is upscaled with bilinear smoothing onto a `devicePixelRatio`-aware canvas in its own pane (above tiles, below vectors and pins). It redraws on `move`/`moveend`/`zoomend`/resize through `requestAnimationFrame`. Pure parts live in `src/lib/heat.ts` (weights, radius-for-zoom, cell expansion, ramp, legend data) and are unit tested.
  - Weight: `score/100`, x1.2 for critical (80+), x1.35 for silent, capped at 1.6; a cell adds `1 + 0.6*log2(count)` of its worst score. Open silent cases add an extra point on top of the cells. Kernel sigma is half a cell in metres at the current zoom, clamped to 10..90 px, times the Heat radius option (small 0.6, medium 1, large 1.8).
  - Data: `GET /map/heat` (bbox follows the padded, debounced view; `cell_km` shrinks with zoom from 5 to the API minimum of 1) is the base. If it fails or is loading, the open cases' **approximate** locations are used. Exact `location` is never read, so the heat can never reveal more than the ~1 km grid.
  - **Active cases only** (reported, assigned, en_route, on_scene; the server query and the client filter agree). Resolved, closed and merged duplicates add nothing; `sos.*`, `sos.merged` and `assignment.*` WS events refetch the heat (trailing-throttled, 0.8 s) so a resolved case fades out live.
  - Controls: layer toggle, opacity slider, Heat radius small/medium/large (disabled while the layer is off). The legend shows the gradient bar with Low/High and "Weighted by urgency; silent cases count extra. Only active cases." Tile failure leaves the heat on a blank background.
- Dark mode is not implemented; colours are CSS custom properties in `mock.css` so a dark theme is a token swap.

## Tests

`npm test` runs Vitest (jsdom): pure helpers (tier colours, hop paths, ages, query building, privacy, ws reducers, feed sentences, escalation, stats, socket backoff), the API client (bearer, refresh-and-retry, 409 details, network errors), cache patching for every ws event type, and component smoke tests (queue card, device card, status trail, confirm dialog, map popup, login).
