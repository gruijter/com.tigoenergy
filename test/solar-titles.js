'use strict';

const assert = require('assert');
const { solarTitle } = require('../lib/solarTitles');
const manifest = require('../drivers/inverter/driver.compose.json');

// Manifest titles cannot require solarTitles.js; the device sets the same ones on paired devices.
for (const cap of ['measure_power', 'meter_power']) {
  assert.deepStrictEqual(manifest.capabilitiesOptions[cap].title, solarTitle(cap, 'dc'), `${cap} title`);
}
console.log('solar titles: ok');
