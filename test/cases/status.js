'use strict';

/*
Year and month energy, alerts and active faults, the Cloud Connect check-in.
*/

const fixtures = require('../fixtures');

const tick = () => new Promise((resolve) => {
  setImmediate(resolve);
});

module.exports = async (t) => {
  const readings = fixtures.app('lib/tigoReadings.js');
  const { totalPerObject, localIso, shiftDay } = fixtures.app('lib/tigoAggregate.js');

  // parsers
  const { summary } = fixtures.get('summary');
  t.eq(readings.fromSummary({ summary }).yearKwh, Number(summary.ytd_energy_dc) / 1000, 'year from ytd_energy_dc in kWh');
  const home = readings.fromHomepage(fixtures.get('mobileHomepage'));
  t.ok(Number.isFinite(home.monthKwh) && Number.isFinite(home.yearKwh), "the app's homepage gives month and year");
  t.eq(totalPerObject(fixtures.get('combined').csv).get('1'), 3000, 'data/combined: the days summed per object');
  t.eq(readings.systemObjectId(fixtures.get('objects')), String(fixtures.get('objects').objects.find((o) => o.object_type_id === 1).id), 'the System object of objects/system');
  const sources = readings.fromSources(fixtures.get('sources'));
  t.ok(Number.isFinite(sources.checkinAt) && sources.timeZone, 'sources/system: check-in and time zone');
  const two = {
    alerts: [
      { added: '2026-11-01T10:00:00+01:00', title: 'Tigo Alert: Old' },
      { added: '2026-11-20T10:00:00+01:00', title: 'Tigo Alert: String Shutdown' },
    ],
  };
  t.eq(readings.alertTitles(two, 1), 'String Shutdown', 'the newest of recent_alerts_count alerts, without the prefix');
  t.eq(readings.alertTitles(two, 0), null, 'no recent alert: null');
  const zones = { alerts: [{ added: '2026-11-01T01:30:00-08:00', title: 'Late' }, { added: '2026-11-01T01:45:00-07:00', title: 'Early' }] };
  t.eq(readings.alertTitles(zones, 1), 'Late', 'alerts are sorted by time, not by text');
  t.eq(readings.equipmentFaults(fixtures.get('mobileEquipmentStatus'), fixtures.get('mobileEventTypes')), 'No communication', 'a recovered warning is not active, an error is, with its title');

  // official API: alerts, active faults, check-in
  const { systems } = fixtures.get('systems');
  const system = systems[0];
  fixtures.routeHttps({ '/api/v3/systems': { systems: [{ ...system, recent_alerts_count: 1 }] } });
  const device = fixtures.makeDevice({ settings: { systemId: String(system.system_id) } });
  device.api = fixtures.makeClient();
  device.statusCheckedAt = 0;
  await device.updateStatus();
  t.eq(device.values.alarm_problem, true, 'recent alerts: alarm_problem');
  t.ok(typeof device.values.active_faults === 'string' && !device.values.active_faults.startsWith('Tigo Alert'), 'and their titles in active_faults');
  t.eq(device.checkinAt, sources.checkinAt, 'the check-in is read');
  fixtures.routeHttps({ '/api/v3/sources/system': fixtures.errors.rateLimited });
  device.statusCheckedAt = 0;
  await device.updateStatus().catch(() => {});
  t.eq(device.checkinAt, undefined, 'a failing sources/system forgets the old check-in');
  device.api.rateLimitedUntil = 0;
  fixtures.routeHttps({ '/api/v3/systems': { systems: [{ ...system, recent_alerts_count: 0 }] } });
  device.statusCheckedAt = 0;
  await device.updateStatus();
  t.eq(device.values.active_faults, null, 'no recent alert clears active_faults');

  const fresh = { ...summary, updated_on: new Date().toISOString() };
  const link = fixtures.makeDevice();
  link.checkinAt = Date.now() - 3 * 60 * 60 * 1000;
  await link.handleDeviceData({ summary: fresh });
  await tick();
  t.eq(link.values.alarm_connectivity, true, 'no check-in for 3 h: alarm_connectivity, even with fresh data');
  link.checkinAt = Date.now() - 10 * 60 * 1000;
  await link.handleDeviceData({ summary: fresh });
  await tick();
  t.eq(link.values.alarm_connectivity, false, 'a recent check-in clears it');

  // official API: month from data/combined, once a day
  const calls = fixtures.routeHttps({
    '/api/v3/data/combined': (options) => {
      const id = new URLSearchParams(options.path.split('?')[1]).get('object_ids');
      return { csv: `DATETIME,${id}\n2017/01/01 00:00:00.000,1000\n2017/01/02 00:00:00.000,2000\n` };
    },
  });
  const monthly = fixtures.makeDevice();
  monthly.api = fixtures.makeClient();
  monthly.api.bearerToken = 'token';
  monthly.timeZone = 'Europe/Amsterdam';
  monthly.month = null;
  monthly.monthRetryAt = 0;
  const today = localIso(new Date(), monthly.timeZone).slice(0, 10);
  const todayKwh = 5;
  await monthly.handleDeviceData({ summary: { ...summary, daily_energy_dc: todayKwh * 1000, updated_on: `${today}T12:00:00+01:00` } });
  await tick();
  const asked = calls.filter((c) => c.path.startsWith('/api/v3/data/combined'));
  const ranges = asked.map((c) => new URLSearchParams(c.path.split('?')[1]));
  const daysOf = (q) => (Date.parse(q.get('end').slice(0, 10)) - Date.parse(q.get('start').slice(0, 10))) / 86400000 + 1;
  t.ok(ranges.every((q) => daysOf(q) <= 14), 'at most 14 days per data/combined request');
  t.ok(ranges.length === 0 || ranges[0].get('start').startsWith(`${today.slice(0, 8)}01`), 'from the first of the month');
  t.ok(ranges.every((q) => q.get('end').slice(0, 10) <= shiftDay(today, -1)), 'up to yesterday');
  t.eq(monthly.values['meter_power.month'], asked.length * 3 + todayKwh, 'month: the finished days plus today');
  await monthly.handleDeviceData({ summary: { ...summary, daily_energy_dc: 6000, updated_on: `${today}T12:05:00+01:00` } });
  await tick();
  t.eq(calls.filter((c) => c.path.startsWith('/api/v3/data/combined')).length, asked.length, 'the finished days are asked once a day');
  t.eq(monthly.values['meter_power.month'], asked.length * 3 + 6, 'today follows the summary');
  await monthly.handleDeviceData({ summary: { ...summary, daily_energy_dc: 9000, updated_on: `${shiftDay(today, -1)}T23:00:00+01:00` } });
  await tick();
  t.eq(monthly.values['meter_power.month'], asked.length * 3, 'a summary of yesterday adds nothing for today');
  t.eq(monthly.values['meter_power.year'], Number(summary.ytd_energy_dc) / 1000, 'year from the summary');

  // the app's API: active faults from the equipment states
  fixtures.routeHttps();
  const app = fixtures.makeDevice();
  app.source = 'mobile';
  app.api = new (fixtures.app('lib/TigoMobileClient.js'))({ username: 'u', password: 'p', homey: { __: (key) => key } });
  app.api.bearerToken = 'token';
  app.statusCheckedAt = 0;
  app.eventTypes = null;
  fixtures.routeHttps({ 'mobile:/api/v4/equipment-event-types': () => ({ status: 500, body: { message: 'Server error' } }) });
  await app.updateStatus();
  t.eq(app.eventTypes, null, 'failed event types are not kept');
  t.eq(app.values.active_faults, 'noCommunication', 'and the status type is shown');
  fixtures.routeHttps();
  app.statusCheckedAt = 0;
  await app.updateStatus();
  t.eq(app.values.alarm_problem, true, "the app's API: a fault sets alarm_problem");
  t.eq(app.values.active_faults, 'No communication', 'and its title');
};
