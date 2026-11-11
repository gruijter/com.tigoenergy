# Captures

Real API responses, one folder per site (`test/captures/<site>/*.json`). `npm test` runs every
case against each site and falls back to the doc stubs in `fixtures.js` for what a site lacks.

Fill a site from a diagnostics report (`node test/from-logs.js report.txt`) or from a Premium
account (`node test/capture.js <username> <password>`). See `test/README.md`.

These files stay local: they hold real system names and serials, so everything here except this
README is gitignored. Addresses, coordinates and contact details are redacted at capture time.
