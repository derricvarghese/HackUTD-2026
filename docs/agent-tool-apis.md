# Free external APIs for the dispatch agent: verified cheat sheet

Tested with curl from the build machine on 2026-11-08. Test point: Dallas, TX (32.7767, -96.7970).
Error cases: Pacific (-40.0, -170.0) and an ocean point (-40.0, -30.0).

Every call sends this header (no email address anywhere):

```
User-Agent: BeaconHackUTD/1.0 (hackutd.alecj.com)
```

All timeouts are client-side. Treat every external call as optional: the agent must degrade gracefully.

---

## 1. NWS api.weather.gov

### 1a. Active alerts for a point: works

```bash
curl -s -H "User-Agent: BeaconHackUTD/1.0 (hackutd.alecj.com)" \
  -H 'Accept: application/geo+json' \
  'https://api.weather.gov/alerts/active?point=32.7767,-96.7970'
```

- Latency about 0.1 s. Dallas had no active alerts at test time: HTTP 200, `features: []`,
  plus `title` and `updated`. This is "no alerts", not an error.
- Out of bounds (`-40.0,-170.0`): HTTP 400, `"title": "Invalid Parameter"`.
- A point inside a polygon returns that alert. `point=29.7644,-99.2311` returned one feature.
  Real feature (trimmed from a live Texas response):

```json
{
  "type": "Feature",
  "geometry": { "type": "Polygon", "coordinates": [[[-99.2, 29.7]]] },
  "properties": {
    "event": "Flood Advisory",
    "severity": "Minor",
    "urgency": "Expected",
    "certainty": "Likely",
    "headline": "Flood Advisory issued November 8 at ...",
    "description": "...",
    "effective": "2026-11-08T00:34:00-06:00",
    "expires": "2026-11-08T02:00:00-06:00",
    "areaDesc": "Kinney; Val Verde"
  }
}
```

- `geometry` can be `null` for zone-based alerts. Use `properties` only when it is absent.
- Server sends `cache-control: max-age=5`. Cache 60 s on our side.
- Rate limit: none published. One request per point per minute is polite.
- Failure modes: occasional 5xx and 429 under load. Timeout 5 s, one retry after 1 s.

### 1b. Point metadata and forecast URL: works

```bash
curl -s -H "User-Agent: BeaconHackUTD/1.0 (hackutd.alecj.com)" \
  -H 'Accept: application/geo+json' \
  'https://api.weather.gov/points/32.7767,-96.7970'
```

```json
{
  "properties": {
    "forecast": "https://api.weather.gov/gridpoints/FWD/89,104/forecast",
    "forecastHourly": "https://api.weather.gov/gridpoints/FWD/89,104/forecast/hourly",
    "gridId": "FWD", "gridX": 89, "gridY": 104,
    "relativeLocation": { "properties": { "city": "Dallas", "state": "TX" } }
  }
}
```

- Outside coverage (`-40.0,-30.0`): HTTP 404.
- Following `properties.forecast` returned 200 in 0.05 s. First period: `"Tonight"`,
  `temperature: 54`, `shortForecast: "Mostly Cloudy"`.
- Cache per point for 24 h (grid IDs are stable).

---

## 2. Stream gauges: USGS and NWPS

### 2a. USGS Water Services instantaneous values: works

Parameters: `00065` gage height (ft), `00060` discharge (ft3/s).

Gauges near a point, using a bounding box (west,south,east,north) of about 0.3 degrees around it:

```bash
curl -s -H "User-Agent: BeaconHackUTD/1.0 (hackutd.alecj.com)" \
  'https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=-97.2,32.5,-96.6,33.0&parameterCd=00065,00060&siteStatus=active&period=PT3H'
```

Recent values for one site (a single site takes 0.6 s, while the bBox took 4.7 s):

```bash
curl -s 'https://waterservices.usgs.gov/nwis/iv/?format=json&sites=08049500&parameterCd=00065,00060&period=PT3H'
```

Site lookup (RDB, cheap): `/nwis/site/?format=rdb&bBox=...&siteType=ST&siteStatus=active&parameterCd=00065`
returns `site_no`, `station_nm`, `dec_lat_va`, `dec_long_va`. Sort by haversine distance.

Quirks:

- The JSON is a JAXB envelope. Data lives under `value.timeSeries`.
- No gauges in the box (`-120.0,40.0,-119.9,40.1`): HTTP 200 with `value.timeSeries: []`.
- Bad `period`: HTTP 400.
- Missing values are `noDataValue: -999999.0`. Qualifier `P` means provisional.

Trimmed real response (Grand Prairie, 08049500, 3 h):

```json
{
  "value": { "timeSeries": [{
    "sourceInfo": {
      "siteName": "W Fk Trinity Rv at Grand Prairie, TX",
      "siteCode": [{ "value": "08049500" }],
      "geoLocation": { "geogLocation": { "latitude": 32.7625, "longitude": -96.9944444 } }
    },
    "variable": { "variableCode": [{ "value": "00065" }], "unit": { "unitCode": "ft" }, "noDataValue": -999999.0 },
    "values": [{ "value": [
      { "value": "2.31", "qualifiers": ["P"], "dateTime": "2026-11-07T21:45:00.000-06:00" },
      { "value": "2.31", "qualifiers": ["P"], "dateTime": "2026-11-07T23:30:00.000-06:00" }
    ]}]
  }]}
}
```

Trend: take the oldest and newest non-noData values, divide the delta by the hours between timestamps,
and label `rising`, `falling`, or `steady` with a dead band (about 0.05 ft/h). At test time this gauge was
flat: 2.31 ft and 187 ft3/s across 8 readings.

- Cache 5 to 15 min (instantaneous values update about every 15 min).
- No key. Occasional 503 or timeout. Timeout 10 s (bBox 15 s).

### 2b. NWS NWPS flood stage (api.water.noaa.gov): works

NWPS gives flood stage thresholds and the observed category. The bounding-box query needs
`srid=EPSG_4326`, or it returns an empty list.

```bash
curl -s -H "User-Agent: BeaconHackUTD/1.0 (hackutd.alecj.com)" \
  'https://api.water.noaa.gov/nwps/v1/gauges?srid=EPSG_4326&bbox.xmin=-97.1&bbox.ymin=32.6&bbox.xmax=-96.6&bbox.ymax=33.0&limit=50'
```

Returned 8 gauges, including `DALT2` (Trinity River at Dallas) and `CART2`. Gauge detail,
`GET /nwps/v1/gauges/CART2`, trimmed:

```json
{
  "lid": "CART2",
  "usgsId": "08055500",
  "name": "Elm Fork Trinity River near Carrollton",
  "status": {
    "observed": { "primary": 3.44, "primaryUnit": "ft", "floodCategory": "no_flooding",
                  "validTime": "2026-11-08T05:15:00Z" },
    "forecast": { "primary": -999, "floodCategory": "fcst_not_current" }
  },
  "flood": { "categories": {
    "major": { "stage": 12 }, "moderate": { "stage": 10 }, "minor": { "stage": 9 }, "action": { "stage": 8 }
  }}
}
```

- Series: `GET /nwps/v1/gauges/{lid}/stageflow` (200 in 0.4 s) gives `observed.data` and `forecast.data`.
- Unknown lid: HTTP 404. `forecast.primary: -999` means no current forecast; never use it as a stage.
- Categories seen: `no_flooding`, `fcst_not_current`. Expected: `action`, `minor`, `moderate`, `major`.
- Cache 15 min for status, hours for metadata. Timeout 5 s. No key.
- Join NWPS to USGS on `usgsId`. The bbox list shows it as null, so fetch the detail call.

`water.noaa.gov/gauges/{lid}` returns HTML (HTTP 200). Do not parse it; use the API.

---

## 3. OpenStreetMap Overpass

### Query (5 facility types in one call)

Replace `RADIUS`, `LAT`, `LNG`. `nwr` = node, way or relation. `out center` gives a point for ways.

```
[out:json][timeout:25];
(
  nwr(around:RADIUS,LAT,LNG)["amenity"="hospital"];
  nwr(around:RADIUS,LAT,LNG)["healthcare"="hospital"];
  nwr(around:RADIUS,LAT,LNG)["amenity"="shelter"];
  nwr(around:RADIUS,LAT,LNG)["emergency"="assembly_point"];
  nwr(around:RADIUS,LAT,LNG)["amenity"="fire_station"];
);
out center 20;
```

Dallas example (3 km), POST form-encoded:

```bash
curl -s -H "User-Agent: BeaconHackUTD/1.0 (hackutd.alecj.com)" \
  --data-urlencode 'data=[out:json][timeout:25];(nwr(around:3000,32.7767,-96.7970)["amenity"="hospital"];nwr(around:3000,32.7767,-96.7970)["healthcare"="hospital"];nwr(around:3000,32.7767,-96.7970)["amenity"="shelter"];nwr(around:3000,32.7767,-96.7970)["emergency"="assembly_point"];nwr(around:3000,32.7767,-96.7970)["amenity"="fire_station"];);out center 20;' \
  https://overpass-api.de/api/interpreter
```

`out center 20` caps the element count. The 3 km query returned 9 elements (about 9 KB).

```json
{ "type": "way", "id": 401521703,
  "center": { "lat": 32.7742625, "lon": -96.7961485 },
  "tags": { "name": "Dallas Fire Station Number 4", "amenity": "fire_station" } }
```

Nodes carry `lat`/`lon` directly, not `center`. Normalize both.

### Mirrors (tested)

| Endpoint | Result from here |
|---|---|
| `https://overpass-api.de/api/interpreter` | Works, flaky: 504 once (52 s), then 200 in 12 s and 34 s |
| `https://overpass.kumi.systems/api/interpreter` | Timed out at 30 s |
| `https://overpass.private.coffee/api/interpreter` | Timed out at 30 s |
| `https://maps.mail.ru/osm/tools/overpass/api/interpreter` | 504 in 1 s |

Use overpass-api.de with a 30 s client timeout and one retry after 2 s on 429 or 504. Cache 24 h per
rounded point and radius. Empty result is `{"elements": []}` with HTTP 200. Parse only after checking the
status code, since 504 bodies are plain text. Latency is 11 to 35 s, so warm the cache when an incident is
created and never block the dispatch loop on it.

---

## 4. Routing: OSRM demo and alternatives

### 4a. Driving route: works

Coordinates are lng,lat.

```bash
curl -s -H "User-Agent: BeaconHackUTD/1.0 (hackutd.alecj.com)" \
  'https://router.project-osrm.org/route/v1/driving/-96.7970,32.7767;-96.7339,32.8140?overview=false'
```

```json
{ "code": "Ok", "routes": [{ "duration": 661.2, "distance": 9455.6 }],
  "waypoints": [{ "location": [-96.796754, 32.775944], "distance": 86.95 }] }
```

- `duration` is seconds, `distance` is meters. Latency 0.6 s.
- `waypoints[].distance` is the snap distance to the road in meters. Use it to reject bad input.
- Off-network points still return `"code": "Ok"`, with `duration: 0`. Reject zero-duration routes for
  distinct points.

### 4b. Table (one destination, several responders): works

Sources are separated by `;`. Commas break it (`InvalidQuery`).

```bash
curl -s -H "User-Agent: BeaconHackUTD/1.0 (hackutd.alecj.com)" \
  'https://router.project-osrm.org/table/v1/driving/-96.7970,32.7767;-96.7339,32.8140;-96.8500,32.8000;-96.6300,32.7500?sources=0;1;2&destinations=3&annotations=duration,distance'
```

Real response (0.6 s): `durations: [[1219],[1151.2],[1652.9]]`, plus `distances` in meters and
snapped `sources`/`destinations`. Keep under about 100 coordinates.

### Demo policy and reliability

The demo server is for light testing: no SLA, not for production or heavy automated use (documented
policy; not re-verified live). It worked here at 0.6 s but can go down. Use it with a 5 s timeout,
caching, and a straight-line fallback (haversine times 1.4 for urban roads). Self-host OSRM with a Texas
extract for anything real.

### Alternatives (reachability only; no keys requested)

- Valhalla public instance: `https://valhalla1.openstreetmap.de/status` returned 200 in 0.66 s. Keyless.
  Route API is a JSON POST. Route call not tested.
- OpenRouteService: root returned 200 in 0.9 s. Routing needs an API key (free tier, sign-up required).

---

## 5. Reverse geocoding: Nominatim

Usage policy (as documented): at most 1 request per second, a valid identifying User-Agent, cache results,
no bulk geocoding. Self-host Nominatim or use a keyed provider for production.

```bash
curl -s -H "User-Agent: BeaconHackUTD/1.0 (hackutd.alecj.com)" \
  'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=32.7767&lon=-96.7970&zoom=18&addressdetails=1'
```

```json
{ "lat": "32.7762714", "lon": "-96.7969417", "name": "Dallas City Hall",
  "display_name": "Dallas City Hall, 1500, Marilla Street, Downtown PID, Dallas, Dallas County, Texas, 75242, United States",
  "address": { "road": "Marilla Street", "house_number": "1500", "city": "Dallas",
               "county": "Dallas County", "state": "Texas", "postcode": "75242", "country_code": "us" } }
```

- No match (ocean point): HTTP 200 with `{"error":"Unable to geocode"}`. Check the `error` key.
- Latency 0.5 s. Cache 30 days per coordinate rounded to 5 decimals (about 1 m).
- No-key alternative: self-host Nominatim. Photon (`photon.komoot.io`) is another keyless OSM geocoder
  with a similar policy; not tested here.

---

## 6. Optional: FEMA NFHL flood zones: works, no key

```bash
curl -s -H "User-Agent: BeaconHackUTD/1.0 (hackutd.alecj.com)" \
  'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=-96.7970,32.7767&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY&returnGeometry=false&f=json'
```

- Dallas: HTTP 200 in 0.18 s, `{"attributes": {"FLD_ZONE": "X", "ZONE_SUBTY": "AREA OF MINIMAL FLOOD HAZARD"}}`.
  A second Dallas point (32.8350,-96.8100) was also X, so the sample did not hit a high-risk zone.
- High-risk zones: `A`, `AE`, `AO`, `AH`, `V`, `VE`. `X` is minimal, `D` is undetermined.
- Ocean point: HTTP 200, `features: []`. Means "unmapped", not "no risk".
- Cache 30 days per point. Timeout 5 s. Government host, so availability varies.

---

## Final table

| API | Tool name suggestion | Input | Output fields used | Timeout | Cache TTL | Reliability verdict |
|---|---|---|---|---|---|---|
| NWS active alerts | `get_active_alerts` | lat, lng | event, severity, urgency, certainty, headline, description, effective, expires, areaDesc | 5 s + 1 retry | 60 s | works |
| NWS point metadata | `get_point_forecast` | lat, lng | forecast, forecastHourly, gridId, gridX, gridY, relativeLocation.city | 5 s | 24 h | works |
| USGS IV (gage height, discharge) | `get_stream_readings` | site ids or bBox, period | siteName, siteCode, values[].value, dateTime, qualifiers | 10 s (bBox 15 s) | 5 to 15 min | works |
| USGS site lookup | `find_nearby_gauges` | bBox | site_no, station_nm, dec_lat_va, dec_long_va | 10 s | 24 h | works |
| NWPS flood stage | `get_flood_stage` | lid, or bbox with srid | flood.categories, status.observed.primary, floodCategory, usgsId | 5 s | 15 min | works |
| Overpass facilities | `find_nearby_facilities` | lat, lng, radius m | tags.name, tags.amenity, tags.healthcare, lat/lon or center | 30 s + 1 retry | 24 h | flaky (overpass-api.de only) |
| OSRM route | `route_drive_time` | from and to lng,lat | duration (s), distance (m), waypoints[].distance | 5 s | 1 h | works (demo, light use) |
| OSRM table | `route_drive_matrix` | sources, destination | durations, distances | 5 s | 1 h | works (demo, light use) |
| Valhalla (alternative) | n/a | JSON POST | n/a | 5 s | 1 h | reachable, route call untested |
| OpenRouteService (alternative) | n/a | API key needed | n/a | n/a | n/a | reachable, needs key, untested |
| Nominatim reverse | `reverse_geocode` | lat, lng | display_name, address.road, address.city, address.postcode, error | 5 s | 30 days | works (1 req/s max) |
| FEMA NFHL flood zone | `check_flood_zone` | lat, lng | FLD_ZONE, ZONE_SUBTY | 5 s | 30 days | works |

Blocked from this machine: nothing. The only hard failures were the Overpass mirrors (timeouts and 504s),
and the NWS 400 and 404 responses for out-of-bounds and uncovered points, which are input errors rather
than outages.
