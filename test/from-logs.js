'use strict';

/*
Turn a user's diagnostics report into test fixtures.

    node test/from-logs.js <report.txt>              write test/captures/<site>/*.json
    node test/from-logs.js <report.txt> --dry        show what it found, write nothing
    node test/from-logs.js <report.txt> --force      overwrite captures that already exist
    node test/from-logs.js <report.txt> --site name  put them under test/captures/name/

The site folder defaults to the system name (else system_id). Reads the capture blocks written by
lib/tigoCapture.js.
*/

const fs = require('node:fs');
const path = require('node:path');
const capture = require('../lib/tigoCapture');

const CAPTURES = path.join(__dirname, 'captures');
const args = process.argv.slice(2);
const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : undefined;
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--site');
const dryRun = args.includes('--dry');
const force = args.includes('--force');

if (!file || !fs.existsSync(file)) {
  console.error(file ? `No such file: ${file}` : 'usage: node test/from-logs.js <report.txt> [--dry] [--force] [--site name]');
  process.exit(1);
}

const slug = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
const siteOf = (caps) => {
  const system = (caps.systems && caps.systems.systems && caps.systems.systems[0]) || (caps.system && caps.system.system) || {};
  return slug(system.name || system.system_id || 'site') || 'site';
};
// a Tigo error body; the client throws on these, so they should never be captured
const isError = (payload) => payload.isSuccess === false || payload.type === 'api_error' || Number(payload.status) >= 400;

const { captures, errors } = capture.parseLog(fs.readFileSync(file, 'utf8'));
const names = Object.keys(captures).sort();
if (!names.length) {
  console.error('No capture blocks found. The report must come from an app version that logs them,');
  console.error('and the user must have restarted the app (or paired) while that version was running.');
  if (errors.length) console.error(`\n${errors.join('\n')}`);
  process.exit(1);
}
const site = siteArg ? slug(siteArg) : siteOf(captures);
const OUT = path.join(CAPTURES, site);
console.log(`Found ${names.length} capture(s) in ${path.basename(file)} -> test/captures/${site}/\n`);

let written = 0;
for (const name of names) {
  const target = path.join(OUT, `${name}.json`);
  const exists = fs.existsSync(target);
  const payload = captures[name];
  const size = JSON.stringify(payload).length;
  if (isError(payload)) console.log(`  skip   ${name}  (error body)`);
  else if (dryRun) console.log(`  would  ${name}  ${size} bytes${exists ? ' (overwrites existing)' : ''}`);
  else if (exists && !force) console.log(`  keep   ${name}  (already present - pass --force to overwrite)`);
  else {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`  write  ${name}  ${size} bytes`);
    written += 1;
  }
}
if (errors.length) console.log(`\nProblems:\n  ${errors.join('\n  ')}`);
console.log(dryRun ? '\nDry run, nothing written.' : `\n${written} written. Run \`npm test\`.`);
