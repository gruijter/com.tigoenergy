'use strict';

/*
The inverter device around the poll: connection alarm, idle cadence, rate limit, counters on uninit.
*/

const fixtures = require('../fixtures');

const tick = () => new Promise((resolve) => {
  setImmediate(resolve);
});

module.exports = async (t) => {
  const { summary } = fixtures.get('summary');
  const HOUR = 60 * 60 * 1000;

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
};
