'use strict';

/*
The Tigo app's API as fallback without EI Premium: client, readings, choice of API at pairing,
moving to and from it while polling.
*/

const fixtures = require('../fixtures');

const MAPI = 'mapi.tigoenergy.com';

const tick = () => new Promise((resolve) => {
  setImmediate(resolve);
});

// stub shapes (ids 3/4, 10:30 local); real mobile captures are checked in `real` below
/** Real captures of the app's API, when a diagnostics report brought them. */
async function real(t) {
  const { fromHomepage, panelPower } = fixtures.app('lib/tigoReadings.js');
  if (fixtures.isReal('mobileHomepage')) {
    const reading = fromHomepage(fixtures.get('mobileHomepage'));
    t.ok(reading && Number.isFinite(reading.powerW), `real homepage: power ${reading && reading.powerW} W`);
    t.ok(reading && Number.isFinite(reading.lifetimeKwh), `real homepage: lifetime ${reading && reading.lifetimeKwh} kWh`);
  }
  if (fixtures.isReal('mobilePanelPower')) {
    t.ok(panelPower(fixtures.get('mobilePanelPower')).power.size > 0, 'real panel summary: power per panel');
  }
}

async function stubs(t) {
  // client: login body and headers
  let calls = fixtures.routeHttps();
  const TigoMobileClient = fixtures.app('lib/TigoMobileClient.js');
  const client = new TigoMobileClient({ username: 'u@example.invalid', password: 'pw', homey: { __: (key) => key } });
  await client.login();
  await client.getSystems();
  t.eq(calls[0].host, MAPI, "the Tigo app's host");
  t.eq(calls[0].path, '/api/v3/user/login?type=8', 'login path with type=8');
  t.eq(calls[0].method, 'POST', 'login is a POST');
  t.eq(calls[0].body, JSON.stringify({ username: 'u@example.invalid', password: 'pw' }), 'with the credentials as JSON');
  t.eq(calls[0].headers.Authorization, undefined, 'and no Authorization header');
  t.eq(calls[1].headers.Authorization, 'Bearer MOBILE', 'then the token as Bearer');
  t.eq(calls[1].headers.Origin, 'capacitor://localhost', 'the Origin of the app');
  t.ok(calls[1].headers['X-App-Version'], 'and an app version');

  // a 401 logs in again once
  let rejected = 0;
  calls = fixtures.routeHttps({
    '/api/v4/equipments': () => {
      rejected += 1;
      return rejected === 1 ? fixtures.errors.unauthorized : fixtures.get('mobileEquipments');
    },
  });
  await client.getEquipments({ id: 1 });
  t.eq(calls.map((call) => call.path.split('?')[0]).join(), '/api/v4/equipments,/api/v3/user/login,/api/v4/equipments', 'a 401 logs in again and retries');

  // capture: own names, never the login
  const capture = fixtures.app('lib/tigoCapture.js');
  const lines = [];
  capture.arm('mobile', { force: true });
  capture.record('/api/v3/user/login?type=8', { user: { auth: 'x' } }, (l) => lines.push(l), 'mobile');
  capture.record('/api/v4/smart/systems/1/homepage', fixtures.get('mobileHomepage'), (l) => lines.push(l), 'mobile');
  capture.record('/api/v3/systems/layout?id=1', fixtures.get('layout'), (l) => lines.push(l), 'mobile');
  const { captures } = capture.parseLog(lines.join('\n'));
  t.eq(Object.keys(captures).sort().join(), 'mobileHomepage,mobileLayout', 'homepage and layout captured under mobile names, login not');

  // the login: once per account per arm, for zzz_docs/creds.txt via test/from-logs.js
  const logins = [];
  capture.arm('login', { force: true });
  const login = {
    username: 'u@example.invalid', password: 'pw', systemId: '1', systemName: 'Test System', apiSource: 'mobile',
  };
  capture.recordLogin(login, (l) => logins.push(l));
  capture.recordLogin(login, (l) => logins.push(l));
  capture.recordLogin({ ...login, username: 'other@example.invalid' }, (l) => logins.push(l));
  const parsed = capture.parseLog(logins.join('\n'));
  t.eq(parsed.credentials.length, 2, 'one login per account per arm');
  t.eq(parsed.credentials[0].password, 'pw', 'with the password');
  t.eq(Object.keys(parsed.captures).length, 0, 'and never as a test capture');

  // a refused request is captured with its status and body, also a refused login
  const failed = [];
  capture.arm('mobile errors', { force: true });
  fixtures.routeHttps({ 'mobile:/api/v3/user/login': fixtures.errors.unauthorized });
  const refused = new TigoMobileClient({
    username: 'u', password: 'p', homey: { __: (key) => key }, log: (l) => failed.push(l),
  });
  await refused.login().catch(() => {});
  const errors = capture.parseLog(failed.join('\n')).captures;
  t.eq(errors.mobileLoginError && errors.mobileLoginError.status, 401, 'a refused login: mobileLoginError with its status');

  // readings: units
  const { quantity, fromHomepage, panelPower } = fixtures.app('lib/tigoReadings.js');
  t.eq(quantity({ value: 2.4, unit: 'kW' }, 'W'), 2400, '{ value, unit } in kW');
  t.eq(quantity('1.5 kWh', 'Wh'), 1500, "'1.5 kWh'");
  t.eq(quantity(0, 'W'), 0, 'a real 0 stays 0');
  t.eq(quantity(null, 'W'), undefined, 'null is no value');
  t.eq(quantity('-', 'W'), undefined, "'-' is no value");
  const home = fromHomepage(fixtures.get('mobileHomepage'));
  t.eq(home.powerW, 2400, 'homepage now in W');
  t.eq(home.todayKwh, 12.5, 'homepage day (Wh) in kWh');
  t.eq(home.lifetimeKwh, 24500.125, 'homepage lifetime (Wh) in kWh');
  t.eq(fromHomepage({}), null, 'a homepage without energyProduction is no reading');
  const { power } = panelPower(fixtures.get('mobilePanelPower'));
  t.eq(power.get('3').value, 95, 'panel power: newest value per column');
  t.eq(power.get('4').t, '10:15', "skipping '-'");

  // pairing: no system on the official API -> the app's API, with the notice
  calls = fixtures.routeHttps({ '/api/v3/systems': { systems: [] } });
  const driver = fixtures.makeDriver();
  const session = fixtures.makeSession();
  await driver.onPair(session);
  await session.handlers.login({ username: 'u', password: 'p' });
  t.eq(await session.handlers.noPremium(), true, 'the subscription notice is shown');
  const [paired] = await session.handlers.list_devices();
  t.eq(paired.store.apiSource, 'mobile', "paired on the Tigo app's API");
  t.eq(paired.settings.systemId, String(fixtures.get('mobileSystems').systems[0].id), 'systemId is the app id');
  t.ok(paired.capabilities.includes('active_faults'), 'with active_faults (equipment states)');
  t.eq(JSON.stringify(paired.capabilities), JSON.stringify(driver.capabilityList('mobile')), 'paired with its final capabilities');

  // wrong password on both: the official API's error
  fixtures.routeHttps({ '/api/v3/users/login': fixtures.errors.unauthorized, 'mobile:/api/v3/user/login': fixtures.errors.unauthorized });
  const wrong = fixtures.makeSession();
  await driver.onPair(wrong);
  let error = null;
  try {
    await wrong.handlers.login({ username: 'u', password: 'bad' });
  } catch (e) {
    error = e;
  }
  t.eq(error && error.statusCode, 401, 'a wrong login on both gives the 401');

  // device on the app's API: homepage only, every 5 min
  calls = fixtures.routeHttps();
  const device = fixtures.makeDevice();
  device.source = 'mobile';
  device.premiumCheckedAt = Date.now();
  device.api = new TigoMobileClient({ username: 'u', password: 'p', homey: device.homey });
  await device.doPoll();
  await tick();
  t.ok(calls.every((call) => call.host === MAPI), "polls only the Tigo app's API");
  t.eq(device.values.measure_power, 2400, 'measure_power from the homepage');
  t.eq(device.values['meter_power.today'], 12.5, 'meter_power.today from the homepage');
  t.eq(device.values.meter_power, 24500.125, 'meter_power from the homepage');
  const now = Date.now();
  device.lastRequestAt = now - 60 * 1000;
  t.ok(!device.pollDue(now), 'not every minute');
  device.lastRequestAt = now - 5 * 60 * 1000;
  t.ok(device.pollDue(now), 'but every 5 min');
  device.updatedSeenAt = now - 31 * 60 * 1000;
  t.ok(!device.pollDue(now), 'idle: not every 5 min');
  device.lastRequestAt = now - 30 * 60 * 1000;
  t.ok(device.pollDue(now), 'idle: every 30 min');

  // official API says 402 -> the device moves to the app's API
  fixtures.routeHttps({ '/api/v3/data/summary': fixtures.errors.premium });
  const lapsed = fixtures.makeDevice();
  lapsed.api = fixtures.makeClient();
  await lapsed.doPoll();
  t.eq(lapsed.store.apiSource, 'mobile', "a 402 moves it to the Tigo app's API");
  t.eq(lapsed.restarts, 1, 'and restarts it there');
  t.ok(lapsed.available !== false, 'without going unavailable');

  // on the app's API, once a day: back to the official API when it lists the system again
  calls = fixtures.routeHttps();
  const back = fixtures.makeDevice({ settings: { systemId: String(fixtures.get('systems').systems[0].system_id) } });
  back.source = 'mobile';
  back.api = new TigoMobileClient({ username: 'u', password: 'p', homey: back.homey });
  await back.doPoll();
  t.eq(back.store.apiSource, 'v3', 'EI Premium again: back to the official API');
  t.eq(back.restarts, 1, 'with a restart');
  t.ok(calls.every((call) => call.host !== MAPI), 'checked with the official API only');
  calls = fixtures.routeHttps({ '/api/v3/systems': { systems: [] } });
  const stay = fixtures.makeDevice();
  stay.source = 'mobile';
  stay.api = new TigoMobileClient({ username: 'u', password: 'p', homey: stay.homey });
  await stay.doPoll();
  await tick();
  t.eq(stay.restarts, 0, 'still without EI Premium: it stays');
  t.eq(stay.values.measure_power, 2400, 'and polls as usual');
  const checks = calls.filter((call) => call.path === '/api/v3/systems').length;
  stay.lastRequestAt = 0;
  await stay.doPoll();
  t.eq(calls.filter((call) => call.path === '/api/v3/systems').length, checks, 'the official API is not asked again within a day');

  // panels on the app's API: one equipment list, power and the other fields per gateway, energy per day
  const series = (options) => {
    const temp = new URLSearchParams(options.path.split('?')[1]).get('temp');
    if (temp === 'temp') return { status: 403, body: { message: 'Forbidden' } };
    if (temp === 'vin') return { dataset: [{ order: [3, 4], data: [{ t: '10:30', d: [36.5, '-'] }] }] };
    return fixtures.get('mobilePanelPower');
  };
  calls = fixtures.routeHttps({ 'mobile:/api/v4/system/summary/summary': series });
  const poller = fixtures.makePoller();
  const panels = [3, 4].map((objectId) => fixtures.makePanel({ objectId, poller }));
  panels.forEach((panel) => {
    panel.store.apiSource = 'mobile';
    poller.register(panel);
  });
  poller.systems.get('1').premiumCheckedAt = Date.now();
  // the stub's last power is at 10:30 local
  const at = new Date('2026-08-28T10:40:00-07:00').getTime();
  panels.forEach((panel) => {
    panel.store.timezone = 'America/Los_Angeles';
  });
  await poller.tick(at);
  t.ok(calls.every((call) => call.host === MAPI), "panels poll only the Tigo app's API");
  const summaries = calls.filter((call) => call.path.startsWith('/api/v4/system/summary/summary'));
  t.eq(summaries.filter((call) => call.path.includes('temp=pin')).length, 1, 'one power request per gateway');
  t.eq(summaries.map((call) => new URLSearchParams(call.path.split('?')[1]).get('temp')).sort().join(), 'iin,pin,rssi,temp,vin', 'and one per other field');
  t.ok(calls.some((call) => call.path.includes('uid=CCA-1')), 'with the gateway serial');
  t.eq(panels[0].values.measure_watt_panel, 95, 'panel power (W)');
  t.eq(panels[1].values.measure_watt_panel, 110, 'the newest value of each panel');
  t.eq(panels[0].values.meter_kwh_panel_today, 1.2, "today's energy (Wh) in kWh");
  t.eq(panels[0].values.measure_volt_panel, 36.5, 'voltage from vin');
  t.eq(panels[1].values.measure_volt_panel, null, 'a panel without a voltage in the last hour: cleared');
  t.eq(panels[0].values.measure_temperature_panel, undefined, 'a refused field leaves its tile as it is');
  t.eq(panels[0].values.measure_watt_panel, 95, 'and the power still comes');
  await poller.tick(at + 5 * 60 * 1000);
  t.eq(calls.filter((call) => call.path.startsWith('/api/v4/equipments')).length, 1, 'the equipment list is asked once');
  await poller.tick(at + 3 * 60 * 60 * 1000);
  t.eq(panels[0].values.measure_watt_panel, null, 'a value older than an hour clears the power tile');

  // panels: 402 on the official API moves the whole system
  fixtures.routeHttps({ '/api/v3/data/aggregate': fixtures.errors.premium });
  const lapsedPoller = fixtures.makePoller();
  const moved = [1, 2].map((objectId) => fixtures.makePanel({ objectId, poller: lapsedPoller }));
  moved.forEach((panel) => {
    panel.useSource = async (source, id) => {
      panel.store.apiSource = source;
      panel.store.apiSystemId = id;
    };
    lapsedPoller.register(panel);
  });
  await lapsedPoller.tick();
  t.ok(moved.every((panel) => panel.store.apiSource === 'mobile'), "a 402 moves every panel to the Tigo app's API");
  t.ok(moved.every((panel) => panel.available === true), 'and keeps them available');
  t.eq(lapsedPoller.systems.get('1').source, 'mobile', 'the poller uses it from then on');
}

module.exports = async (t) => {
  const { site } = fixtures;
  fixtures.useSite(null);
  try {
    await stubs(t);
  } finally {
    fixtures.useSite(site);
  }
  await real(t);
};
