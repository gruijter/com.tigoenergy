'use strict';

/*
The diagnostics-report capture path end to end: arm, log, parse back.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const capture = fixtures.app('lib/tigoCapture.js');

  // 1. nothing is logged until armed, and an endpoint only once per arm
  fixtures.routeHttps();
  const quiet = [];
  capture.arm('reset', { force: true });
  capture.record('/api/v3/data/summary', fixtures.get('summary'), (l) => quiet.push(l));
  const before = quiet.length;
  capture.record('/api/v3/data/summary?system_id=1', fixtures.get('summary'), (l) => quiet.push(l));
  t.ok(before > 0, 'an armed endpoint is logged');
  t.eq(quiet.length, before, 'the same endpoint is not logged again until re-armed');

  // 2. the client records what it receives; the login (token) never
  const lines = [];
  const recording = fixtures.makeClient(lines);
  capture.arm('app start', { force: true });
  await recording.login();
  await recording.getSystems();
  await recording.getSystems({ id: 1 });
  await recording.getLayout({ id: 1 });
  await recording.getObjects({ id: 1 });
  await recording.getSources({ id: 1 });
  await recording.getStatus({ id: 1 });
  const text = lines.join('\n');
  t.ok(!text.includes(fixtures.get('login').user.auth), 'the login token is never logged');
  const { captures, errors } = capture.parseLog(text);
  t.eq(errors.length, 0, `parsing the log produced no errors (${errors.join('; ')})`);
  for (const name of ['systems', 'system', 'layout', 'objects', 'sources', 'summary']) {
    t.ok(captures[name], `${name} came back out of the log`);
  }
  t.eq(captures.login, undefined, 'there is no login capture');

  // 3. a timestamped CRLF report round-trips; only the redacted fields differ
  const wrapped = lines.map((l, i) => `2026-11-11T10:0${i % 10}:00.000Z [log] [ManagerDrivers] [inverter] [0] ${l}`).join('\r\n');
  const fromReport = capture.parseLog(wrapped);
  t.eq(fromReport.errors.length, 0, 'a timestamped, CRLF report parses cleanly');
  t.eq(JSON.stringify(fromReport.captures.summary), JSON.stringify(fixtures.get('summary')), 'summary round-trips byte-identically');

  // 4. a truncated report says so
  const partial = capture.parseLog(lines.slice(0, Math.max(1, lines.length - 2)).join('\n'));
  t.ok(partial.errors.length > 0, 'a truncated report is reported as incomplete');

  // 5. owner contact details and location stay out; id, name and serials stay in
  const privacy = [];
  capture.arm('privacy', { force: true });
  capture.record('/api/v3/systems', {
    systems: [{
      system_id: 68742,
      name: 'Garage',
      street: 'Somestreet 12',
      city: 'Sometown',
      zip: '1234AB',
      latitude: '49.29',
      longitude: '16.50',
      contact_name: 'A Person',
      contact_email: 'a@person.example',
      serial: '04C05B946371',
    }],
  }, (l) => privacy.push(l));
  const report = privacy.join('\n');
  for (const secret of ['Somestreet 12', 'Sometown', '1234AB', '49.29', '16.50', 'A Person', 'a@person.example']) {
    t.ok(!report.includes(secret), `'${secret}' was redacted out of the capture`);
  }
  for (const kept of ['68742', 'Garage', '04C05B946371']) t.ok(report.includes(kept), `'${kept}' is kept`);
};
