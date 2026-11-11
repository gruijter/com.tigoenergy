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
  // paired before: the new capabilities are appended, nothing is removed
  const old = fakeDevice(['meter_power', 'measure_power']);
  assert.strictEqual(await DeviceMigrator.migrateCapabilities(old, manifest.capabilities, { settleMs: 0 }), true);
  assert.deepStrictEqual(old.calls, ['+meter_power.today', '+alarm_problem', '+alarm_connectivity']);

  // paired with 1.0.x: only alarm_connectivity is appended
  const recent = fakeDevice(['meter_power', 'measure_power', 'meter_power.today', 'alarm_problem']);
  assert.strictEqual(await DeviceMigrator.migrateCapabilities(recent, manifest.capabilities, { settleMs: 0 }), true);
  assert.deepStrictEqual(recent.calls, ['+alarm_connectivity']);

  // newly paired (driver.js passes the manifest list): no migration
  const fresh = fakeDevice([...manifest.capabilities]);
  assert.strictEqual(await DeviceMigrator.migrateCapabilities(fresh, manifest.capabilities, { settleMs: 0 }), false);
  assert.deepStrictEqual(fresh.calls, []);
  console.log('migration: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
