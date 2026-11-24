'use strict';

/*
Pairing: login, then one device per system in the systems list.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const calls = fixtures.routeHttps();
  const driver = fixtures.makeDriver();
  const session = fixtures.makeSession();
  await driver.onPair(session);

  const info = await session.handlers.login({ username: 'user@example.invalid', password: 'secret' });
  t.eq(info, true, 'login succeeds');
  t.eq(await session.handlers.noPremium(), false, 'with EI Premium no subscription notice');
  t.ok(calls.every((call) => call.host !== 'mapi.tigoenergy.com'), "and no request to the Tigo app's API");
  t.ok(calls[0].headers.Authorization.startsWith('Basic '), 'login uses Basic auth');
  t.ok(calls[1].headers.Authorization.startsWith('Bearer '), 'the systems list uses the Bearer token');

  const devices = await session.handlers.list_devices();
  const { systems } = fixtures.get('systems');
  t.eq(devices.length, systems.length, 'one device per system');
  devices.forEach((device, i) => {
    const system = systems[i];
    t.eq(device.data.id, system.system_id, `device ${i} id is system_id`);
    t.ok(typeof device.name === 'string' && device.name.length > 0, `device ${i} has a name (got ${JSON.stringify(device.name)})`);
    t.eq(device.settings.systemId, String(system.system_id), `device ${i} systemId setting`);
    t.eq(JSON.stringify(device.capabilities), JSON.stringify(driver.manifest.capabilities), `device ${i} is paired with the manifest capabilities`);
    t.eq(device.store.apiSource, 'v3', `device ${i} uses the official API`);
  });

  // a new device starts with its final capabilities: no migration right after pairing
  const DeviceMigrator = fixtures.app('lib/DeviceMigrator.js');
  const caps = [...devices[0].capabilities];
  const changes = [];
  const paired = fixtures.makeDevice({ capabilities: caps });
  Object.assign(paired, {
    getCapabilities: () => [...caps],
    getAvailable: () => true,
    addCapability: async (cap) => changes.push(`+${cap}`),
    removeCapability: async (cap) => changes.push(`-${cap}`),
    homey: { __: (key) => key, setTimeout },
  });
  await DeviceMigrator.migrateCapabilities(paired, driver.manifest.capabilities);
  t.eq(changes.join(), '', 'the first start after pairing migrates nothing');

  // no systems on either API: a clear error
  fixtures.routeHttps({ '/api/v3/systems': { premium: true }, '/api/v3/systems/query': { systems: [] } });
  const empty = fixtures.makeSession();
  await driver.onPair(empty);
  await empty.handlers.login({ username: 'u', password: 'p' });
  let error = null;
  try {
    await empty.handlers.list_devices();
  } catch (e) {
    error = e;
  }
  t.eq(error && error.message, 'errors.noSystem', 'no systems list gives errors.noSystem');
};
