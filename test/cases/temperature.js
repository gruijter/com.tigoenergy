'use strict';

/*
Panels on the official API take their temperature from the app's API, matched by panel label.
*/

const fixtures = require('../fixtures');

const TZ = 'Europe/Amsterdam';

module.exports = async (t) => {
  const { localIso } = fixtures.app('lib/tigoAggregate.js');
  const { panelsOf } = fixtures.app('lib/tigoReadings.js');
  const panels = panelsOf(fixtures.get('layout')).slice(0, 2);
  if (panels.length < 2) return t.skip('the layout fixture has fewer than 2 panels');
  const now = Date.now();
  const hhmm = localIso(new Date(now - 10 * 60 * 1000), TZ).slice(11, 16);
  // the app's API numbers the panels differently: only the labels match
  const renumber = (layout) => {
    for (const inverter of layout.system.inverters) {
      for (const mppt of inverter.mppts) {
        for (const string of mppt.strings) {
          for (const panel of string.panels) panel.object_id += 1000;
        }
      }
    }
    return layout;
  };
  const aggregate = (options) => {
    const query = new URLSearchParams(options.path.split('?')[1]);
    const ids = (query.get('object_ids') || '').split(',');
    return { status: 200, contentType: 'text/csv', body: `Datetime,${ids.join(',')}\n2026/11/24 10:01:00,${ids.map(() => 10).join(',')}\n` };
  };
  const temps = { dataset: [{ order: [panels[0].object_id + 1000], data: [{ t: hhmm, d: [31.5] }] }] };
  let calls = fixtures.routeHttps({
    '/api/v3/data/aggregate': aggregate,
    'mobile:/api/v3/systems/layout': renumber(fixtures.get('layout')),
    'mobile:/api/v4/system/summary/summary': temps,
  });
  const poller = fixtures.makePoller();
  const devices = panels.map((panel) => {
    const device = fixtures.makePanel({ objectId: panel.object_id, poller, timezone: TZ });
    device.settings.label = `${panel.label}`;
    poller.register(device);
    return device;
  });
  await poller.tick(now);
  t.eq(devices[0].values.measure_temperature_panel, 31.5, "official API: the temperature from the app's API, by label");
  t.eq(devices[1].values.measure_temperature_panel, null, 'a panel without a recent temperature: cleared');
  t.eq(devices[0].values.measure_watt_panel, 10, 'the power still from the official API');
  t.ok(calls.some((call) => call.path.includes('temp=temp')), "one temperature request per gateway on the app's API");

  // the app's API refuses the login: the rest goes on, the temperature tile stays, retried after an hour
  calls = fixtures.routeHttps({ '/api/v3/data/aggregate': aggregate, 'mobile:/api/v3/user/login': fixtures.errors.unauthorized });
  const refused = fixtures.makePoller();
  const device = fixtures.makePanel({ objectId: panels[0].object_id, poller: refused, timezone: TZ });
  device.settings.label = `${panels[0].label}`;
  refused.register(device);
  await refused.tick(now);
  t.eq(device.values.measure_temperature_panel, undefined, "a refused app's API leaves the temperature tile");
  t.eq(device.values.measure_watt_panel, 10, 'and the power comes');
  t.eq(device.available, true, 'the panel stays available');
  const logins = () => calls.filter((call) => call.path.startsWith('/api/v3/user/login')).length;
  const tried = logins();
  await refused.tick(now + 5 * 60 * 1000);
  t.eq(logins(), tried, 'not tried again within an hour');
  await refused.tick(now + 61 * 60 * 1000);
  t.eq(logins(), tried + 1, 'tried again after an hour');
  return undefined;
};
