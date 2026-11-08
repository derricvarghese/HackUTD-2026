# Beacon responder dashboard

React 19 + TypeScript (strict) + Vite single-page app for responders and admins. It is built into `../server/public` and served by the Express server at `/` (same origin, relative `/v1` URLs, `wss://<host>/v1/ws`), so no CORS setup is needed in production.

Design reference: `../server/lifeline-dashboard-mock.html` (a static mock, not shipped). The app reproduces its look (navy sidebar, orange accent, stat tiles, ranked queue cards, map card with layers/legend/popup, mesh health, neighbour offers) and wires every panel to the real API in `../openapi.yaml`. Every number on screen comes from the API; where the API has no data for a mock element (flood-risk layer, "phones relaying", AI assistant chip) the element is dropped or replaced by something real (for example "Latest escalation" is the most recent silent case or unclaimed critical case).

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
src/views      Login, Overview, MapPage, Queue, Checkins, Mesh, Responders, Assist, Settings
src/styles     mock.css (the mock's CSS, verbatim) + extras.css (a11y, states, responsive)
```

Libraries: TanStack Query (cache, retries, invalidation), zustand (tiny state), react-router (deep-linkable views), Leaflet with OpenStreetMap raster tiles (light, no API key; the map renders on a blank background when tiles are unreachable). No UI kit.

## Views and endpoints

| View | Shows | Endpoints |
|---|---|---|
| Overview | stat tiles, map, ranked queue with tabs, live feed, mesh health, neighbour offers | `GET /sos` (sort=priority, all pages), `/responders`, `/heartbeats/silent`, `/mesh/stats`, `/server-info`, `/map/deadzones`, `/map/heat`, `/offers`, `/offers/{id}/matches`, `/health`, `POST /assignments`, `POST /heartbeats/silent/{id}/promote` |
| Incident Map | map in view, cases in view, dead zones with "being checked"/dismiss | same plus `PATCH /map/deadzones/{id}` |
| Triage Queue | filterable table (tabs, server-side search `q`, include resolved) and case panel: score reasons, extracted entities, relay path, check-ins, history, notes, matched offers, merged reports, voice note | `GET /sos`, `GET /sos/{id}`, `/sos/{id}/events`, `PATCH /sos/{id}` (notes, score override), `POST /sos/{id}/retriage`, `/merge`, `/unmerge`, `/checkins`, `GET /sos/{id}/voice-note`, `POST/PATCH/DELETE /assignments`, `DELETE /sos/{id}` (admin) |
| Check-ins | sent/answered/missed per open case, who is overdue ("Check in now"), silent phones (acknowledge, make case), timing rules from `/server-info` | `GET /sos/{id}/checkins`, `POST /sos/{id}/checkins`, `/heartbeats/silent` (+ PATCH, promote) |
| Mesh Network | stats, longest relay chain diagram, hop limits, hop histogram, rejections, busiest gateways | `/mesh/stats`, `/server-info`, `/sos` |
| Responders | table, active case timeline and quick actions, admin add/edit/delete | `/responders` (CRUD, admin), `/assignments` |
| Neighbor Assist | offers, suggested matches, send/decline/deliver, manual match, withdraw, needs by category | `/offers`, `/offers/{id}/matches` (+ PATCH/DELETE) |
| Events & Settings | events (create, close, purge, delete with confirmations, admin), demo tools, server info | `/events`, `/events/{id}/close`, `/purge`, `/mesh/seed`, `/mesh/simulate` |

Role awareness: admin-only controls (responder CRUD, events, delete case) are hidden for other roles; volunteers get a read-only queue (no claim/advance). The server remains the authority and answers 403/409 which are shown as toasts.

## Behaviour worth knowing

- **Auth**: access token lives in memory only. The refresh token is kept in `sessionStorage` so a reload keeps the session; any 401 triggers one shared `POST /auth/refresh` and a retry, and a failed refresh returns to the login screen.
- **Live updates**: `WS /v1/ws?token=` with exponential backoff (1 s up to 30 s, jittered), a fresh token per attempt, 25 s ping and an indicator in the header. Events patch the query caches (`sos.*`, `heartbeat.*`, `deadzones.updated`, `mesh.stats`) or invalidate them (`checkin.*`, `assignment.*`, `offer.*`). After a reconnect the app refetches `GET /sos?updated_since=` and invalidates the rest, because events are not replayed.
- **Privacy**: exact coordinates are shown only when the API returns `location` (assignee or admin). Otherwise the case is drawn as its approximate circle (`radius_m`) and described as "Within 1 km of 32.78, -96.80"; popups and the panel say which precision is on screen.
- **Conflicts**: claiming an already claimed case (409) shows who has it and refreshes the queue; invalid status transitions and resolve-without-outcome are explained, not swallowed.
- **Demo tools** (seed / simulate relay / clear) live under Events & Settings. The endpoints answer 404 outside `DEMO_MODE`; the page probes with a zero-case seed when an event is active (no side effects) and otherwise learns from the first 404 and then hides the tools.
- Heat layer: `GET /map/heat` requires a `bbox`, so it follows the current map view.
- Dark mode is not implemented; colours are CSS custom properties in `mock.css` so a dark theme is a token swap.

## Tests

`npm test` runs Vitest (jsdom): pure helpers (tier colours, hop paths, ages, query building, privacy, ws reducers, feed sentences, escalation, stats, socket backoff), the API client (bearer, refresh-and-retry, 409 details, network errors), cache patching for every ws event type, and component smoke tests (queue card, device card, status trail, confirm dialog, map popup, login).
