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
  t.ok(info && Array.isArray(info.systems), 'login returns the systems list');
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
  });

  // no systems: a clear error
  fixtures.routeHttps({ '/api/v3/systems': { premium: true } });
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
