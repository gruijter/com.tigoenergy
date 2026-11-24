'use strict';

/*
Repair: a new login for a paired system.
*/

const fixtures = require('../fixtures');

module.exports = async (t) => {
  const { systems } = fixtures.get('systems');
  const system = systems[0];
  const makeDevice = (systemId) => {
    const device = {
      settings: { systemId: String(systemId), username: 'old', password: 'old' },
      store: {},
      restarted: 0,
      getStoreValue: (key) => device.store[key],
      setStoreValue: async (key, value) => {
        device.store[key] = value;
      },
      getName: () => 'Tigo test',
      getSettings: () => ({ ...device.settings }),
      setSettings: async (changes) => Object.assign(device.settings, changes),
      restartDevice: async () => {
        device.restarted += 1;
      },
    };
    return device;
  };

  fixtures.routeHttps();
  const driver = fixtures.makeDriver();
  const device = makeDevice(system.system_id);
  const session = fixtures.makeSession();
  await driver.onRepair(session, device);
  const result = await session.handlers.login({ username: 'new@example.invalid', password: 'newpass' });
  t.eq(result, true, 'a login that holds the system succeeds');
  t.eq(device.settings.username, 'new@example.invalid', 'the username is stored');
  t.eq(device.settings.password, 'newpass', 'the password is stored');
  t.eq(device.restarted, 1, 'the device restarts on the new login');
  t.eq(device.store.apiSource, 'v3', 'on the official API');

  fixtures.routeHttps({ '/api/v3/systems/query': { systems: [] } });
  const other = makeDevice(999999999);
  const otherSession = fixtures.makeSession();
  await driver.onRepair(otherSession, other);
  let error = null;
  try {
    await otherSession.handlers.login({ username: 'new@example.invalid', password: 'newpass' });
  } catch (e) {
    error = e;
  }
  t.eq(error && error.message, 'errors.systemNotOnAccount', 'a login without the system is refused');
  t.eq(other.settings.username, 'old', 'and changes nothing');
};
