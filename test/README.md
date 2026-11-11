# Offline test suite

Runs the app's real code (client, device mapping, pairing, capture) with no network and no
credentials.

```bash
npm test                  # everything, plus the older solar-titles/migration tests and the shared-file check
node test/run.js          # the cases only
node test/run.js mapping  # one case file, matched by substring
```

## Fixtures

The suite prefers **real captures** (`test/captures/<site>/*.json`) and falls back to **stubs
from the Tigo REST API V3 document** (`zzz_docs/Tigo_REST_API_V3_2019.pdf`, hard-coded in
`fixtures.js`). The first line of output says which. Cases derive their expectations from the
fixture, so they work on both.

| name | endpoint |
| --- | --- |
| `systems` | `GET /api/v3/systems` |
| `system` | `GET /api/v3/systems/{id}` |
| `layout` | `GET /api/v3/systems/layout?id=` |
| `objects` | `GET /api/v3/objects/system?system_id=` |
| `sources` | `GET /api/v3/sources/system?system_id=` |
| `summary` | `GET /api/v3/data/summary?system_id=` (the device poll) |

The login is never captured (it holds the token).

## Getting real captures

**From a user's diagnostics report.** The app logs every API response once while armed: app start,
device (re)start and pairing (`lib/tigoCapture.js`). Ask the user to restart the app, wait a
minute, then create a diagnostics report. Save it and:

```bash
node test/from-logs.js report.txt --dry            # list what it contains, write nothing
node test/from-logs.js report.txt                  # write test/captures/<site>/*.json
node test/from-logs.js report.txt --site my-house  # choose the site folder
```

**From a Premium account:** `node test/capture.js <username> <password> [--site name]`.

## The cases

| File | What it protects |
| --- | --- |
| `mapping.js` | `data/summary` to `measure_power`, `meter_power.today` and `meter_power` (Wh to kWh), a missing summary as an error, the lifetime counter held on one lower reading, `alarm_problem` from `recent_alerts_count`. |
| `pairing.js` | Login (Basic, then Bearer), one device per system with its name, id, settings and the manifest capabilities; no systems gives `errors.noSystem`. |
| `client.js` | Token handling and the error bodies seen live: 402 "Premium required", the 402 of the data endpoints, 401, 429, and a non-JSON answer. |
| `capture.js` | Arm/claim, the client recording every endpoint but never the login, round trip through a timestamped report, truncation reported, redaction of address, coordinates and contacts. |

## Adding a case

Drop a file in `cases/` exporting `async (t) => {}`; use `t.ok`, `t.eq`, `t.skip`, `t.log` and the
helpers in `fixtures.js` (`get`, `isReal`, `routeHttps`, `makeClient`, `makeDevice`, `makeDriver`).
