'use strict';

/*
The inverter device around the poll: connection alarm, idle cadence, rate limit, counters on uninit.
*/

const fixtures = require('../fixtures');

const tick = () => new Promise((resolve) => {
  setImmediate(resolve);
});

module.exports = async (t) => {
  const HOUR = 60 * 60 * 1000;
  const summary = { ...fixtures.get('summary').summary, updated_on: new Date().toISOString() };

  // connection alarm after 24 h without a new updated_on; power cleared, device stays available
  const device = fixtures.makeDevice();
  await device.handleDeviceData({ summary: { ...summary, last_power_dc: 1500 } });
  await tick();
  t.eq(device.values.alarm_connectivity, false, 'new data: alarm_connectivity false');
  t.eq(device.values.measure_power, 1500, 'and the power is shown');
  device.updatedSeenAt = Date.now() - 25 * HOUR;
  await device.handleDeviceData({ summary: { ...summary, last_power_dc: 1500 } });
  await tick();
  t.eq(device.values.alarm_connectivity, true, 'no new data for over 24 h: alarm_connectivity true');
  t.eq(device.values.measure_power, null, 'and a day-old power reading is cleared');
  t.eq(device.available, true, 'the device stays available');
  await device.handleDeviceData({ summary: { ...summary, updated_on: 'newer', last_power_dc: 800 } });
  await tick();
  t.eq(device.values.alarm_connectivity, false, 'new data clears the alarm');
  t.eq(device.values.measure_power, 800, 'and shows the power again');
  const restarted = fixtures.makeDevice();
  await restarted.handleDeviceData({ summary: { ...summary, updated_on: new Date(Date.now() - 25 * HOUR).toISOString() } });
  await tick();
  t.eq(restarted.values.alarm_connectivity, true, 'after an app start, a day-old updated_on sets the alarm at once');

  // idle cadence
  const now = Date.now();
  const idle = fixtures.makeDevice();
  t.ok(idle.pollDue(now), 'before any data: poll');
  idle.updatedSeenAt = now - 10 * 60 * 1000;
  idle.lastRequestAt = now - 60 * 1000;
  t.ok(idle.pollDue(now), 'new data within 30 min: poll every minute');
  idle.updatedSeenAt = now - 31 * 60 * 1000;
  t.ok(!idle.pollDue(now), 'no new data for 30 min: skip a poll one minute after the last');
  idle.lastRequestAt = now - 10 * 60 * 1000;
  t.ok(idle.pollDue(now), 'and poll again 10 min after the last request');

  // a rate-limit cooldown keeps the device available
  fixtures.routeHttps({ '/api/v3/data/summary': fixtures.errors.rateLimited });
  const limited = fixtures.makeDevice();
  limited.api = fixtures.makeClient();
  limited.available = true;
  await limited.doPoll();
  t.eq(limited.available, true, 'a 429 leaves the device available');
  fixtures.routeHttps({ '/api/v3/data/summary': fixtures.errors.premium, 'mobile:/api/v3/user/login': fixtures.errors.unauthorized });
  const failing = fixtures.makeDevice();
  failing.api = fixtures.makeClient();
  await failing.doPoll();
  t.eq(failing.available, false, "a 402 without the Tigo app's API makes it unavailable");
  t.eq(failing.unavailableReason && failing.unavailableReason.message, 'Payment Required', 'with the API message');
  t.eq(failing.restarts, 0, 'and it stays on the official API');

  // onUninit stores the held-back lifetime reading
  fixtures.routeHttps();
  const counting = fixtures.makeDevice();
  counting.unregisterListeners = () => {};
  await counting.handleDeviceData({ summary: { ...summary, lifetime_energy_dc: 5000000 } });
  await tick();
  await counting.handleDeviceData({ summary: { ...summary, lifetime_energy_dc: 5001000, updated_on: 'later' } });
  await tick();
  t.eq(counting.store.meter_powerLast, 5000, 'within 15 min the newer reading is not stored yet');
  await counting.onUninit();
  t.eq(counting.store.meter_powerLast, 5001, 'onUninit stores it');

  // panels online: panels with a recent power value, every 5 min
  const { panelsOf } = fixtures.app('lib/tigoReadings.js');
  const ids = panelsOf(fixtures.get('layout')).map((panel) => panel.object_id);
  let calls = fixtures.routeHttps({
    '/api/v3/data/aggregate': () => ({ status: 200, contentType: 'text/csv', body: `Datetime,${ids.join(',')}\n2026/11/24 10:01:00,${ids.map((id, i) => (i === 0 ? 10 : '')).join(',')}\n` }),
  });
  const online = fixtures.makeDevice();
  online.api = fixtures.makeClient();
  online.timeZone = 'Europe/Amsterdam';
  online.panels = { checkedAt: 0, cache: {} };
  await online.updatePanelsOnline(now);
  t.eq(online.values.panels_online, ids.length ? 1 : 0, 'official API: the panels with a power minute in the last 30 min');
  t.ok(calls.some((call) => call.path.startsWith('/api/v3/data/aggregate') && call.path.includes('param=Pin')), 'from one Pin aggregate');
  const asked = calls.length;
  await online.updatePanelsOnline(now + 60 * 1000);
  t.eq(calls.length, asked, 'not asked again within 5 min');
  await online.updatePanelsOnline(now + 5 * 60 * 1000);
  t.eq(calls.filter((call) => call.path.startsWith('/api/v3/systems/layout')).length, 1, 'the layout is asked once');

  const { site } = fixtures;
  fixtures.useSite(null);
  try {
    calls = fixtures.routeHttps();
    const TigoMobileClient = fixtures.app('lib/TigoMobileClient.js');
    const mobile = fixtures.makeDevice();
    mobile.source = 'mobile';
    mobile.api = new TigoMobileClient({ username: 'u', password: 'p', homey: mobile.homey });
    mobile.timeZone = 'America/Los_Angeles';
    mobile.panels = { checkedAt: 0, cache: {} };
    // the stub's last values are at 10:15 and 10:30 local
    await mobile.updatePanelsOnline(new Date('2026-08-28T10:40:00-07:00').getTime());
    t.eq(mobile.values.panels_online, 2, "app's API: the panels with a power value in the last hour");
    mobile.panels.checkedAt = 0;
    await mobile.updatePanelsOnline(new Date('2026-08-28T12:00:00-07:00').getTime());
    t.eq(mobile.values.panels_online, 0, 'none in the last hour: 0');
  } finally {
    fixtures.useSite(site);
  }
};
