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
| `summary` | `GET /api/v3/data/summary?system_id=` (the inverter poll) |
| `aggregateMin`, `aggregateDay` | `GET /api/v3/data/aggregate?...&level=min|day` (the panel poll; CSV kept as `{ csv }`) |
| `mobileSystems`, `mobileHomepage`, `mobileLayout`, `mobileEquipments`, `mobilePanelPower`, `mobilePanelEnergy` | the Tigo app's API (`mapi.tigoenergy.com`), fallback without EI Premium; stubs from JeremyWhittaker/tigo_home_assistant's fixtures |

The login response is never captured (it holds the token). The username and password are logged once per account per arm (`credentials`); `from-logs.js` adds them to `zzz_docs/creds.txt`, not to the captures. A refused request is captured as `<name>Error` = `{ status, body }`, also a refused login (`loginError`, `mobileLoginError`).

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
| `pairing.js` | Login (Basic, then Bearer), one device per system with its name, id, settings and the manifest capabilities, no migration at the first start; no systems gives `errors.noSystem`. |
| `client.js` | Token handling and the error bodies seen live: 402 "Premium required", the 402 of the data endpoints, 401, 429, and a non-JSON answer. A 429 starts a cooldown (Retry-After, else 5 min) in which nothing is sent; a 401 logs in again and retries once. |
| `device.js` | `alarm_connectivity` after 24 h without new data (power cleared, device stays available), polling every 10 min after 30 min without new data, a 429 leaving the device available, `onUninit` storing the held-back lifetime reading. |
| `repair.js` | A new login is stored and restarts the device; a login without the system is refused and changes nothing. |
| `locales.js` | All 13 languages in every compose translation object, the same keys in every `locales/*.json`, a README per language. |
| `panel.js` | Panel driver: own capabilities and `energy.excludedByDefault` (out of Homey Energy), icons present, the CSV parser (repeated header, empty and `-` cells), local start/end, one device per layout panel, one poll of 5 requests (Pin, Vin, Iin, RSSI per minute, Pin per day) for all panels of a system, yield vs the string's median, underperforming after 3 days under 85% (dark days not counted), 5/30-min cadence, no minute clears power, 402 vs 429, the Energy toggle not re-registering, separate captures. |
| `mobile.js` | The Tigo app's API as fallback: login body and headers, 401 re-login, capture names, units (kW/W, Wh/kWh, `-`), pairing on it when the official API lists no system (notice, no `alarm_problem`), a 402 moving a device or a panel system to it, back once a day when EI Premium works again, 5/30-min cadence, panel power per gateway within an hour. |
| `capture.js` | Arm/claim, the client recording every endpoint but never the login, round trip through a timestamped report, truncation reported, redaction of address, coordinates and contacts. |

## Adding a case

Drop a file in `cases/` exporting `async (t) => {}`; use `t.ok`, `t.eq`, `t.skip`, `t.log` and the
helpers in `fixtures.js` (`get`, `isReal`, `routeHttps`, `makeClient`, `makeDevice`, `makeDriver`).
