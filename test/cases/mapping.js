'use strict';

/*
data/summary -> capabilities, as the inverter device polls it. Expectations come from the fixture.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const { summary } = fixtures.get('summary');
  t.ok(summary, 'the summary fixture has a summary object');
  for (const field of ['last_power_dc', 'daily_energy_dc', 'lifetime_energy_dc', 'updated_on']) {
    t.ok(field in summary, `summary has ${field} - the device reads it`);
  }

  const device = fixtures.makeDevice();
  await device.handleDeviceData({ summary: { ...summary, updated_on: new Date().toISOString() } });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  t.eq(device.values.measure_power, Number(summary.last_power_dc), 'measure_power is last_power_dc (W)');
  t.eq(device.values['meter_power.today'], Number(summary.daily_energy_dc) / 1000, 'meter_power.today is daily_energy_dc in kWh');
  const lifetime = Number(summary.lifetime_energy_dc) / 1000;
  if (lifetime > 0) t.eq(device.values.meter_power, Math.round(lifetime * 1000) / 1000, 'meter_power is lifetime_energy_dc in kWh');
  else t.eq(device.values.meter_power, undefined, 'a zero lifetime total is not published');
  t.eq(device.available, true, 'a valid summary makes the device available');

  // a missing summary is an error, not a row of zeros
  const empty = fixtures.makeDevice();
  let threw = null;
  try {
    await empty.handleDeviceData({});
  } catch (error) {
    threw = error;
  }
  t.eq(threw && threw.message, 'errors.noData', 'a response without summary throws errors.noData');
  t.eq(Object.keys(empty.values).length, 0, 'and sets no capability');

  // the lifetime counter never goes down
  const falling = fixtures.makeDevice();
  await falling.handleDeviceData({ summary: { ...summary, lifetime_energy_dc: 2000000 } });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  await falling.handleDeviceData({ summary: { ...summary, lifetime_energy_dc: 1000000, updated_on: 'later' } });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  t.eq(falling.values.meter_power, 2000, 'one lower lifetime reading is held');

  // alarm_problem from the systems list
  const { systems } = fixtures.get('systems');
  const system = systems[0];
  if (!system || typeof system.recent_alerts_count !== 'number') return t.skip('systems fixture has no recent_alerts_count');
  fixtures.routeHttps({ '/api/v3/systems': { systems: [{ ...system, recent_alerts_count: 2 }] } });
  const alerting = fixtures.makeDevice({ settings: { systemId: String(system.system_id) } });
  alerting.api = fixtures.makeClient();
  await alerting.updateAlerts();
  t.eq(alerting.values.alarm_problem, true, 'recent_alerts_count > 0 sets alarm_problem');
  return undefined;
};
