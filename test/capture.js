'use strict';

/*
Capture real API responses from an account into test/captures/<site>/, through the app's own
client and capture module, so the files equal what a diagnostics report would give.

    node test/capture.js <username> <password> [--site name]

Needs an EI Premium account (the API answers 402 "Premium required" otherwise). Requests are
spaced 1.5 s apart.
*/

const fs = require('node:fs');
const path = require('node:path');
const TigoClient = require('../tigo');
const capture = require('../lib/tigoCapture');

const args = process.argv.slice(2);
const [username, password] = args;
const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : undefined;
if (!username || !password || username.startsWith('--')) {
  console.error('usage: node test/capture.js <username> <password> [--site name]');
  process.exit(1);
}

const slug = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

(async () => {
  const lines = [];
  const client = new TigoClient({ username, password, log: (line) => lines.push(line) });
  capture.arm('test/capture.js', { force: true });
  await client.login();
  const { systems = [] } = await client.getSystems();
  if (!systems.length) throw Error('no systems on this account (no Premium, or none linked)');
  const id = systems[0].system_id;
  for (const call of ['getSystems', 'getLayout', 'getObjects', 'getSources', 'getStatus']) {
    await sleep(1500);
    try {
      await client[call]({ id });
    } catch (error) {
      console.log(`  ${call}: ${error.message}`);
    }
  }
  const { captures } = capture.parseLog(lines.join('\n'));
  const OUT = path.join(__dirname, 'captures', siteArg ? slug(siteArg) : slug(systems[0].name || id));
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, payload] of Object.entries(captures)) {
    fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`  saved  ${path.relative(path.join(__dirname, '..'), OUT)}/${name}.json`);
  }
  console.log('\nDone. Run `npm test` - the banner should now name the captures.');
})().catch((error) => {
  console.error(`\nCapture failed: ${error.message}`);
  process.exit(1);
});
