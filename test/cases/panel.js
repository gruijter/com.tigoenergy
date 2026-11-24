'use strict';

/*
The panel driver: pairing from systems/layout, the data/aggregate CSV, one poll per system for all
panels, and staying out of Homey Energy.
*/

const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures');

/** A CSV answer for the object_ids asked: id * factor per param, energy = id * 100 Wh. */
const FACTOR = {
  Pin: 10, Vin: 3, Iin: 0.01, RSSI: 1,
};
const aggregateFor = (options) => {
  const query = new URLSearchParams(options.path.split('?')[1]);
  const ids = (query.get('object_ids') || '').split(',').filter(Boolean);
  const day = query.get('level') === 'day';
  const factor = FACTOR[query.get('param')];
  const rows = day
    ? [`2026/11/24 00:00:00,${ids.map((id) => id * 100).join(',')}`]
    : [`2026/11/24 10:00:00,${ids.map(() => '').join(',')}`, `2026/11/24 10:01:00,${ids.map((id) => id * factor).join(',')}`];
  return { status: 200, contentType: 'text/csv', body: `Datetime,${ids.join(',')}\n${rows.join('\n')}\n` };
};

module.exports = async (t) => {
  const APP = path.join(__dirname, '..', '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'drivers/panel/driver.compose.json'), 'utf8'));

  // Homey Energy: own capabilities only, and excluded by default
  t.ok(!manifest.capabilities.some((cap) => /^(measure_power|meter_power)(\.|$)/.test(cap)), 'no measure_power/meter_power: panels stay out of Homey Energy');
  t.eq(manifest.energy && manifest.energy.excludedByDefault, true, 'energy.excludedByDefault is set, as in powerhour');
  for (const cap of manifest.capabilities) {
    const def = JSON.parse(fs.readFileSync(path.join(APP, '.homeycompose/capabilities', `${cap}.json`), 'utf8'));
    t.ok(def.icon && fs.existsSync(path.join(APP, def.icon)), `${cap} has an icon file`);
  }

  // CSV: repeated header, empty and '-' cells
  const { latestPerObject, localIso } = fixtures.app('lib/tigoAggregate.js');
  const doc = latestPerObject(fixtures.get('aggregateMin').csv);
  t.eq(doc.get('3').at, '2014/09/23 00:06:24', 'a column missing under a later header keeps its last row');
  t.eq(doc.get('1').at, '2014/09/23 00:06:28', 'a row belongs to the header above it');
  const gaps = latestPerObject('Datetime,1,2\n2026/11/24 10:00:00,5,7\n2026/11/24 10:01:00,-,\n');
  t.eq(gaps.get('1').value, 5, "'-' is no value");
  t.eq(gaps.get('2').value, 7, 'an empty cell is no value');
  t.eq(localIso(new Date('2026-11-24T23:30:00Z'), 'Europe/Amsterdam'), '2026-11-25T00:30:00', 'start/end are local time of the system');

  // pairing: one device per panel of the layout
  fixtures.routeHttps();
  const Driver = fixtures.app('drivers/panel/driver.js');
  const driver = Object.create(Driver.prototype);
  Object.assign(driver, {
    homey: { __: (key) => key }, manifest, log() {}, error() {},
  });
  const session = fixtures.makeSession();
  await driver.onPair(session);
  await session.handlers.login({ username: 'u', password: 'p' });
  const devices = await session.handlers.list_devices();
  const panels = Driver.panelsOf(fixtures.get('layout'));
  t.ok(panels.length > 0, `the layout has panels (${panels.length})`);
  t.eq(devices.length, panels.length * fixtures.get('systems').systems.length, 'one device per panel');
  t.eq(devices[0].data.id, panels[0].panel_id, 'data.id is panel_id');
  t.eq(devices[0].store.objectId, panels[0].object_id, 'store.objectId is the column id of data/aggregate');
  t.eq(devices[0].settings.label, String(panels[0].label), 'the panel label is a setting');
  t.ok(devices[0].settings.string, 'and its string');
  t.eq(JSON.stringify(devices[0].capabilities), JSON.stringify(manifest.capabilities), 'paired with the final capabilities');

  // one poll per system: 2 requests for all panels
  const calls = fixtures.routeHttps({ '/api/v3/data/aggregate': aggregateFor });
  const poller = fixtures.makePoller();
  const devs = [11, 12, 13].map((objectId) => fixtures.makePanel({ objectId, poller }));
  devs.forEach((device) => poller.register(device));
  const now = Date.now();
  await poller.tick(now);
  const asked = calls.filter((c) => c.path.startsWith('/api/v3/data/aggregate'));
  t.eq(asked.length, 5, 'one poll for 3 panels is 5 requests (Pin, Vin, Iin, RSSI, day)');
  t.eq(['Pin', 'Vin', 'Iin', 'RSSI', 'Pin'].join(), asked.map((c) => new URLSearchParams(c.path.split('?')[1]).get('param')).join(), 'the four minute params, then the day');
  t.ok(asked.every((c) => c.path.includes('object_ids=11%2C12%2C13')), 'asking for all panels at once');
  t.ok(asked.every((c) => c.path.includes('header=id')), 'with object ids as column header');
  t.eq(devs[1].values.measure_watt_panel, 120, 'power is the newest minute (W)');
  t.eq(devs[1].values.meter_kwh_panel_today, 1.2, "today's energy in kWh");
  t.eq(devs[1].values.measure_volt_panel, 36, 'voltage from Vin');
  t.eq(devs[1].values.measure_amp_panel, 0.12, 'current from Iin');
  t.eq(devs[1].values.measure_rssi_panel, 12, 'RSSI as reported');
  t.eq(devs[1].values.measure_efficiency_panel, 100, 'the median panel of its string is 100%');
  t.eq(devs[0].values.measure_efficiency_panel, 91.7, 'a lower one is below 100%');
  t.eq(devs[0].values.alarm_underperforming_panel, false, 'not underperforming on the first day');
  await poller.tick(now + 60 * 1000);
  t.eq(calls.filter((c) => c.path.startsWith('/api/v3/data/aggregate')).length, 5, 'no new poll within 5 min');
  await poller.tick(now + 5 * 60 * 1000);
  t.eq(calls.filter((c) => c.path.startsWith('/api/v3/data/aggregate')).length, 10, 'polled again after 5 min');
  const system = poller.systems.get('1');
  system.newDataAt = now - 31 * 60 * 1000;
  system.lastRequestAt = now - 10 * 60 * 1000;
  t.ok(!poller.constructor.due(system, now), 'after 30 min without new data: not every 5 min');
  system.lastRequestAt = now - 30 * 60 * 1000;
  t.ok(poller.constructor.due(system, now), 'but every 30 min');

  // underperforming: 3 days in a row under 85% of the string's median
  const PanelPoller = fixtures.app('lib/panelPoller.js');
  const judge = fixtures.makePoller();
  const trio = [1, 2, 3].map((objectId) => fixtures.makePanel({ objectId, poller: judge }));
  const day = (kwh) => new Map(trio.map((device, i) => [device, { todayKwh: kwh[i] }]));
  const sys = {};
  let readings;
  const days = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'];
  for (const date of days) {
    readings = day([1, 2, 2]);
    await PanelPoller.prototype.compare.call(judge, sys, trio, readings, date);
  }
  t.eq(readings.get(trio[0]).underperforming, true, 'half the median for 3 judged days sets underperforming');
  t.eq(readings.get(trio[1]).underperforming, false, 'the others not');
  readings = day([2, 2, 2]);
  await PanelPoller.prototype.compare.call(judge, sys, trio, readings, '2026-11-25');
  readings = day([2, 2, 2]);
  await PanelPoller.prototype.compare.call(judge, sys, trio, readings, '2026-11-26');
  t.eq(readings.get(trio[0]).underperforming, false, 'one normal day clears it');
  const dim = {};
  for (const date of days) {
    readings = day([0.01, 0.1, 0.1]);
    await PanelPoller.prototype.compare.call(judge, dim, trio, readings, date);
  }
  t.eq(readings.get(trio[0]).underperforming, false, 'dark days (median under 0.2 kWh) do not count');
  t.eq(readings.get(trio[0]).efficiencyPct, 10, 'efficiency is still shown above 0.05 kWh median');

  // a panel without data in the window: no current power
  fixtures.routeHttps({ '/api/v3/data/aggregate': () => ({ status: 200, contentType: 'text/csv', body: 'Datetime,11\n' }) });
  const quiet = fixtures.makePoller();
  const dark = fixtures.makePanel({ objectId: 11, poller: quiet });
  quiet.register(dark);
  await quiet.tick();
  t.eq(dark.values.measure_watt_panel, null, 'no minute in the window clears the power tile');
  t.eq(dark.values.meter_kwh_panel_today, undefined, "and leaves today's energy");

  // errors: 402 makes all panels unavailable, 429 keeps them
  fixtures.routeHttps({ '/api/v3/data/aggregate': fixtures.errors.premium });
  const paid = fixtures.makePoller();
  const locked = [1, 2].map((objectId) => fixtures.makePanel({ objectId, poller: paid }));
  locked.forEach((device) => paid.register(device));
  await paid.tick();
  t.ok(locked.every((device) => device.available === false), 'Premium required makes every panel unavailable');
  fixtures.routeHttps({ '/api/v3/data/aggregate': fixtures.errors.rateLimited });
  const busy = fixtures.makePoller();
  const held = fixtures.makePanel({ objectId: 1, poller: busy });
  busy.register(held);
  await busy.tick();
  t.eq(held.available, true, 'a 429 keeps the panel available');

  // device: Energy toggle does not re-register; other settings do
  const watcher = {
    registered: 0,
    register() {
      this.registered += 1;
    },
    unregister() {},
  };
  const panel = fixtures.makePanel({ objectId: 5, poller: watcher });
  await panel.onSettings({ changedKeys: ['energy_value_constant'] });
  t.eq(watcher.registered, 0, 'only the energy_* toggle changed: nothing happens');
  await panel.onSettings({ changedKeys: ['password'] });
  t.eq(watcher.registered, 1, 'a new password registers with the poller again');

  // capture: minutes and days are two captures, CSV wrapped in JSON
  const capture = fixtures.app('lib/tigoCapture.js');
  const lines = [];
  capture.arm('panels', { force: true });
  capture.record('/api/v3/data/aggregate?system_id=1&level=min', { csv: 'Datetime,1\n' }, (l) => lines.push(l));
  capture.record('/api/v3/data/aggregate?system_id=1&level=day', { csv: 'Datetime,1\n' }, (l) => lines.push(l));
  const { captures } = capture.parseLog(lines.join('\n'));
  t.ok(captures.aggregateMin && captures.aggregateDay, 'aggregateMin and aggregateDay are captured separately');
};
