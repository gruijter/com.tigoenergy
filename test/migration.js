'use strict';

const assert = require('assert');
const DeviceMigrator = require('../lib/DeviceMigrator');
const manifest = require('../drivers/inverter/driver.compose.json');

const fakeDevice = (caps) => {
  const calls = [];
  return {
    calls,
    homey: { __: (key) => key, setTimeout },
    log() {},
    error() {},
    getName: () => 'test',
    getCapabilities: () => [...caps],
    hasCapability: (cap) => caps.includes(cap),
    getCapabilityValue: () => null,
    setCapabilityValue: async () => {},
    getAvailable: () => true,
    setAvailable: async () => {},
    setUnavailable: async () => {},
    addCapability: async (cap) => {
      calls.push(`+${cap}`); caps.push(cap);
    },
    removeCapability: async (cap) => {
      calls.push(`-${cap}`); caps.splice(caps.indexOf(cap), 1);
    },
  };
};

(async () => {
  // paired before: brought to the manifest order
  const old = fakeDevice(['meter_power', 'measure_power']);
  assert.strictEqual(await DeviceMigrator.migrateCapabilities(old, manifest.capabilities, { settleMs: 0 }), true);
  assert.deepStrictEqual(old.getCapabilities(), manifest.capabilities);

  // paired with 1.0.2: the new ones in their place, the tiles after them re-added in order
  const recent = fakeDevice(['meter_power', 'measure_power', 'meter_power.today', 'alarm_problem', 'alarm_connectivity']);
  assert.strictEqual(await DeviceMigrator.migrateCapabilities(recent, manifest.capabilities, { settleMs: 0 }), true);
  assert.deepStrictEqual(recent.getCapabilities(), manifest.capabilities);

  // on the app's API with 1.0.2 (no alarm_problem then)
  const app = fakeDevice(['meter_power', 'measure_power', 'meter_power.today', 'alarm_connectivity']);
  assert.strictEqual(await DeviceMigrator.migrateCapabilities(app, manifest.capabilities, { settleMs: 0 }), true);
  assert.deepStrictEqual(app.getCapabilities(), manifest.capabilities);

  // newly paired (driver.js passes the manifest list): no migration
  const fresh = fakeDevice([...manifest.capabilities]);
  assert.strictEqual(await DeviceMigrator.migrateCapabilities(fresh, manifest.capabilities, { settleMs: 0 }), false);
  assert.deepStrictEqual(fresh.calls, []);
  console.log('migration: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
